import type { Config, LinterContext } from '@tsslint/config';
import type * as ts from 'typescript';

import core = require('@tsslint/core');
import path = require('path');
import url = require('url');
import fs = require('fs');
import ErrorStackParser = require('error-stack-parser');

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
const fsFiles = new Map<string, [exist: boolean, mtime: number, ts.SourceFile]>();

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
	} = info.languageService;
	const projectFileNameKeys = new Set<string>();

	let configFile: string | undefined;
	let configFileBuildContext: Awaited<ReturnType<typeof core.watchConfig>> | undefined;
	let configFileDiagnostics: Omit<ts.Diagnostic, 'file' | 'start' | 'length' | 'source'>[] = [];
	let config: Config | Config[] | undefined;
	let linter: core.Linter | undefined;

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

			const projectContext: LinterContext = {
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
								linter = core.createLinter(projectContext, path.dirname(configFile!), config!, (diag, err, stackOffset) => {
									const relatedInfo = createRelatedInformation(ts, err, stackOffset);
									if (relatedInfo) {
										diag.relatedInformation!.push(relatedInfo);
									}
								});
							} catch (err) {
								config = undefined;
								linter = undefined;
								const prevLength = configFileDiagnostics.length;
								if (err instanceof Error) {
									const relatedInfo = createRelatedInformation(ts, err, 0);
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

function createRelatedInformation(ts: typeof import('typescript'), err: Error, stackOffset: number): ts.DiagnosticRelatedInformation | undefined {
	const stacks = ErrorStackParser.parse(err);
	if (stacks.length <= stackOffset) {
		return;
	}
	const stack = stacks[stackOffset];
	if (stack.fileName && stack.lineNumber !== undefined && stack.columnNumber !== undefined) {
		let fileName = stack.fileName.replace(/\\/g, '/');
		if (fileName.startsWith('file://')) {
			fileName = fileName.substring('file://'.length);
		}
		if (fileName.includes('http-url:')) {
			fileName = fileName.split('http-url:')[1];
		}
		const mtime = ts.sys.getModifiedTime?.(fileName)?.getTime() ?? 0;
		const lastMtime = fsFiles.get(fileName)?.[1];
		if (mtime !== lastMtime) {
			const text = ts.sys.readFile(fileName);
			fsFiles.set(
				fileName,
				[
					text !== undefined,
					mtime,
					ts.createSourceFile(fileName, text ?? '', ts.ScriptTarget.Latest, true)
				]
			);
		}
		const [exist, _mtime, relatedFile] = fsFiles.get(fileName)!;
		let pos = 0;
		if (exist) {
			try {
				pos = relatedFile.getPositionOfLineAndCharacter(stack.lineNumber - 1, stack.columnNumber - 1) ?? 0;
			} catch { }
		}
		return {
			category: ts.DiagnosticCategory.Message,
			code: 0,
			file: relatedFile,
			start: pos,
			length: 0,
			messageText: 'at ' + (stack.functionName ?? '<anonymous>'),
		};
	}
}
