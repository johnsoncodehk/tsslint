import ts = require('typescript');
import type config = require('@tsslint/config');
import core = require('@tsslint/core');
import url = require('url');
import fs = require('fs');
import path = require('path');
import worker_threads = require('worker_threads');
import languagePlugins = require('./languagePlugins.js');

import { createLanguage, FileMap, forEachEmbeddedCode, isCodeActionsEnabled, isFormattingEnabled, Language } from '@volar/language-core';
import { createProxyLanguageService, decorateLanguageServiceHost, resolveFileLanguageId } from '@volar/typescript';
import { transformDiagnostic, transformFileTextChanges } from '@volar/typescript/lib/node/transform';
import { transformTextChange } from '@volar/typescript/lib/node/transform.js';

let projectVersion = 0;
let typeRootsVersion = 0;
let options: ts.CompilerOptions = {};
let fileNames: string[] = [];
let language: Language<string> | undefined;
let linter: core.Linter;
let linterLanguageService!: ts.LanguageService;
let linterSyntaxOnlyLanguageService!: ts.LanguageService;
let fmtSettings: {
	javascript: ts.FormatCodeSettings;
	typescript: ts.FormatCodeSettings;
} | undefined;

const formatLanguageService = ts.createLanguageService({
	...ts.sys,
	getCompilationSettings() {
		return options;
	},
	getScriptFileNames() {
		return [];
	},
	getScriptVersion() {
		return '0';
	},
	getScriptSnapshot() {
		return formattingSnapshot;
	},
	getScriptKind() {
		return formattingScriptKind;
	},
	useCaseSensitiveFileNames() {
		return ts.sys.useCaseSensitiveFileNames;
	},
	getCurrentDirectory() {
		return ts.sys.getCurrentDirectory();
	},
	getDefaultLibFileName() {
		return ts.getDefaultLibFilePath(options);
	},
}, undefined, true);
let formattingSnapshot: ts.IScriptSnapshot;
let formattingScriptKind: ts.ScriptKind;
let formattingIndex = 0;

function formatVirtualScript(kind: ts.ScriptKind, settings: ts.FormatCodeSettings, snapshot: ts.IScriptSnapshot) {
	formattingSnapshot = snapshot;
	formattingScriptKind = kind;
	return formatLanguageService.getFormattingEditsForDocument(`${formattingIndex++}.txt`, settings);
}

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
const originalSyntaxOnlyService = ts.createLanguageService(linterHost, undefined, true);

