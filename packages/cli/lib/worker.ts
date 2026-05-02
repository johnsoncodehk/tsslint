import ts = require('typescript');
import type config = require('@tsslint/config');
import core = require('@tsslint/core');
import url = require('url');
import path = require('path');
import fs = require('fs');
import languagePlugins = require('./languagePlugins.js');
import cacheFlow = require('./cache-flow.js');
import type { FileCache } from './cache.js';

import { createLanguage, FileMap, isCodeActionsEnabled, type Language } from '@volar/language-core';
import { createProxyLanguageService, decorateLanguageServiceHost, resolveFileLanguageId } from '@volar/typescript';
import { transformDiagnostic, transformFileTextChanges } from '@volar/typescript/lib/node/transform';

let projectVersion = 0;
let typeRootsVersion = 0;
let options: ts.CompilerOptions = {};
let fileNames: string[] = [];
let language: Language<string> | undefined;
let linter: core.Linter;
let linterLanguageService!: ts.LanguageService;
// Layer 2 state. When `--incremental` is on, we wrap the LS's program in
// a SemanticDiagnosticsBuilderProgram and walk affected files once at
// setup. cache-flow consults this set to decide whether type-aware rules
// can be cache-hit. `undefined` here = layer 1 only (cache-flow's default
// safe behavior — type-aware rules always re-run).
//
// Without cross-session BP state (tsbuildinfo), the first session sees
// every file as affected on cold start; the wiring lands here so the
// state-persistence work can plug in without touching cache-flow.
let affectedFiles: Set<string> | undefined;

const snapshots = new Map<string, ts.IScriptSnapshot>();
const versions = new Map<string, number>();
const originalHost: ts.LanguageServiceHost = {
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
		return versions.get(fileName)?.toString() ?? '0';
	},
	getScriptSnapshot(fileName) {
		if (!snapshots.has(fileName)) {
			snapshots.set(fileName, ts.ScriptSnapshot.fromString(ts.sys.readFile(fileName)!));
		}
		return snapshots.get(fileName);
	},
	getScriptKind(fileName) {
		const languageId = resolveFileLanguageId(fileName);
		switch (languageId) {
			case 'javascript':
				return ts.ScriptKind.JS;
			case 'javascriptreact':
				return ts.ScriptKind.JSX;
			case 'typescript':
				return ts.ScriptKind.TS;
			case 'typescriptreact':
				return ts.ScriptKind.TSX;
			case 'json':
				return ts.ScriptKind.JSON;
		}
		return ts.ScriptKind.Unknown;
	},
	getDefaultLibFileName(options) {
		return ts.getDefaultLibFilePath(options);
	},
};
const linterHost: ts.LanguageServiceHost = { ...originalHost };
const originalService = ts.createLanguageService(linterHost);

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
	};
}

async function setup(
	tsconfig: string,
	languages: string[],
	configFile: string,
	_fileNames: string[],
	_options: ts.CompilerOptions,
	initialTypeAwareRules: readonly string[],
	incremental: boolean,
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

	for (let key in linterHost) {
		if (!(key in originalHost)) {
			// @ts-ignore
			delete linterHost[key];
		}
		else {
			// @ts-ignore
			linterHost[key] = originalHost[key];
		}
	}
	linterLanguageService = originalService;
	language = undefined;

	const plugins = await languagePlugins.load(tsconfig, languages);
	if (plugins.length) {
		const { getScriptSnapshot } = originalHost;
		language = createLanguage<string>(
			[
				...plugins,
				{ getLanguageId: fileName => resolveFileLanguageId(fileName) },
			],
			new FileMap(ts.sys.useCaseSensitiveFileNames),
			fileName => {
				const snapshot = getScriptSnapshot(fileName);
				if (snapshot) {
					language!.scripts.set(fileName, snapshot);
				}
			},
		);
		decorateLanguageServiceHost(ts, language, linterHost);

		const proxy = createProxyLanguageService(linterLanguageService);
		proxy.initialize(language);
		linterLanguageService = proxy.proxy;
	}

	projectVersion++;
	typeRootsVersion++;
	fileNames = _fileNames;
	options = plugins.some(plugin => plugin.typescript?.extraFileExtensions.length)
		? {
			..._options,
			allowNonTsExtensions: true,
		}
		: _options;
	linter = core.createLinter(
		{
			languageService: linterLanguageService,
			languageServiceHost: linterHost,
			typescript: ts,
		},
		path.dirname(configFile),
		config,
		() => [],
		initialTypeAwareRules,
	);

	affectedFiles = incremental ? computeAffectedFiles() : undefined;

	return true;
}

