import ts = require('typescript');
import type config = require('@tsslint/config');
import core = require('@tsslint/core');
import url = require('url');
import path = require('path');
import fs = require('fs');
import crypto = require('crypto');
import languagePlugins = require('./languagePlugins.js');
import cacheFlow = require('./cache-flow.js');
import incrementalState = require('./incremental-state.js');
import type { FileCache } from './cache.js';
import type { IncrementalState } from './incremental-state.js';

// Fallback if `ts.sys.createHash` is undefined on this host (Node ≥ 22.6
// always provides it via crypto, but the type is optional). sha256 hex.
const defaultHash = (s: string) => crypto.createHash('sha256').update(s).digest('hex');

import { isCodeActionsEnabled, type Language } from '@volar/language-core';
import { proxyCreateProgram } from '@volar/typescript';
import { transformDiagnostic, transformFileTextChanges } from '@volar/typescript/lib/node/transform';

let options: ts.CompilerOptions = {};
let fileNames: string[] = [];
let language: Language<string> | undefined;
let linter: core.Linter;
// Cached Program instance + dirty flag. Pre-3.2 the worker wrapped a
// LanguageService over a LanguageServiceHost; getProgram() implicitly
// rebuilt when the host's projectVersion bumped. We've collapsed that
// down to direct `ts.createProgram` calls — the LS provided no
// linter-relevant capability beyond program-rebuild-on-version-bump,
// and it pulled in completion / refactor / navigation machinery we
// never used. `--fix` rewrites a file → bumps `programDirty` → next
// `ensureProgram()` rebuilds with `oldProgram` for incremental binder
// reuse (TS reuses unchanged SourceFiles' bound state, only re-binds
// the modified file).
let currentProgram: ts.Program | undefined;
let programDirty = true;
// In-session content overrides for `--fix`-modified files. The
// CompilerHost's readFile / getSourceFile consult this map first so
// the next program rebuild sees the post-fix text without disk I/O.
const fileTextOverrides = new Map<string, string>();
// Volar Language instance for Vue / MDX / Astro projects. Set by
// `proxyCreateProgram`'s `setup` callback when a language plugin is
// active; undefined for plain-TS projects.
// `proxyCreateProgram` returns the wrapped `ts.createProgram`. For
// plain-TS this stays as `ts.createProgram` itself.
let createProgram: typeof ts.createProgram = ts.createProgram;
// Layer 2 state. We wrap the program in a SemanticDiagnostics-
// BuilderProgram (with the prev session's BP fed back via TS's internal
// `tsBuildInfoText` round-trip) and walk affected files once. cache-
// flow consults this set to decide whether type-aware rules can be
// cache-hit. Always populated under the CLI; `--force` opts out by
// clearing the loaded cache, not by disabling layer 2.
let affectedFiles: Set<string> | undefined;
// The current session's BP — held until end-of-project so we can
// capture its updated buildinfo text for next session's persistence.
let currentBuilder: ts.SemanticDiagnosticsBuilderProgram | undefined;

// CompilerHost: lower-level than LanguageServiceHost. Just
// readFile / writeFile / fileExists / lib-file resolution / case
// sensitivity. We override `readFile` (and `getSourceFile`, which
// internally reads via readFile) to consult `fileTextOverrides`.
let compilerHost: ts.CompilerHost = createCompilerHost();

function createCompilerHost(): ts.CompilerHost {
	// `setParentNodes: true` — compat-eslint's bottom-up materialise
	// walks ts.Node.parent chains; without parent pointers it crashes.
	// `ts.createLanguageService` set this implicitly; `ts.createProgram`
	// via `createCompilerHost` defaults false, so we set it explicitly.
	const host = ts.createCompilerHost(options, true);
	const originalReadFile = host.readFile.bind(host);
	const originalGetSourceFile = host.getSourceFile.bind(host);
	const hash = ts.sys.createHash ?? defaultHash;
	host.readFile = (fileName: string) => {
		const override = fileTextOverrides.get(fileName);
		if (override !== undefined) return override;
		return originalReadFile(fileName);
	};
	host.getSourceFile = (fileName, languageVersion, onError, shouldCreate) => {
		const sf = originalGetSourceFile(fileName, languageVersion, onError, shouldCreate);
		// BuilderProgram requires `SourceFile.version` (Debug.checkDefined
		// throws otherwise). The LS-host path got this via the host's
		// `getScriptVersion`; raw CompilerHost has no equivalent, so we
		// stamp a content hash here. Same value across runs as long as
		// content matches → BuilderProgram's reference-graph diff
		// correctly identifies unchanged files.
		if (sf && (sf as unknown as { version?: string }).version === undefined) {
			(sf as unknown as { version: string }).version = hash(sf.text);
		}
		return sf;
	};
	return host;
}

