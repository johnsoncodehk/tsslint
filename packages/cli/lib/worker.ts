import ts = require('typescript-native-bridge');
import type config = require('@tsslint/config');
import core = require('@tsslint/core');
import url = require('url');
import path = require('path');
import fs = require('fs');
import crypto = require('crypto');
import cacheFlow = require('./cache-flow.js');
import incrementalState = require('./incremental-state.js');
import type { FileCache } from './cache.js';
import type { IncrementalState } from './incremental-state.js';

// @tsslint/core typings are declared against stock `typescript`; the two
// modules are nominally distinct types. TNB is a drop-in with the same API
// surface.
const tsStock = ts as unknown as typeof import('typescript');

// Fallback if `ts.sys.createHash` is undefined on this host (Node ≥ 22.6
// always provides it via crypto, but the type is optional). sha256 hex.
const defaultHash = (s: string) => crypto.createHash('sha256').update(s).digest('hex');

let projectVersion = 0;
let typeRootsVersion = 0;
let options: ts.CompilerOptions = {};
let fileNames: string[] = [];
let linter: core.Linter;
// Layer 2 state. We wrap the LS program in a SemanticDiagnostics-
// BuilderProgram (with the prev session's BP fed back via TS's internal
// `tsBuildInfoText` round-trip) and walk affected files once. cache-
// flow consults this set to decide whether type-aware rules can be
// cache-hit. Always populated under the CLI; `--force` opts out by
// clearing the loaded cache, not by disabling layer 2.
let affectedFiles: Set<string> | undefined;
// The current session's BP — held until end-of-project so we can
// capture its updated buildinfo text for next session's persistence.
let currentBuilder: ts.SemanticDiagnosticsBuilderProgram | undefined;

const snapshots = new Map<string, ts.IScriptSnapshot>();
const versions = new Map<string, number>();
const languageServiceHost: ts.LanguageServiceHost = {
	...ts.sys,
	useCaseSensitiveFileNames() {
		return ts.sys.useCaseSensitiveFileNames;
	},
	getProjectVersion() {
		return projectVersion.toString();
	},
	getTypeRootsVersion() {
		return typeRootsVersion;
	},
	getCompilationSettings() {
		return options;
	},
	getScriptFileNames() {
		return fileNames;
	},
	getScriptVersion(fileName) {
		// In-session bumps win — `--fix` updates this map after writing
		// the file. Otherwise fall back to the on-disk mtime so the
		// version reflects content across CLI invocations. Layer 2's
		// BuilderProgram diff relies on this — without it, every cross-
		// session file looks unchanged (always '0') even when the
		// content moved on disk.
		const inSession = versions.get(fileName);
		if (inSession !== undefined) return inSession.toString();
		const stat = fs.statSync(fileName, { throwIfNoEntry: false });
		return stat ? stat.mtimeMs.toString() : '0';
	},
	getScriptSnapshot(fileName) {
		if (!snapshots.has(fileName)) {
			snapshots.set(fileName, ts.ScriptSnapshot.fromString(ts.sys.readFile(fileName)!));
		}
		return snapshots.get(fileName);
	},
	getScriptKind(fileName) {
		switch (path.extname(fileName).toLowerCase()) {
			case '.js':
			case '.mjs':
			case '.cjs':
				return ts.ScriptKind.JS;
			case '.jsx':
				return ts.ScriptKind.JSX;
			case '.tsx':
				return ts.ScriptKind.TSX;
			case '.json':
				return ts.ScriptKind.JSON;
		}
		return ts.ScriptKind.TS;
	},
	getDefaultLibFileName(options) {
		return ts.getDefaultLibFilePath(options);
	},
};
const languageService = ts.createLanguageService(languageServiceHost);

// Linter is single-threaded by design. The previous version split into a
// worker_threads worker for TTY mode (so the spinner could update during a
// file's lint) and a local fallback for non-TTY. Real numbers showed worker
// IPC overhead (JSON.stringify + JSON.parse + structured-clone of diagnostic
// payloads + Worker spawn / teardown) wasn't earning its keep — and a single
// `text` field on a 3 MB checker.ts duplicated across hundreds of diagnostics
// blew JSON.stringify past V8's max string length, crashing the worker.
// Keep a single in-process API; the spinner just updates between files.
export function create() {
	return {
		setup(...args: Parameters<typeof setup>) {
			return setup(...args);
		},
		lint(...args: Parameters<typeof lint>) {
			return lint(...args);
		},
		hasCodeFixes(...args: Parameters<typeof hasCodeFixes>) {
			return hasCodeFixes(...args);
		},
		hasRules(...args: Parameters<typeof hasRules>) {
			return hasRules(...args);
		},
		getTypeAwareRules() {
			return [...linter.getTypeAwareRules()];
		},
		buildIncrementalState() {
			return buildIncrementalState();
		},
	};
}

