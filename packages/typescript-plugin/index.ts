import type { Config, ProjectContext } from '@tsslint/config';
import type * as ts from 'typescript';

import core = require('@tsslint/core');
import path = require('path');
import url = require('url');
import fs = require('fs');

const languageServiceDecorators = new WeakMap<ts.server.Project, ReturnType<typeof decorateLanguageService>>();
const plugin: ts.server.PluginModuleFactory = modules => {
	const { typescript: ts } = modules;
	const pluginModule: ts.server.PluginModule = {
		create(info) {
			let decorator = languageServiceDecorators.get(info.project);
			if (!decorator) {
				if (info.project.projectKind === ts.server.ProjectKind.Configured) {
					const tsconfig = info.project.getProjectName();
					decorator = decorateLanguageService(ts, path.dirname(tsconfig), info);
				} else {
					decorator = decorateLanguageService(ts, info.project.getCurrentDirectory(), info);
				}
				languageServiceDecorators.set(info.project, decorator);
			}
			decorator.update();
			return info.languageService;
		},
	};
	return pluginModule;
};

export = plugin;

function decorateLanguageService(
	ts: typeof import('typescript'),
	projectRoot: string,
	info: ts.server.PluginCreateInfo
) {
	const {
		getSemanticDiagnostics,
		getCodeFixesAtPosition,
		getCombinedCodeFix,
		getApplicableRefactors,
		getEditsForRefactor,
		getFormattingEditsForDocument,
		getFormattingEditsForRange,
	} = info.languageService;
	const getScriptSnapshot = info.languageServiceHost.getScriptSnapshot.bind(info.languageServiceHost);
	const getScriptVersion = info.languageServiceHost.getScriptVersion.bind(info.languageServiceHost);
	const projectFileNameKeys = new Set<string>();

	let configFile: string | undefined;
	let configFileBuildContext: Awaited<ReturnType<typeof core.watchConfig>> | undefined;
	let configFileDiagnostics: Omit<ts.Diagnostic, 'file' | 'start' | 'length' | 'source'>[] = [];
	let config: Config | Config[] | undefined;
	let linter: core.Linter | undefined;
	let formattingSnapshot: ts.IScriptSnapshot | undefined;
	let formattingSnapshotVersion = 0;

	info.languageServiceHost.getScriptSnapshot = fileName => {
		if (formattingSnapshot) {
			return formattingSnapshot;
		}
		return getScriptSnapshot(fileName);
	};
	info.languageServiceHost.getScriptVersion = fileName => {
		if (formattingSnapshot) {
			return `tsslint-fmt-${formattingSnapshotVersion++}`;
		}
		return getScriptVersion(fileName);
	};

	info.languageService.getFormattingEditsForDocument = (fileName, options) => {
		if (linter) {
			try {
				const sourceFile: ts.SourceFile = (info.languageService as any).getNonBoundSourceFile(fileName);
				const linterEdits = linter.format(sourceFile);
				if (linterEdits.length) {
					const originalLength = sourceFile.text.length;
					let text = sourceFile.text;
					for (const edit of linterEdits.sort((a, b) => (b.span.start + b.span.length) - (a.span.start + a.span.length))) {
						text = text.slice(0, edit.span.start) + edit.newText + text.slice(edit.span.start + edit.span.length);
					}
					formattingSnapshot = ts.ScriptSnapshot.fromString(text);
					const serviceEdits = getFormattingEditsForDocument(fileName, options);
					formattingSnapshot = undefined;
					if (serviceEdits.length) {
						for (const edit of serviceEdits.sort((a, b) => (b.span.start + b.span.length) - (a.span.start + a.span.length))) {
							text = text.slice(0, edit.span.start) + edit.newText + text.slice(edit.span.start + edit.span.length);
						}
						return [{
							span: { start: 0, length: originalLength },
							newText: text,
						}];
					}
					else {
						return linterEdits;
					}
				}
			} catch {
				debugger;
			}
		}
		return getFormattingEditsForDocument(fileName, options);
	};
	info.languageService.getFormattingEditsForRange = (fileName, start, end, options) => {
		if (linter) {
			try {
				const sourceFile: ts.SourceFile = (info.languageService as any).getNonBoundSourceFile(fileName);
				const linterEdits = linter.format(sourceFile);
				if (linterEdits.length) {
					const originalLength = sourceFile.text.length;
					let text = sourceFile.text;
					let formattingStart = start;
					let formattingEnd = end;
					for (const edit of linterEdits.sort((a, b) => (b.span.start + b.span.length) - (a.span.start + a.span.length))) {
						text = text.slice(0, edit.span.start) + edit.newText + text.slice(edit.span.start + edit.span.length);
						if (edit.span.start < start) {
							formattingStart += edit.newText.length - edit.span.length;
						}
						if (edit.span.start + edit.span.length < end) {
							formattingEnd += edit.newText.length - edit.span.length;
						}
					}
					formattingSnapshot = ts.ScriptSnapshot.fromString(text);
					const serviceEdits = getFormattingEditsForRange(fileName, formattingStart, formattingEnd, options);
					formattingSnapshot = undefined;
					if (serviceEdits.length) {
						for (const edit of serviceEdits.sort((a, b) => (b.span.start + b.span.length) - (a.span.start + a.span.length))) {
							text = text.slice(0, edit.span.start) + edit.newText + text.slice(edit.span.start + edit.span.length);
						}
						return [{
							span: { start: 0, length: originalLength },
							newText: text,
						}];
					}
					else {
						return linterEdits;
					}
				}
			} catch {
				debugger;
			}
		}
		return getFormattingEditsForRange(fileName, start, end, options);
	};
	info.languageService.getSemanticDiagnostics = fileName => {
		let result = getSemanticDiagnostics(fileName);
		if (!isProjectFileName(fileName)) {
			return result;
		}
		if (configFileDiagnostics.length) {
			const sourceFile = info.languageService.getProgram()?.getSourceFile(fileName);
			if (sourceFile) {
				result = result.concat(configFileDiagnostics.map<ts.DiagnosticWithLocation>(diagnostic => ({
					...diagnostic,
					source: 'tsslint',
					file: sourceFile,
					start: 0,
					length: 0,
				})));
			}
		}
		if (linter) {
			result = result.concat(linter.lint(fileName));
		}
		return result;
	};
	info.languageService.getCodeFixesAtPosition = (fileName, start, end, errorCodes, formatOptions, preferences) => {
		return [
			...getCodeFixesAtPosition(fileName, start, end, errorCodes, formatOptions, preferences),
			...linter?.getCodeFixes(fileName, start, end) ?? [],
		];
	};
	info.languageService.getCombinedCodeFix = (scope, fixId, formatOptions, preferences) => {
		if (fixId === 'tsslint' && linter) {
			const fixes = linter.getCodeFixes(scope.fileName, 0, Number.MAX_VALUE).filter(fix => fix.fixId === 'tsslint');
			const changes = core.combineCodeFixes(scope.fileName, fixes);
			return {
				changes: [{
					fileName: scope.fileName,
					textChanges: changes,
				}],
			};
		}
		return getCombinedCodeFix(scope, fixId, formatOptions, preferences);
	};
	info.languageService.getApplicableRefactors = (fileName, positionOrRange, preferences, triggerReason, kind, includeInteractiveActions) => {
		const start = typeof positionOrRange === 'number' ? positionOrRange : positionOrRange.pos;
		const end = typeof positionOrRange === 'number' ? positionOrRange : positionOrRange.end;
		const refactors = linter?.getRefactors(fileName, start, end) ?? [];
		return [
			...getApplicableRefactors(fileName, positionOrRange, preferences, triggerReason, kind, includeInteractiveActions),
			{
				actions: refactors,
				name: 'TSSLint',
				description: 'TSSLint refactor actions',
			},
		];
	};
	info.languageService.getEditsForRefactor = (fileName, formatOptions, positionOrRange, refactorName, actionName, preferences, interactiveRefactorArguments) => {
		const tsslintEdits = linter?.getRefactorEdits(fileName, actionName);
		if (tsslintEdits) {
			return { edits: tsslintEdits };
		}
		return getEditsForRefactor(fileName, formatOptions, positionOrRange, refactorName, actionName, preferences, interactiveRefactorArguments);
	};

	return { update };

	function isProjectFileName(fileName: string) {
		fileName = fileName.replace(/\\/g, '/');
		const projectFileNames = info.languageServiceHost.getScriptFileNames();
		if (projectFileNames.length !== projectFileNameKeys.size) {
			projectFileNameKeys.clear();
			for (const fileName of projectFileNames) {
				projectFileNameKeys.add(getFileKey(fileName));
			}
		}
		return projectFileNameKeys.has(getFileKey(fileName));
	}

	function getFileKey(fileName: string) {
		return info.languageServiceHost.useCaseSensitiveFileNames?.() ? fileName : fileName.toLowerCase();
	}

	async function update() {

		const newConfigFile = ts.findConfigFile(projectRoot, ts.sys.fileExists, 'tsslint.config.ts');

		if (newConfigFile !== configFile) {
			configFile = newConfigFile;
			config = undefined;
			linter = undefined;
			configFileBuildContext?.dispose();
			configFileDiagnostics = [];

			if (!configFile) {
				return;
			}

			const projectContext: ProjectContext = {
				languageServiceHost: info.languageServiceHost,
				languageService: info.languageService,
				typescript: ts,
			};

			try {
				configFileBuildContext = await core.watchConfig(
					configFile,
					async (builtConfig, { errors, warnings }) => {
						configFileDiagnostics = [
							...errors.map(error => [error, ts.DiagnosticCategory.Error] as const),
							...warnings.map(error => [error, ts.DiagnosticCategory.Warning] as const),
						].map(([error, category]) => {
							const diag: typeof configFileDiagnostics[number] = {
								category,
								code: error.id as any,
								messageText: error.text,
							};
							if (error.location) {
								const fileName = path.resolve(error.location.file).replace('http-url:', '');
								let relatedFile = (info.languageService as any).getCurrentProgram()?.getSourceFile(fileName);
								if (!relatedFile) {
									const fileText = ts.sys.readFile(error.location.file);
									if (fileText !== undefined) {
										relatedFile = ts.createSourceFile(fileName, fileText, ts.ScriptTarget.Latest, true);
									}
								}
								if (relatedFile) {
									diag.messageText = `Error building config file.`;
									diag.relatedInformation = [{
										category,
										code: error.id as any,
										messageText: error.text,
										file: relatedFile,
										start: relatedFile.getPositionOfLineAndCharacter(error.location.line - 1, error.location.column),
										length: error.location.lineText.length,
									}];
								}
							}
							return diag;
						});
						if (builtConfig) {
							try {
								initSourceMapSupport();
								const mtime = ts.sys.getModifiedTime?.(builtConfig)?.getTime() ?? Date.now();
								config = (await import(url.pathToFileURL(builtConfig).toString() + '?tsslint_time=' + mtime)).default;
								linter = core.createLinter(projectContext, path.dirname(configFile!), config!, 'typescript-plugin');
							} catch (err) {
								config = undefined;
								linter = undefined;
								const prevLength = configFileDiagnostics.length;
								if (err instanceof Error) {
									const relatedInfo = core.createRelatedInformation(ts, err, 0);
									if (relatedInfo) {
										configFileDiagnostics.push({
											category: ts.DiagnosticCategory.Error,
											code: 0,
											messageText: err.message,
											relatedInformation: [relatedInfo],
										});
									}
								}
								if (prevLength === configFileDiagnostics.length) {
									configFileDiagnostics.push({
										category: ts.DiagnosticCategory.Error,
										code: 0,
										messageText: String(err),
									});
								}
							}
						}
						info.project.refreshDiagnostics();
					},
					true,
					ts.sys.createHash
				);
			} catch (err) {
				configFileDiagnostics.push({
					category: ts.DiagnosticCategory.Error,
					code: 'config-build-error' as any,
					messageText: String(err),
				});
			}
		}
	}
}