function ensureProgram(): ts.Program {
	if (programDirty || !currentProgram) {
		// `oldProgram` lets `ts.createProgram` reuse SourceFiles whose
		// text hasn't changed (text-equality check vs old SF) and skip
		// re-parsing + re-binding for those. Modified files (via
		// `fileTextOverrides`) get re-parsed; unchanged files are zero-
		// cost.
		currentProgram = createProgram({
			rootNames: fileNames,
			options,
			host: compilerHost,
			oldProgram: currentProgram,
		});
		programDirty = false;
	}
	return currentProgram;
}

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
	tsconfig: string,
	languages: string[],
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
	// `fileTextOverrides` (memory leak) and `affectedFiles` from a prior
	// project would mis-classify this project's files as cache-hit
	// candidates if their absolute paths happened to overlap.
	fileTextOverrides.clear();
	currentProgram = undefined;
	programDirty = true;
	language = undefined;
	createProgram = ts.createProgram;
	affectedFiles = undefined;
	currentBuilder = undefined;

	const plugins = await languagePlugins.load(tsconfig, languages);
	fileNames = _fileNames;
	// Internal API path: BuilderProgram.emitBuildInfo only produces
	// content when these options are set. Override the user's values
	// (their own tsc --incremental builds shouldn't share this file).
	// The synthetic path is never written to disk — captured via
	// writeFile callback at end of session.
	options = {
		...(plugins.some(plugin => plugin.typescript?.extraFileExtensions.length)
			? { ..._options, allowNonTsExtensions: true }
			: _options),
		incremental: true,
		tsBuildInfoFile: incrementalState.SYNTHETIC_BUILD_INFO_PATH,
	};
	// Compile a fresh CompilerHost each setup — `options` may have
	// changed, and createCompilerHost bakes them in (default lib paths,
	// case sensitivity).
	compilerHost = createCompilerHost();
	if (plugins.length) {
		// Volar wraps `ts.createProgram` so Vue / MDX / Astro virtual
		// scripts get spliced into the program. The `setup` callback
		// gives us the Volar Language handle for diagnostic / fix
		// transforms downstream.
		createProgram = proxyCreateProgram(ts, ts.createProgram, () => ({
			languagePlugins: plugins,
			setup(lang) {
				language = lang;
			},
		}));
	}
	linter = core.createLinter(
		{
			typescript: ts,
			// Thunk: each `lint()` call gets the latest Program. `--fix`
			// rewrites a file mid-session → flips `programDirty` → next
			// `ensureProgram()` rebuilds with `oldProgram` for incremental
			// binder reuse.
			program: ensureProgram,
		},
		path.dirname(configFile),
		config,
		() => [],
		initialTypeAwareRules,
	);

	{
		const program = ensureProgram();
		// Reconstruct the prev session's BP from cached buildinfo text,
		// fall through to undefined on any failure (cold-start path).
		const oldBuilder = incrementalState.reconstructOldBuilder(ts, prevIncrementalState, {
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
	let newText: string | undefined;
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
		diagnostics = cacheFlow.lintWithCache(linter, fileName, fileCache, fileMtime, ensureProgram(), {
			incremental: true,
			typeAwareUnaffected,
		});
		shouldCheck = false;

		let fixes = linter
			.getCodeFixes(fileName, 0, Number.MAX_VALUE, diagnostics)
			.filter(fix => fix.fixId === 'tsslint');

		if (language) {
			fixes = fixes.map(fix => {
				fix.changes = transformFileTextChanges(language!, fix.changes, false, isCodeActionsEnabled);
				return fix;
			});
		}

		const textChanges = core.combineCodeFixes(fileName, fixes);
		if (textChanges.length) {
			// Apply edits to the current text (override map first, fall
			// through to disk). Stash result in `fileTextOverrides` so the
			// next `ensureProgram()` rebuild sees the post-fix content.
			const baseText = fileTextOverrides.get(fileName) ?? ts.sys.readFile(fileName) ?? '';
			newText = core.applyTextChanges(baseText, textChanges);
			fileTextOverrides.set(fileName, newText);
			programDirty = true;
		}
	}

	if (newText !== undefined) {
		const oldText = ts.sys.readFile(fileName);
		if (newText !== oldText) {
			ts.sys.writeFile(fileName, newText);
			// File content moved — refresh mtime so the next lint pass
			// invalidates layer-1 cache entries for this file. lintWithCache
			// compares fileCache.mtime against the fileMtime we pass in.
			fileMtime = fs.statSync(fileName).mtimeMs;
			shouldCheck = true;
		}
	}

	if (shouldCheck) {
		diagnostics = cacheFlow.lintWithCache(linter, fileName, fileCache, fileMtime, ensureProgram(), {
			incremental: true,
			typeAwareUnaffected,
		});
	}

	// Language-transform path (Vue/MDX/etc.): diagnostics map back from
	// the transformed file to the original source. The original file
	// might not be in the program, so we substitute a SourceFile-shaped
	// POJO with the real source text — `formatDiagnosticsWithColorAndContext`
	// reads `.file.text` to render code snippets.
	if (language) {
		diagnostics = diagnostics
			.map(d => transformDiagnostic(language!, d, ensureProgram(), false))
			.filter(d => !!d);
		const fileShim = new Map<string, { fileName: string; text: string }>();
		const getShim = (fn: string) => {
			let s = fileShim.get(fn);
			if (!s) {
				s = { fileName: fn, text: getFileText(fn) };
				fileShim.set(fn, s);
			}
			return s;
		};
		diagnostics = diagnostics.map<ts.DiagnosticWithLocation>(d => ({
			...d,
			file: getShim(d.file.fileName) as any,
			relatedInformation: d.relatedInformation?.map(info => ({
				...info,
				file: info.file ? getShim(info.file.fileName) as any : undefined,
			})),
		}));
	}
	// Plain-TS path: leave diagnostics as-is. `.file` is the program's real
	// `ts.SourceFile` which already shares `lineMap` cache across all
	// diagnostics on the same file (so `formatDiagnosticsWithColorAndContext`
	// only computes line starts once per file).

	return diagnostics;
}

function getFileText(fileName: string) {
	return fileTextOverrides.get(fileName) ?? ts.sys.readFile(fileName) ?? '';
}

function hasCodeFixes(fileName: string) {
	return linter.hasCodeFixes(fileName);
}

function hasRules(fileName: string) {
	return Object.keys(linter.getRules(fileName)).length > 0;
}
