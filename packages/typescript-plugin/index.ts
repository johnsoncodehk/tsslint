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
			if (info.project.projectKind === ts.server.ProjectKind.Configured) {
				let decorator = languageServiceDecorators.get(info.project);
				if (!decorator) {
					const tsconfig = info.project.getProjectName();
					decorator = decorateLanguageService(ts, tsconfig, info);
					languageServiceDecorators.set(info.project, decorator);
				}
				decorator.update();
			}
			return info.languageService;
		},
	};
	return pluginModule;
};

export = plugin;

function decorateLanguageService(
	ts: typeof import('typescript'),
	tsconfig: string,
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
			const fixes = linter.getCodeFixes(scope.fileName, 0, Number.MAX_VALUE);
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

		const newConfigFile = ts.findConfigFile(path.dirname(tsconfig), ts.sys.fileExists, 'tsslint.config.ts');

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
				configFile,
				languageServiceHost: info.languageServiceHost,
				languageService: info.languageService,
				typescript: ts,
				tsconfig: ts.server.toNormalizedPath(tsconfig),
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
								linter = core.createLinter(projectContext, config!, 'typescript-plugin');
							} catch (err) {
								config = undefined;
								linter = undefined;
								configFileDiagnostics.push({
									category: ts.DiagnosticCategory.Error,
									code: 0,
									messageText: err instanceof Error
										? err.stack ?? err.message
										: String(err),
								});
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
			pathOrUrl = pathOrUrl.replace(/\\/g, '/');
			// monkey-fix, refs: https://github.com/typescript-eslint/typescript-eslint/issues/9352
			if (
				pathOrUrl.includes('/@typescript-eslint/eslint-plugin/dist/rules/')
				|| pathOrUrl.includes('/eslint-plugin-expect-type/lib/rules/')
			) {
				return JSON.stringify({
					version: 3,
					sources: [],
					sourcesContent: [],
					mappings: '',
					names: [],
				});
			}
		},
	});
}