export function createLocal() {
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

export function create() {
	const worker = new worker_threads.Worker(__filename);
	return {
		setup(...args: Parameters<typeof setup>) {
			return sendRequest(setup, ...args);
		},
		async lint(...args: Parameters<typeof lint>) {
			const [res, newCache] = await sendRequest(lint, ...args);
			Object.assign(args[1], newCache); // Sync the cache
			return res;
		},
		hasCodeFixes(...args: Parameters<typeof hasCodeFixes>) {
			return sendRequest(hasCodeFixes, ...args);
		},
		async hasRules(...args: Parameters<typeof hasRules>) {
			const [res, newCache] = await sendRequest(hasRules, ...args);
			Object.assign(args[1], newCache); // Sync the cache
			return res;
		},
	};

	function sendRequest<T extends (...args: any) => void>(t: T, ...args: any[]) {
		return new Promise<Awaited<ReturnType<T>>>(resolve => {
			worker.once('message', json => {
				resolve(JSON.parse(json));
			});
			worker.postMessage(JSON.stringify([t.name, ...args]));
		});
	}
}

worker_threads.parentPort?.on('message', async json => {
	const data: [cmd: keyof typeof handlers, ...args: any[]] = JSON.parse(json);
	const result = await (handlers[data[0]] as any)(...data.slice(1));
	worker_threads.parentPort!.postMessage(JSON.stringify(result));
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
	builtConfig: string,
	_fileNames: string[],
	_options: ts.CompilerOptions,
	_fmtSettings: {
		javascript: ts.FormatCodeSettings;
		typescript: ts.FormatCodeSettings;
	} | undefined
) {
	const clack = await import('@clack/prompts');

	let config: config.Config | config.Config[];
	try {
		config = (await import(url.pathToFileURL(builtConfig).toString())).default;
	} catch (err) {
		if (err instanceof Error) {
			clack.log.error(err.stack ?? err.message);
		} else {
			clack.log.error(String(err));
		}
		return false;
	}

	for (let key in linterHost) {
		if (!(key in originalHost)) {
			// @ts-ignore
			delete linterHost[key];
		} else {
			// @ts-ignore
			linterHost[key] = originalHost[key];
		}
	}
	linterLanguageService = originalService;
	linterSyntaxOnlyLanguageService = originalSyntaxOnlyService;
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
			}
		);
		decorateLanguageServiceHost(ts, language, linterHost);

		const proxy = createProxyLanguageService(linterLanguageService);
		proxy.initialize(language);
		linterLanguageService = proxy.proxy;

		const syntaxOnly = createProxyLanguageService(linterSyntaxOnlyLanguageService);
		syntaxOnly.initialize(language);
		linterSyntaxOnlyLanguageService = syntaxOnly.proxy;
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
	fmtSettings = _fmtSettings;
	linter = core.createLinter(
		{
			languageService: linterLanguageService,
			languageServiceHost: linterHost,
			typescript: ts,
		},
		path.dirname(configFile),
		config,
		'cli',
		linterSyntaxOnlyLanguageService
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
			fileCache[3] = false;
			const oldSnapshot = snapshots.get(fileName)!;
			newSnapshot = core.applyTextChanges(oldSnapshot, textChanges);
			snapshots.set(fileName, newSnapshot);
			versions.set(fileName, (versions.get(fileName) ?? 0) + 1);
			projectVersion++;
		}

		if (!fileCache[3] && fmtSettings) {
			fileCache[3] = true;

			let script = language?.scripts.get(fileName);
			let linterEdits: ts.TextChange[] = [];
			let serviceEdits: ts.TextChange[] = [];

			if (script?.generated) {
				for (const code of forEachEmbeddedCode(script.generated.root)) {
					if (
						(
							code.languageId === 'javascript'
							|| code.languageId === 'typescript'
							|| code.languageId === 'javascriptreact'
							|| code.languageId === 'typescriptreact'
						)
						&& code.mappings.some(mapping => isFormattingEnabled(mapping.data))
					) {
						const scriptKind = code.languageId === 'javascript' ? ts.ScriptKind.JS
							: code.languageId === 'javascriptreact' ? ts.ScriptKind.JSX
								: code.languageId === 'typescript' ? ts.ScriptKind.TS
									: ts.ScriptKind.TSX;
						const sourceFile = ts.createSourceFile(
							fileName,
							code.snapshot.getText(0, code.snapshot.getLength()),
							ts.ScriptTarget.Latest,
							true,
							scriptKind
						);
						linterEdits.push(
							...linter
								.format(sourceFile, fileCache[2])
								.map(edit => {
									return transformTextChange(
										script,
										language!,
										{
											code,
											extension: '',
											scriptKind: scriptKind,
											preventLeadingOffset: true,
										},
										edit,
										false,
										isFormattingEnabled
									)?.[1];
								})
								.filter(edit => !!edit)
						);
					}
				}
			}
			else {
				const sourceFile: ts.SourceFile = (originalSyntaxOnlyService as any).getNonBoundSourceFile(fileName);
				linterEdits = linter.format(sourceFile, fileCache[2]);
			}

			if (linterEdits.length) {
				const oldSnapshot = snapshots.get(fileName)!;
				newSnapshot = core.applyTextChanges(oldSnapshot, linterEdits);
				snapshots.set(fileName, newSnapshot);
				versions.set(fileName, (versions.get(fileName) ?? 0) + 1);
				projectVersion++;
				script = language?.scripts.get(fileName);
			}

			if (script?.generated) {
				for (const code of forEachEmbeddedCode(script.generated.root)) {
					if (
						(
							code.languageId === 'javascript'
							|| code.languageId === 'typescript'
							|| code.languageId === 'javascriptreact'
							|| code.languageId === 'typescriptreact'
						)
						&& code.mappings.some(mapping => isFormattingEnabled(mapping.data))
					) {
						const scriptKind = code.languageId === 'javascript' ? ts.ScriptKind.JS
							: code.languageId === 'javascriptreact' ? ts.ScriptKind.JSX
								: code.languageId === 'typescript' ? ts.ScriptKind.TS
									: ts.ScriptKind.TSX;
						serviceEdits.push(
							...formatVirtualScript(
								scriptKind,
								fmtSettings[scriptKind === ts.ScriptKind.JS || scriptKind === ts.ScriptKind.JSX ? 'javascript' : 'typescript'],
								code.snapshot)
								.map(edit => {
									return transformTextChange(
										script,
										language!,
										{
											code,
											extension: '',
											scriptKind: scriptKind,
											preventLeadingOffset: true,
										},
										edit,
										false,
										isFormattingEnabled
									)?.[1];
								})
								.filter(edit => !!edit)
						);
					}
				}
			}
			else {
				const scriptKind = linterHost.getScriptKind!(fileName);
				const settings = scriptKind === ts.ScriptKind.JS || scriptKind === ts.ScriptKind.JSX ? fmtSettings.javascript : fmtSettings.typescript;
				serviceEdits = linterLanguageService.getFormattingEditsForDocument(fileName, settings);
			}

			if (serviceEdits.length) {
				const oldSnapshot = snapshots.get(fileName)!;
				newSnapshot = core.applyTextChanges(oldSnapshot, serviceEdits);
				snapshots.set(fileName, newSnapshot);
				versions.set(fileName, (versions.get(fileName) ?? 0) + 1);
				projectVersion++;
			}
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
			fileCache[3] = false;
			shouldCheck = true;
		}
	}

	if (shouldCheck) {
		diagnostics = linter.lint(fileName, fileCache);
	}

	if (language) {
		diagnostics = diagnostics
			.map(d => transformDiagnostic(language!, d, (originalService as any).getCurrentProgram(), false))
			.filter(d => !!d);

		diagnostics = diagnostics.map<ts.DiagnosticWithLocation>(diagnostic => ({
			...diagnostic,
			file: {
				fileName: diagnostic.file.fileName,
				text: getFileText(diagnostic.file.fileName),
			} as any,
			relatedInformation: diagnostic.relatedInformation?.map<ts.DiagnosticRelatedInformation>(info => ({
				...info,
				file: info.file ? {
					fileName: info.file.fileName,
					text: getFileText(info.file.fileName),
				} as any : undefined,
			})),
		}));
	} else {
		diagnostics = diagnostics.map<ts.DiagnosticWithLocation>(diagnostic => ({
			...diagnostic,
			file: {
				fileName: diagnostic.file.fileName,
				text: diagnostic.file.text,
			} as any,
			relatedInformation: diagnostic.relatedInformation?.map<ts.DiagnosticRelatedInformation>(info => ({
				...info,
				file: info.file ? {
					fileName: info.file.fileName,
					text: info.file.text,
				} as any : undefined,
			})),
		}));
	}

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