async function setup(
	configFile: string,
	_fileNames: string[],
	_options: ts.CompilerOptions,
	initialTypeAwareRules: readonly string[],
	prevIncrementalState: IncrementalState | undefined,
): Promise<true | string> {
	let config: config.Config | config.Config[];
	try {
		config = (await import(url.pathToFileURL(configFile).toString())).default;
	}
	catch (err) {
		if (err instanceof Error) {
			return err.stack ?? err.message;
		}
		return String(err);
	}

	// Reset per-project state. Multi-project runs reuse the same worker
	// (in-process) — without this, cross-project file paths accumulate in
	// `snapshots` / `versions` (memory leak) and `affectedFiles` from a
	// prior project would mis-classify this project's files as cache-hit
	// candidates if their absolute paths happened to overlap.
	snapshots.clear();
	versions.clear();
	affectedFiles = undefined;
	currentBuilder = undefined;

	projectVersion++;
	typeRootsVersion++;
	fileNames = _fileNames;
	// Internal API path: BuilderProgram.emitBuildInfo only produces
	// content when these options are set. Override the user's values
	// (their own tsc --incremental builds shouldn't share this file).
	// The synthetic path is never written to disk — captured via
	// writeFile callback at end of session.
	options = {
		..._options,
		incremental: true,
		tsBuildInfoFile: incrementalState.SYNTHETIC_BUILD_INFO_PATH,
	};
	linter = core.createLinter(
		{
			languageService,
			languageServiceHost,
			typescript: tsStock,
		},
		path.dirname(configFile),
		config,
		() => [],
		initialTypeAwareRules,
	);

	{
		const program = languageService.getProgram()!;
		// Reconstruct the prev session's BP from cached buildinfo text,
		// fall through to undefined on any failure (cold-start path).
		const oldBuilder = incrementalState.reconstructOldBuilder(tsStock, prevIncrementalState, {
			useCaseSensitiveFileNames: () => ts.sys.useCaseSensitiveFileNames,
			getCurrentDirectory: () => ts.sys.getCurrentDirectory(),
		});
		currentBuilder = ts.createSemanticDiagnosticsBuilderProgram(
			program,
			{ createHash: ts.sys.createHash ?? defaultHash },
			oldBuilder as ts.SemanticDiagnosticsBuilderProgram | undefined,
		);
		affectedFiles = new Set();
		// Drain via `ignoreSourceFile` to record affected files without
		// computing their semantic diagnostics. The diagnostic compute is
		// the expensive part of the drain (~38s on Dify cold) — TSSLint's
		// own lint pass triggers semantic checks lazily for the symbols
		// type-aware rules query, not the full program. Doing it twice
		// wasted time. The graph-propagation work (which determines
		// affected via reference graph) still runs internally.
		// `ignoreSourceFile`'s typed param is SourceFile only, but TS
		// internally calls it with the same `affected` value the iterator
		// returns — which can also be a Program (whole-program affected
		// path, e.g. lib flip). Handle both shapes at runtime via the
		// `fileName` discriminator.
		const recordAffected = (sf: ts.SourceFile) => {
			const a = sf as ts.SourceFile | ts.Program;
			if ('fileName' in a) {
				affectedFiles!.add(a.fileName);
			}
			else {
				for (const f of a.getSourceFiles()) affectedFiles!.add(f.fileName);
			}
			return true;
		};
		while (true) {
			const result = currentBuilder.getSemanticDiagnosticsOfNextAffectedFile(
				undefined,
				recordAffected,
			);
			if (!result) break;
			// Should not reach here — `ignoreSourceFile` always returns true.
		}
	}

	return true;
}

// Capture the current session's BP state for persistence. Called by
// the CLI at end of project. Returns undefined when not in incremental
// mode or when capture fails.
function buildIncrementalState(): IncrementalState | undefined {
	if (!currentBuilder) return undefined;
	return incrementalState.captureIncrementalState(ts.version, currentBuilder);
}