// Wrap LS's program in a SemanticDiagnosticsBuilderProgram and drain the
// affected-file iterator. Without an `oldProgram` (cross-session state
// not yet persisted), every file counts as affected on cold runs — so
// the returned set is large but correctness is preserved. cache-flow
// consults `!affectedFiles.has(fileName)` for `typeAwareUnaffected`.
function computeAffectedFiles(): Set<string> {
	const program = linterLanguageService.getProgram()!;
	const builder = ts.createSemanticDiagnosticsBuilderProgram(
		program,
		{ createHash: ts.sys.createHash },
	);
	const set = new Set<string>();
	while (true) {
		const result = builder.getSemanticDiagnosticsOfNextAffectedFile();
		if (!result) break;
		const a = result.affected;
		if ('fileName' in a) {
			set.add(a.fileName);
		}
		else {
			// Whole-program affected — config option flip, lib change, etc.
			// Conservatively mark every source file affected.
			for (const sf of a.getSourceFiles()) set.add(sf.fileName);
		}
	}
	return set;
}

function lint(fileName: string, fix: boolean, fileCache: FileCache, fileMtime: number) {
	let newSnapshot: ts.IScriptSnapshot | undefined;
	let diagnostics!: ts.DiagnosticWithLocation[];
	let shouldCheck = true;

	// Layer 2 signal: file is unaffected if --incremental is on AND the
	// BuilderProgram pass at setup didn't list this file. In `--fix` mode
	// we conservatively force `false` — fixes mutate files mid-session,
	// invalidating the setup-time affected snapshot for downstream files.
	const typeAwareUnaffected = !!affectedFiles && !fix && !affectedFiles.has(fileName);

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
		const program = linterLanguageService.getProgram()!;
		diagnostics = cacheFlow.lintWithCache(linter, fileName, fileCache, fileMtime, program, {
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
			const oldSnapshot = snapshots.get(fileName)!;
			newSnapshot = core.applyTextChanges(oldSnapshot, textChanges);
			snapshots.set(fileName, newSnapshot);
			versions.set(fileName, (versions.get(fileName) ?? 0) + 1);
			projectVersion++;
		}
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
		const program = linterLanguageService.getProgram()!;
		diagnostics = cacheFlow.lintWithCache(linter, fileName, fileCache, fileMtime, program, {
			typeAwareUnaffected,
		});
	}

	// Language-transform path (Vue/MDX/etc.): diagnostics map back from
	// the transformed file to the original source. The original file
	// might not be in the language service's program, so we substitute a
	// SourceFile-shaped POJO with the real source text — `formatDiagnostics-
	// WithColorAndContext` reads `.file.text` to render code snippets.
	if (language) {
		diagnostics = diagnostics
			.map(d => transformDiagnostic(language!, d, (originalService as any).getCurrentProgram(), false))
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
	return originalHost.getScriptSnapshot(fileName)!.getText(0, Number.MAX_VALUE);
}

function hasCodeFixes(fileName: string) {
	return linter.hasCodeFixes(fileName);
}

function hasRules(fileName: string) {
	return Object.keys(linter.getRules(fileName)).length > 0;
}
