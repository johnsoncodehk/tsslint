import type { Config, ProjectContext, watchConfigFile } from '@tsslint/config';
import { Linter, createLinter } from '@tsslint/core';
import * as path from 'path';
import type * as ts from 'typescript/lib/tsserverlibrary.js';

const languageServiceDecorators = new WeakMap<ts.LanguageService, ReturnType<typeof decorateLanguageService>>();

const init: ts.server.PluginModuleFactory = (modules) => {
	const { typescript: ts } = modules;
	const pluginModule: ts.server.PluginModule = {
		create(info) {

			if (!languageServiceDecorators.has(info.languageService)) {
				const tsconfig = info.project.projectKind === ts.server.ProjectKind.Configured
					? info.project.getProjectName()
					: undefined;
				if (tsconfig) {
					languageServiceDecorators.set(
						info.languageService,
						decorateLanguageService(ts, tsconfig, info),
					);
				}
			}

			languageServiceDecorators.get(info.languageService)?.update(info.config);

			return info.languageService;
		},
	};
	return pluginModule;
};

export = init;

function decorateLanguageService(
	ts: typeof import('typescript/lib/tsserverlibrary'),
	tsconfig: string,
	info: ts.server.PluginCreateInfo,
) {

	const getCompilerOptionsDiagnostics = info.languageService.getCompilerOptionsDiagnostics;
	const getSyntacticDiagnostics = info.languageService.getSyntacticDiagnostics;
	const getCodeFixesAtPosition = info.languageService.getCodeFixesAtPosition;

	let configFile: string | undefined;
	let configFileBuildContext: Awaited<ReturnType<typeof watchConfigFile>> | undefined;
	let configFileDiagnostics: ts.Diagnostic[] = [];
	let config: Config | undefined;
	let linter: Linter | undefined;

	info.languageService.getCompilerOptionsDiagnostics = () => {
		return getCompilerOptionsDiagnostics().concat(configFileDiagnostics);
	};
	info.languageService.getSyntacticDiagnostics = fileName => {
		let result = getSyntacticDiagnostics(fileName);
		if (info.languageServiceHost.getScriptFileNames().includes(fileName)) {
			if (linter) {
				result = result.concat(linter.lint(fileName));
			}
			if (config?.debug) {
				result.push({
					category: ts.DiagnosticCategory.Warning,
					source: 'tsslint',
					code: 'debug-info' as any,
					messageText: JSON.stringify({
						rules: Object.keys(config?.rules ?? {}),
						plugins: config.plugins?.length,
						configFile,
						tsconfig,
					}, null, 2),
					file: info.languageService.getProgram()!.getSourceFile(fileName)!,
					start: 0,
					length: 0,
				});
			}
		}
		return result;
	};
	info.languageService.getCodeFixesAtPosition = (fileName, start, end, errorCodes, formatOptions, preferences) => {
		return [
			...getCodeFixesAtPosition(fileName, start, end, errorCodes, formatOptions, preferences),
			...linter?.getCodeFixes(fileName, start, end) ?? [],
		];
	};

	return { update };

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

			let configImportPath: string | undefined;

			try {
				configImportPath = require.resolve('@tsslint/config', { paths: [configFile] });
			} catch (err) {
				configFileDiagnostics = [{
					category: ts.DiagnosticCategory.Error,
					code: 0,
					messageText: String(err),
					file: jsonConfigFile,
					start: 0,
					length: 0,
				}];
				return;
			}

			const { watchConfigFile }: typeof import('@tsslint/config') = require(configImportPath);
			const projectContext: ProjectContext = {
				configFile,
				tsconfig,
				languageServiceHost: info.languageServiceHost,
				languageService: info.languageService,
				typescript: ts,
			};

			configFileBuildContext = await watchConfigFile(
				configFile,
				async (_config, { errors, warnings }) => {
					config = _config;
					configFileDiagnostics = [
						...errors.map(error => [error, ts.DiagnosticCategory.Error] as const),
						...warnings.map(error => [error, ts.DiagnosticCategory.Warning] as const),
					].map(([error, category]) => {
						const diag: ts.Diagnostic = {
							category,
							source: 'tsslint',
							code: 0,
							messageText: 'Failed to build config',
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
						return diag;
					});
					if (config) {
						linter = createLinter(projectContext, config, true);
					}
					info.project.refreshDiagnostics();
				},
			);
		}
	}
}