function lint(fileName: string, fix: boolean, fileCache: FileCache, fileMtime: number) {
	let newSnapshot: ts.IScriptSnapshot | undefined;
	let diagnostics!: ts.DiagnosticWithLocation[];
	let shouldCheck = true;

	// Layer 2 signals. `incremental` is always true under the CLI now —
	// `--force` opts out by clearing the loaded cache instead.
	//   typeAwareUnaffected: file's deps haven't moved since prev session,
	//                so cached type-aware entries can be reused this run.
	//                False in --fix mode — fixes mutate files mid-session
	//                and invalidate the setup-time affected snapshot for
	//                downstream files; we'd rather re-run than serve stale.
	const typeAwareUnaffected = !fix && !affectedFiles!.has(fileName);

	if (fix) {
		// Drop cache entries for rules that registered a fix in any prior
		// session — we need to actually run those rules now to rebuild the
		// `getEdits` callbacks (closures don't survive the JSON cache).
		// Rules with no fixes can stay cached.
		for (const ruleId of Object.keys(fileCache.rules)) {
			if (fileCache.rules[ruleId].hasFix) {
				delete fileCache.rules[ruleId];
			}
		}
		// Iterate to a fixed point so chained autofixes complete in one
		// CLI run. Example: `var x = 1` (never reassigned) needs no-var
		// to rewrite to `let x = 1` before prefer-const can fire and
		// rewrite to `const x = 1` — without iteration, the user has to
		// run `--fix` repeatedly. ESLint caps at 10 passes; match that.
		const MAX_FIX_PASSES = 10;
		let pass = 0;
		let converged = false;
		for (; pass < MAX_FIX_PASSES; pass++) {
			const program = languageService.getProgram()!;
			diagnostics = cacheFlow.lintWithCache(linter, fileName, fileCache, fileMtime, program, {
				incremental: true,
				typeAwareUnaffected,
			});

			const fixes = linter
				.getCodeFixes(fileName, 0, Number.MAX_VALUE, diagnostics)
				.filter(fix => fix.fixId === 'tsslint');

			const textChanges = core.combineCodeFixes(fileName, fixes);
			if (!textChanges.length) {
				converged = true;
				break;
			}

			const oldSnapshot = snapshots.get(fileName)!;
			newSnapshot = core.applyTextChanges(oldSnapshot, textChanges);
			snapshots.set(fileName, newSnapshot);
			versions.set(fileName, (versions.get(fileName) ?? 0) + 1);
			projectVersion++;

			// Wipe rule cache so the next pass re-lints the new snapshot.
			// (cacheFlow keys on mtime, but disk hasn't been written yet —
			// the post-loop block does the single converged write.)
			fileCache.rules = {};
		}
		if (!converged) {
			// Hit MAX_FIX_PASSES without the fix loop settling — likely two
			// rules' fixes conflict (each pass undoes the other) or a single
			// rule oscillates. Surface it; staying silent leaves the user
			// thinking --fix succeeded when partial fixes remain. Mirrors
			// ESLint's "Maximum autofix passes exceeded" warning.
			console.warn(
				`[tsslint] --fix did not converge on ${fileName} after ${MAX_FIX_PASSES} passes; remaining fixable diagnostics may indicate a rule conflict.`,
			);
		}
		shouldCheck = false;
	}

	if (newSnapshot) {
		const newText = newSnapshot.getText(0, newSnapshot.getLength());
		const oldText = ts.sys.readFile(fileName);
		if (newText !== oldText) {
			ts.sys.writeFile(fileName, newSnapshot.getText(0, newSnapshot.getLength()));
			// File content moved — refresh mtime so the next lint pass
			// invalidates layer-1 cache entries for this file. lintWithCache
			// compares fileCache.mtime against the fileMtime we pass in.
			fileMtime = fs.statSync(fileName).mtimeMs;
			shouldCheck = true;
		}
	}

	if (shouldCheck) {
		const program = languageService.getProgram()!;
		diagnostics = cacheFlow.lintWithCache(linter, fileName, fileCache, fileMtime, program, {
			incremental: true,
			typeAwareUnaffected,
		});
	}

	// Diagnostics are already in the original file's coordinates — the
	// program's real `ts.SourceFile`, which shares its `lineMap` cache
	// across all diagnostics on the same file (so `formatDiagnosticsWith-
	// ColorAndContext` only computes line starts once per file).
	return diagnostics;
}

function hasCodeFixes(fileName: string) {
	return linter.hasCodeFixes(fileName);
}

function hasRules(fileName: string) {
	return Object.keys(linter.getRules(fileName)).length > 0;
}
