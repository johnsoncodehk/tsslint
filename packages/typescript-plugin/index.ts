import { Config, PluginInstance, ProjectContext } from '@tsslint/config';
import type * as ts from 'typescript/lib/tsserverlibrary.js';
import { watchConfig } from './lib/watchConfig';
import { builtInPlugins } from './lib/builtInPlugins';
import * as path from 'path';

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
	const getApplicableRefactors = info.languageService.getApplicableRefactors;
	const getEditsForRefactor = info.languageService.getEditsForRefactor;

	let compilerOptionsDiagnostics: ts.Diagnostic[] = [];
	let configFile: string | undefined;
	let configFileBuildContext: Awaited<ReturnType<typeof watchConfig>> | undefined;
	let config: Config | undefined;
	let plugins: PluginInstance[] = [];

	info.languageService.getCompilerOptionsDiagnostics = () => {
		return getCompilerOptionsDiagnostics().concat(compilerOptionsDiagnostics);
	};
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

	return { update };

	async function update(pluginConfig: { configFile: string; }) {

		const jsonConfigFile = ts.readJsonConfigFile(tsconfig, ts.sys.readFile);
		const start = jsonConfigFile.text.indexOf(pluginConfig.configFile) - 1;
		const length = pluginConfig.configFile.length + 2;

		let newConfigFile: string | undefined;
		let configResolveError: any;

		try {
			newConfigFile = require.resolve(pluginConfig.configFile, { paths: [path.dirname(tsconfig)] });
		} catch (err) {
			configResolveError = err;
		}

		if (newConfigFile !== configFile) {
			configFile = newConfigFile;
			config = undefined;
			plugins = [];
			configFileBuildContext?.dispose();
			compilerOptionsDiagnostics = [];

			if (configResolveError) {
				compilerOptionsDiagnostics.push({
					category: ts.DiagnosticCategory.Error,
					code: 0,
					messageText: String(configResolveError),
					file: jsonConfigFile,
					start: start,
					length: length,
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

			configFileBuildContext = await watchConfig(
				configFile,
				async (_config, { errors, warnings }) => {
					config = _config;
					compilerOptionsDiagnostics = [
						...errors.map(error => [error, ts.DiagnosticCategory.Error] as const),
						...warnings.map(error => [error, ts.DiagnosticCategory.Warning] as const),
					].map(([error, category]) => {
						const diag: ts.Diagnostic = {
							category,
							code: 0,
							messageText: error.text,
							file: jsonConfigFile,
							start: start,
							length: length,
						};
						return diag;
					});
					if (config) {
						plugins = await Promise.all([
							...builtInPlugins,
							...config.plugins ?? []
						].map(plugin => plugin(projectContext)));
						for (const plugin of plugins) {
							if (plugin.resolveRules) {
								config.rules = plugin.resolveRules(config.rules ?? {});
							}
						}
					}
					info.project.refreshDiagnostics();
				},
			);
		}
	}
}
