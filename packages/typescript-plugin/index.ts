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
				configFile = path.resolve(tsconfig, '..', info.config.configFile);
			} catch (err) {
				// TODO: show error in tsconfig.json
			}
			if (!configFile) {
				return info.languageService;
			}

			let config: Config | undefined;
			let plugins: PluginInstance[] = [];

			const languageServiceHost = info.languageServiceHost;
			const languageService = info.languageService;
			const projectContext: ProjectContext = {
				configFile,
				tsconfig,
				languageServiceHost,
				languageService,
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

			return languageService;

			function decorateLanguageService() {

				const getSyntacticDiagnostics = languageService.getSyntacticDiagnostics;
				const getApplicableRefactors = languageService.getApplicableRefactors;
				const getEditsForRefactor = languageService.getEditsForRefactor;

				languageService.getSyntacticDiagnostics = fileName => {

					let errors: ts.Diagnostic[] = getSyntacticDiagnostics(fileName);

					const sourceFile = languageService.getProgram()?.getSourceFile(fileName);
					if (!sourceFile) {
						return errors as ts.DiagnosticWithLocation[];
					}

					const token = languageServiceHost.getCancellationToken?.();

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
				languageService.getApplicableRefactors = (fileName, positionOrRange, ...rest) => {

					let refactors = getApplicableRefactors(fileName, positionOrRange, ...rest);

					const sourceFile = languageService.getProgram()?.getSourceFile(fileName);
					if (!sourceFile) {
						return refactors;
					}

					const token = languageServiceHost.getCancellationToken?.();

					for (const plugin of plugins) {
						if (token?.isCancellationRequested()) {
							break;
						}
						refactors = refactors.concat(plugin.getFixes?.(sourceFile, positionOrRange) ?? []);
					}

					return refactors;
				};
				languageService.getEditsForRefactor = (fileName, formatOptions, positionOrRange, refactorName, actionName, ...rest) => {

					const sourceFile = languageService.getProgram()?.getSourceFile(fileName);
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