function initSourceMapSupport() {
	delete require.cache[require.resolve('source-map-support')];

	require('source-map-support').install({
		retrieveFile(pathOrUrl: string) {
			if (pathOrUrl.includes('?tsslint_time=')) {
				pathOrUrl = pathOrUrl.replace(/\?tsslint_time=\d*/, '');
				if (pathOrUrl.includes('://')) {
					pathOrUrl = url.fileURLToPath(pathOrUrl);
				}
				return fs.readFileSync(pathOrUrl, 'utf8');
			}
		},
	});
	require('source-map-support').install({
		retrieveFile(pathOrUrl: string) {
			if (pathOrUrl.endsWith('.map')) {
				try {
					if (pathOrUrl.includes('://')) {
						pathOrUrl = url.fileURLToPath(pathOrUrl);
					}
					const contents = fs.readFileSync(pathOrUrl, 'utf8');
					const map = JSON.parse(contents);
					for (let source of map.sources) {
						if (!source.startsWith('./') && !source.startsWith('../')) {
							source = './' + source;
						}
						source = path.resolve(path.dirname(pathOrUrl), source);
						if (!fs.existsSync(source)) {
							// Fixes https://github.com/typescript-eslint/typescript-eslint/issues/9352
							return JSON.stringify({
								version: 3,
								sources: [],
								sourcesContent: [],
								mappings: '',
								names: [],
							});
						}
					}
					return contents;
				} catch { }
			}
		},
	});
}
