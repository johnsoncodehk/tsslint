import ts = require('typescript');
import type config = require('@tsslint/config');
import core = require('@tsslint/core');
import url = require('url');
import fs = require('fs');
import path = require('path');
import languagePlugins = require('./languagePlugins.js');

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
			return lint(...args)[0];
		},
		hasCodeFixes(...args: Parameters<typeof hasCodeFixes>) {
			return hasCodeFixes(...args);
		},
		hasRules(...args: Parameters<typeof hasRules>) {
			return hasRules(...args)[0];
		},
	};
}

async function setup(
	tsconfig: string,
	languages: string[],
	configFile: string,
	_fileNames: string[],
	_options: ts.CompilerOptions,
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
	);

	return true;
}

function lint(fileName: string, fix: boolean, fileCache: core.FileLintCache) {
	let newSnapshot: ts.IScriptSnapshot | undefined;
	let diagnostics!: ts.DiagnosticWithLocation[];
	let shouldCheck = true;

	if (fix) {
		if (Object.values(fileCache[1]).some(([hasFix]) => hasFix)) {
			// Reset the cache if there are any fixes applied.
			fileCache[1] = {};
			fileCache[2] = {};
		}
		diagnostics = linter.lint(fileName, fileCache);
		shouldCheck = false;

		let fixes = linter
			.getCodeFixes(fileName, 0, Number.MAX_VALUE, diagnostics, fileCache[2])
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
			fileCache[0] = fs.statSync(fileName).mtimeMs;
			fileCache[1] = {};
			fileCache[2] = {};
			shouldCheck = true;
		}
	}

	if (shouldCheck) {
		diagnostics = linter.lint(fileName, fileCache);
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

	return [diagnostics, fileCache] as const;
}

function getFileText(fileName: string) {
	return originalHost.getScriptSnapshot(fileName)!.getText(0, Number.MAX_VALUE);
}

function hasCodeFixes(fileName: string) {
	return linter.hasCodeFixes(fileName);
}

function hasRules(fileName: string, minimatchCache: core.FileLintCache[2]) {
	return [Object.keys(linter.getRules(fileName, minimatchCache)).length > 0, minimatchCache] as const;
}
