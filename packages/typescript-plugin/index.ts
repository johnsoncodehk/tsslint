import { Config, PluginInstance, ProjectContext } from '@tsslint/config';
import type * as ts from 'typescript/lib/tsserverlibrary.js';
import { watchConfig } from './lib/watchConfig';
import { builtInPlugins } from './lib/builtInPlugins';
import * as path from 'path';

const init: ts.server.PluginModuleFactory = (modules) => {
	const { typescript: ts } = modules;
	const pluginModule: ts.server.PluginModule = {
		create(info) {

			const tsconfig = info.project.projectKind === ts.server.ProjectKind.Configured
				? info.project.getProjectName()
				: undefined;
			if (!tsconfig) {
				return info.languageService;
			}

			if (!info.config.configFile) {
				return info.languageService;
			}
			let configFile: string | undefined;
			try {
				configFile = require.resolve(info.config.configFile, { paths: [path.dirname(tsconfig)] });
			} catch (err) {
				const getCompilerOptionsDiagnostics = info.languageService.getCompilerOptionsDiagnostics;

				info.languageService.getCompilerOptionsDiagnostics = () => {
					const configFile = ts.readJsonConfigFile(tsconfig, ts.sys.readFile);
					const start = configFile.text.indexOf(info.config.configFile);
					return getCompilerOptionsDiagnostics().concat([{
						category: ts.DiagnosticCategory.Warning,
						code: 0,
						messageText: String(err),
						file: configFile,
						start: start - 1,
						length: info.config.configFile.length + 2,
					}]);
				};

				return info.languageService;
			}

			let config: Config | undefined;
			let plugins: PluginInstance[] = [];

			const projectContext: ProjectContext = {
				configFile,
				tsconfig,
				languageServiceHost: info.languageServiceHost,
				languageService: info.languageService,
				typescript: ts,
			};

			decorateLanguageService();

			watchConfig(
				configFile,
				async (_config, result) => {
					config = _config;
					if (config) {
						plugins = await Promise.all([
							...builtInPlugins,
							...config.plugins ?? []
						].map(plugin => plugin(projectContext, result)));
						for (const plugin of plugins) {
							if (plugin.resolveRules) {
								config.rules = plugin.resolveRules(config.rules ?? {});
							}
						}
					}
					info.project.refreshDiagnostics();
				},
			);

			return info.languageService;

			function decorateLanguageService() {

				const getSyntacticDiagnostics = info.languageService.getSyntacticDiagnostics;
				const getApplicableRefactors = info.languageService.getApplicableRefactors;
				const getEditsForRefactor = info.languageService.getEditsForRefactor;

				info.languageService.getSyntacticDiagnostics = fileName => {

					let errors: ts.Diagnostic[] = getSyntacticDiagnostics(fileName);

					const sourceFile = info.languageService.getProgram()?.getSourceFile(fileName);
					if (!sourceFile) {
						return errors as ts.DiagnosticWithLocation[];
					}

					const token = info.languageServiceHost.getCancellationToken?.();

					for (const plugin of plugins) {
						if (token?.isCancellationRequested()) {
							break;
						}
						if (plugin.lint) {
							let pluginResult = plugin.lint?.(sourceFile, config?.rules ?? {});
							for (const plugin of plugins) {
								if (plugin.resolveResult) {
									pluginResult = plugin.resolveResult(pluginResult);
								}
							}
							errors = errors.concat(pluginResult);
						}
					}

					return errors as ts.DiagnosticWithLocation[];
				};
				info.languageService.getApplicableRefactors = (fileName, positionOrRange, ...rest) => {

					let refactors = getApplicableRefactors(fileName, positionOrRange, ...rest);

					const sourceFile = info.languageService.getProgram()?.getSourceFile(fileName);
					if (!sourceFile) {
						return refactors;
					}

					const token = info.languageServiceHost.getCancellationToken?.();

					for (const plugin of plugins) {
						if (token?.isCancellationRequested()) {
							break;
						}
						refactors = refactors.concat(plugin.getFixes?.(sourceFile, positionOrRange) ?? []);
					}

					return refactors;
				};
				info.languageService.getEditsForRefactor = (fileName, formatOptions, positionOrRange, refactorName, actionName, ...rest) => {

					const sourceFile = info.languageService.getProgram()?.getSourceFile(fileName);
					if (!sourceFile) {
						return;
					}

					for (const plugin of plugins) {
						const edits = plugin.fix?.(sourceFile, refactorName, actionName);
						if (edits) {
							return { edits };
						}
					}

					return getEditsForRefactor(fileName, formatOptions, positionOrRange, refactorName, actionName, ...rest);
				};
			}
		},
	};
	return pluginModule;
};

export = init;
