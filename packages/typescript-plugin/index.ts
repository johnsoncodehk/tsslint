import type { Config, ProjectContext } from '@tsslint/config';
import { Linter, createLinter, combineCodeFixes, watchConfigFile } from '@tsslint/core';
import * as path from 'path';
import type * as ts from 'typescript';

const languageServiceDecorators = new WeakMap<ts.server.Project, ReturnType<typeof decorateLanguageService>>();

const init: ts.server.PluginModuleFactory = modules => {
	const { typescript: ts } = modules;
	const pluginModule: ts.server.PluginModule = {
		create(info) {

			if (!languageServiceDecorators.has(info.project)) {
				const tsconfig = info.project.projectKind === ts.server.ProjectKind.Configured
					? info.project.getProjectName()
					: undefined;
				if (tsconfig) {
					languageServiceDecorators.set(
						info.project,
						decorateLanguageService(ts, tsconfig, info)
					);
				}
			}

			languageServiceDecorators.get(info.project)?.update(info.config);

			return info.languageService;
		},
	};
	return pluginModule;
};

export = init;

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
	let configFileBuildContext: Awaited<ReturnType<typeof watchConfigFile>> | undefined;
	let configFileDiagnostics: ts.Diagnostic[] = [];
	let config: Config | undefined;
	let linter: Linter | undefined;

	info.languageService.getSemanticDiagnostics = fileName => {
		let result = getSemanticDiagnostics(fileName);
		if (!isProjectFileName(fileName)) {
			return result;
		}
		if (configFileDiagnostics.length) {
			const sourceFile = info.languageService.getProgram()?.getSourceFile(fileName);
			if (sourceFile) {
				if (configFileDiagnostics.length) {
					result = result.concat(configFileDiagnostics.map<ts.DiagnosticWithLocation>(diagnostic => ({
						...diagnostic,
						file: sourceFile,
						start: 0,
						length: 0,
					})));
				}
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
			const changes = combineCodeFixes(scope.fileName, fixes);
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

	async function update(pluginConfig?: { configFile?: string; }) {

		let configOptionSpan: ts.TextSpan = { start: 0, length: 0 };
		let newConfigFile: string | undefined;
		let configResolveError: any;

		const jsonConfigFile = ts.readJsonConfigFile(tsconfig, ts.sys.readFile);

		if (pluginConfig?.configFile) {
			configOptionSpan = {
				start: jsonConfigFile.text.indexOf(pluginConfig.configFile) - 1,
				length: pluginConfig.configFile.length + 2,
			};
			try {
				newConfigFile = require.resolve(pluginConfig.configFile, { paths: [path.dirname(tsconfig)] });
			} catch (err) {
				configResolveError = err;
			}
		}
		else {
			newConfigFile = ts.findConfigFile(path.dirname(tsconfig), ts.sys.fileExists, 'tsslint.config.ts');
		}

		if (newConfigFile !== configFile) {
			configFile = newConfigFile;
			config = undefined;
			linter = undefined;
			configFileBuildContext?.dispose();
			configFileDiagnostics = [];

			if (configResolveError) {
				configFileDiagnostics.push({
					category: ts.DiagnosticCategory.Error,
					code: 0,
					messageText: String(configResolveError),
					file: jsonConfigFile,
					start: configOptionSpan.start,
					length: configOptionSpan.length,
				});
			}

			if (!configFile) {
				return;
			}

			const projectContext: ProjectContext = {
				configFile,
				tsconfig,
				languageServiceHost: info.languageServiceHost,
				languageService: info.languageService,
				typescript: ts,
			};

			try {
				configFileBuildContext = await watchConfigFile(
					configFile,
					(_config, { errors, warnings }) => {
						config = _config;
						configFileDiagnostics = [
							...errors.map(error => [error, ts.DiagnosticCategory.Error] as const),
							...warnings.map(error => [error, ts.DiagnosticCategory.Warning] as const),
						].map(([error, category]) => {
							const diag: ts.Diagnostic = {
								category,
								source: 'tsslint',
								code: 0,
								messageText: 'Failed to build/load TSSLint config.',
								file: jsonConfigFile,
								start: configOptionSpan.start,
								length: configOptionSpan.length,
							};
							if (error.location) {
								const fileName = path.resolve(error.location.file);
								const fileText = ts.sys.readFile(error.location.file);
								const sourceFile = ts.createSourceFile(fileName, fileText ?? '', ts.ScriptTarget.Latest, true);
								diag.relatedInformation = [{
									category,
									code: error.id as any,
									messageText: error.text,
									file: sourceFile,
									start: sourceFile.getPositionOfLineAndCharacter(error.location.line - 1, error.location.column),
									length: error.location.lineText.length,
								}];
							}
							else {
								diag.messageText += `\n\n${error.text}`;
							}
							return diag;
						});
						if (config) {
							linter = createLinter(projectContext, config, true);
						}
						info.project.refreshDiagnostics();
					},
					true,
					ts.sys.createHash
				);
			} catch (err) {
				configFileDiagnostics.push({
					category: ts.DiagnosticCategory.Error,
					source: 'tsslint',
					code: 'config-build-error' as any,
					messageText: String(err),
					file: jsonConfigFile,
					start: configOptionSpan.start,
					length: configOptionSpan.length,
				});
			}
		}
	}
}
