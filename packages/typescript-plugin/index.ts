import { Config, PluginInstance, ProjectContext } from '@tsslint/config';
import type * as ts from 'typescript/lib/tsserverlibrary.js';
import { watchConfig } from './lib/watchConfig';
import { builtInPlugins } from './lib/builtInPlugins';
import * as path from 'path';

const languageServiceDecorator = new WeakMap<ts.LanguageService, ReturnType<typeof decorateLanguageService>>();

const init: ts.server.PluginModuleFactory = (modules) => {
	const { typescript: ts } = modules;
	const pluginModule: ts.server.PluginModule = {
		create(info) {

			if (!languageServiceDecorator.has(info.languageService)) {
				const tsconfig = info.project.projectKind === ts.server.ProjectKind.Configured
					? info.project.getProjectName()
					: undefined;
				if (tsconfig) {
					languageServiceDecorator.set(
						info.languageService,
						decorateLanguageService(
							ts,
							tsconfig,
							info.languageServiceHost,
							info.languageService,
						),
					);
				}
			}

			languageServiceDecorator.get(info.languageService)?.update(info);

			return info.languageService;
		},
	};
	return pluginModule;
};

export = init;

function decorateLanguageService(
	ts: typeof import('typescript/lib/tsserverlibrary'),
	tsconfig: string,
	languageServiceHost: ts.LanguageServiceHost,
	languageService: ts.LanguageService,
) {

	const getCompilerOptionsDiagnostics = languageService.getCompilerOptionsDiagnostics;
	const getSyntacticDiagnostics = languageService.getSyntacticDiagnostics;
	const getApplicableRefactors = languageService.getApplicableRefactors;
	const getEditsForRefactor = languageService.getEditsForRefactor;

	let compilerOptionsDiagnostics: ts.Diagnostic[] = [];
	let configFile: string | undefined;
	let configFileBuildContext: Awaited<ReturnType<typeof watchConfig>> | undefined;
	let config: Config | undefined;
	let plugins: PluginInstance[] = [];

	languageService.getCompilerOptionsDiagnostics = () => {
		return getCompilerOptionsDiagnostics().concat(compilerOptionsDiagnostics);
	};
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

	return { update };

	async function update(info: ts.server.PluginCreateInfo) {
		try {
			const newConfigFile = require.resolve(info.config.configFile, { paths: [path.dirname(tsconfig)] });
			if (newConfigFile === configFile) {
				return;
			}
			configFile = newConfigFile;

			const projectContext: ProjectContext = {
				configFile,
				tsconfig,
				languageServiceHost: info.languageServiceHost,
				languageService: info.languageService,
				typescript: ts,
			};

			configFileBuildContext?.dispose();
			configFileBuildContext = await watchConfig(
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
		} catch (err) {
			const configFile = ts.readJsonConfigFile(tsconfig, ts.sys.readFile);
			const start = configFile.text.indexOf(info.config.configFile);
			compilerOptionsDiagnostics = [{
				category: ts.DiagnosticCategory.Warning,
				code: 0,
				messageText: String(err),
				file: configFile,
				start: start - 1,
				length: info.config.configFile.length + 2,
			}];
		}
	}
}
