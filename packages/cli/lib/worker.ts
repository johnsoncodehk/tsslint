import ts = require('typescript');
import type config = require('@tsslint/config');
import core = require('@tsslint/core');
import url = require('url');
import fs = require('fs');
import path = require('path');
import worker_threads = require('worker_threads');
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

export function createLocal() {
	return {
		setup(...args: Parameters<typeof setup>) {
			return setup(...args);
		},
		lint(...args: Parameters<typeof lint>) {
			return reattach(lint(...args)[0]);
		},
		hasCodeFixes(...args: Parameters<typeof hasCodeFixes>) {
			return hasCodeFixes(...args);
		},
		hasRules(...args: Parameters<typeof hasRules>) {
			return hasRules(...args)[0];
		},
	};
}

export function create() {
	const worker = new worker_threads.Worker(__filename);
	return {
		setup(...args: Parameters<typeof setup>) {
			return sendRequest(setup, ...args);
		},
		async lint(...[fileName, fix, cache]: Parameters<typeof lint>) {
			const [res, newCache] = await sendRequest(lint, fileName, fix, cache);
			Object.assign(cache, newCache); // Sync the cache
			return reattach(res as { diagnostics: ts.DiagnosticWithLocation[]; texts: Record<string, string> });
		},
		hasCodeFixes(...args: Parameters<typeof hasCodeFixes>) {
			return sendRequest(hasCodeFixes, ...args);
		},
		async hasRules(...[fileName, cache]: Parameters<typeof hasRules>) {
			const [res, newCache] = await sendRequest(hasRules, fileName, cache);
			Object.assign(cache, newCache); // Sync the cache
			return res;
		},
	};

	function sendRequest<T extends (...args: any) => void>(t: T, ...args: any[]) {
		return new Promise<Awaited<ReturnType<T>>>((resolve, reject) => {
			const onMessage = (json: string) => {
				cleanup();
				const parsed = JSON.parse(json);
				if (parsed && parsed.__error) {
					reject(new Error(parsed.__error));
				}
				else {
					resolve(parsed);
				}
			};
			const onError = (err: Error) => {
				cleanup();
				reject(err);
			};
			const onExit = (code: number) => {
				cleanup();
				reject(new Error(`Worker exited with code ${code}`));
			};
			const cleanup = () => {
				worker.off('message', onMessage);
				worker.off('error', onError);
				worker.off('messageerror', onError);
				worker.off('exit', onExit);
			};
			worker.once('message', onMessage);
			worker.once('error', onError);
			worker.once('messageerror', onError);
			worker.once('exit', onExit);
			worker.postMessage(JSON.stringify([t.name, ...args]));
		});
	}
}

worker_threads.parentPort?.on('message', async json => {
	let response: string;
	try {
		const data: [cmd: keyof typeof handlers, ...args: any[]] = JSON.parse(json);
		const handler = handlers[data[0]] as ((...args: any[]) => unknown) | undefined;
		if (!handler) {
			throw new Error(`Unknown worker command: ${data[0]}`);
		}
		const result = await handler(...data.slice(1));
		response = JSON.stringify(result);
	}
	catch (err) {
		response = JSON.stringify({
			__error: err instanceof Error ? (err.stack ?? err.message) : String(err),
		});
	}
	worker_threads.parentPort!.postMessage(response);
});

const handlers = {
	setup,
	lint,
	hasCodeFixes,
	hasRules,
};

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

	// Strip ts.SourceFile down to a serializable shape AND dedupe the
	// `text` field across diagnostics — for a checker.ts-sized file
	// (3.2 MB) with hundreds of diagnostics, embedding `text` per
	// diagnostic blows JSON.stringify past V8's max string length and
	// crashes the worker IPC. Instead we send `texts` ONCE at the
	// message level and let the receiver reattach.
	const texts: Record<string, string> = {};
	const getText = language
		? (fn: string) => texts[fn] ??= getFileText(fn)
		: (fn: string, srcText: string) => texts[fn] ??= srcText;
	if (language) {
		diagnostics = diagnostics
			.map(d => transformDiagnostic(language!, d, (originalService as any).getCurrentProgram(), false))
			.filter(d => !!d);
		diagnostics = diagnostics.map<ts.DiagnosticWithLocation>(diagnostic => {
			(getText as (f: string) => string)(diagnostic.file.fileName);
			return {
				...diagnostic,
				file: { fileName: diagnostic.file.fileName } as any,
				relatedInformation: diagnostic.relatedInformation?.map<ts.DiagnosticRelatedInformation>(info => {
					if (info.file) (getText as (f: string) => string)(info.file.fileName);
					return {
						...info,
						file: info.file ? { fileName: info.file.fileName } as any : undefined,
					};
				}),
			};
		});
	}
	else {
		diagnostics = diagnostics.map<ts.DiagnosticWithLocation>(diagnostic => {
			(getText as (f: string, t: string) => string)(diagnostic.file.fileName, diagnostic.file.text);
			return {
				...diagnostic,
				file: { fileName: diagnostic.file.fileName } as any,
				relatedInformation: diagnostic.relatedInformation?.map<ts.DiagnosticRelatedInformation>(info => {
					if (info.file) (getText as (f: string, t: string) => string)(info.file.fileName, info.file.text);
					return {
						...info,
						file: info.file ? { fileName: info.file.fileName } as any : undefined,
					};
				}),
			};
		});
	}

	return [{ diagnostics, texts }, fileCache] as const;
}

function getFileText(fileName: string) {
	return originalHost.getScriptSnapshot(fileName)!.getText(0, Number.MAX_VALUE);
}

// Reattach `text` to each diagnostic's file from the deduped sidecar map,
// AND share one file object per fileName so `ts.formatDiagnosticsWithColor-
// AndContext`'s `lineMap` cache hits across diagnostics. Without sharing,
// per-diagnostic fresh POJOs (from JSON.parse) defeat the cache and TS
// recomputes line starts per diagnostic — 87% of CLI wall time on a
// 3 MB checker.ts before this dedupe.
function reattach(payload: { diagnostics: ts.DiagnosticWithLocation[]; texts: Record<string, string> }): ts.DiagnosticWithLocation[] {
	const { diagnostics, texts } = payload;
	const fileByName = new Map<string, { fileName: string; text: string }>();
	const getFile = (fileName: string): { fileName: string; text: string } => {
		let f = fileByName.get(fileName);
		if (!f) {
			f = { fileName, text: texts[fileName] ?? '' };
			fileByName.set(fileName, f);
		}
		return f;
	};
	for (const d of diagnostics) {
		(d as { file: ts.SourceFile }).file = getFile(d.file.fileName) as any;
		const ri = d.relatedInformation;
		if (ri) {
			for (const info of ri) {
				if (info.file) {
					(info as { file: ts.SourceFile }).file = getFile(info.file.fileName) as any;
				}
			}
		}
	}
	return diagnostics;
}

function hasCodeFixes(fileName: string) {
	return linter.hasCodeFixes(fileName);
}

function hasRules(fileName: string, minimatchCache: core.FileLintCache[2]) {
	return [Object.keys(linter.getRules(fileName, minimatchCache)).length > 0, minimatchCache] as const;
}
