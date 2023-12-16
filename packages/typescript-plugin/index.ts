import * as ErrorStackParser from 'error-stack-parser';
import type * as ts from 'typescript/lib/tsserverlibrary.js';
import { watchConfig, ProjectContext, Reporter, RuleContext, LoadConfigResult, Plugin, findConfigFile, PluginInstance } from 'tsslint';

const sourceFiles = new Map<string, ts.SourceFile>();
const basePlugins: Plugin[] = [
	(ctx, loadConfigResult) => {
		const ts = ctx.typescript;

		return {
			lint(sourceFile) {
				if (sourceFile.fileName !== ctx.configFile) {
					return [];
				}
				return [
					...loadConfigResult.errors.map(error => [error, ts.DiagnosticCategory.Error] as const),
					...loadConfigResult.warnings.map(error => [error, ts.DiagnosticCategory.Warning] as const),
				].map(([error, category]) => {
					const diag: ts.Diagnostic = {
						category,
						source: 'tsslint-esbuild',
						// @ts-expect-error
						code: error.code,
						messageText: JSON.stringify(error, null, 2),
						file: sourceFile,
						start: 0,
						length: 0,
					};
					// TODO: parse error.notes for relatedInformation
					return diag;
				});
			},
		};
	},
	ctx => {
		const ts = ctx.typescript;
		const fileFixes = new Map<string, Map<string, {
			title: string;
			start: number;
			end: number;
			getEdits: () => ts.FileTextChanges[];
		}[]>>();

		return {
			lint(sourceFile, rules) {
				const rulesContext: RuleContext = {
					...ctx,
					sourceFile,
					reportError,
					reportWarning,
					reportSuggestion,
				};
				const token = ctx.languageServiceHost.getCancellationToken?.();
				const result: ts.Diagnostic[] = [];
				const fixes = getFileFixes(sourceFile.fileName);

				fixes.clear();

				let currentRuleId: string;

				for (const [id, rule] of Object.entries(rules)) {
					if (token?.isCancellationRequested()) {
						break;
					}
					currentRuleId = id;
					rule(rulesContext);
				}

				return result;

				function reportError(message: string, start: number, end: number) {
					return report(ts.DiagnosticCategory.Error, message, start, end);
				}

				function reportWarning(message: string, start: number, end: number) {
					return report(ts.DiagnosticCategory.Warning, message, start, end);
				}

				function reportSuggestion(message: string, start: number, end: number) {
					return report(ts.DiagnosticCategory.Suggestion, message, start, end);
				}

				function report(category: ts.DiagnosticCategory, message: string, start: number, end: number): Reporter {

					const error: ts.Diagnostic = {
						category,
						// @ts-expect-error
						code: currentRuleId,
						messageText: message,
						file: sourceFile,
						start,
						length: end - start,
						source: 'tsslint',
						relatedInformation: [],
					};
					const stacks = ErrorStackParser.parse(new Error());

					if (stacks.length >= 3) {
						const stack = stacks[2];
						if (stack.fileName && stack.lineNumber !== undefined && stack.columnNumber !== undefined) {
							let fileName = stack.fileName.replace(/\\/g, '/');
							if (fileName.startsWith('file://')) {
								fileName = fileName.substring('file://'.length);
							}
							if (!sourceFiles.has(fileName)) {
								sourceFiles.set(
									fileName,
									ts.createSourceFile(
										fileName,
										ctx.languageServiceHost.readFile(fileName)!,
										ts.ScriptTarget.Latest,
										true
									)
								);
							}
							const stackFile = sourceFiles.get(fileName)!;
							const pos = stackFile?.getPositionOfLineAndCharacter(stack.lineNumber - 1, stack.columnNumber - 1);
							let reportNode: ts.Node | undefined;
							stackFile.forEachChild(function visit(node) {
								if (node.end < pos || reportNode) {
									return;
								}
								if (node.pos <= pos) {
									if (node.getStart() === pos) {
										reportNode = node;
									}
									else {
										node.forEachChild(visit);
									}
								}
							});
							error.relatedInformation?.push({
								category: ts.DiagnosticCategory.Message,
								code: 0,
								file: stackFile,
								start: pos,
								length: reportNode?.end ? reportNode.end - pos : 0,
								messageText: '👈 Reported from here',
							});
						}
					}

					result.push(error);

					return {
						withDeprecated() {
							error.reportsDeprecated = true;
							return this;
						},
						withUnnecessary() {
							error.reportsUnnecessary = true;
							return this;
						},
						withFix(title, getEdits) {
							if (!fixes.has(currentRuleId)) {
								fixes.set(currentRuleId, []);
							}
							fixes.get(currentRuleId)!.push(({
								title,
								start,
								end,
								getEdits,
							}));
							return this;
						},
					};
				}
			},
			getFixes(sourceFile, positionOrRange) {

				const start = typeof positionOrRange === 'number' ? positionOrRange : positionOrRange.pos;
				const end = typeof positionOrRange === 'number' ? positionOrRange : positionOrRange.end;
				const fixes = getFileFixes(sourceFile.fileName);
				const refactors: ts.ApplicableRefactorInfo[] = [];

				for (const [errorCode, _fixes] of fixes) {
					for (let i = 0; i < _fixes.length; i++) {
						const fix = _fixes[i];
						if (
							(start <= fix.start && end >= fix.end) ||
							(start >= fix.start && start <= fix.end) ||
							(end >= fix.start && end <= fix.end)
						) {
							if (refactors[refactors.length - 1]?.name !== 'tsslint/fix') {
								refactors.push({
									name: 'tsslint/fix',
									description: 'Fix ' + errorCode,
									actions: [],
								});
							}
							refactors[refactors.length - 1].actions.push({
								name: errorCode + '-' + i,
								description: fix.title,
							});
						}
					}
				}

				return refactors;
			},
			fix(sourceFile, refactorName, actionName) {
				if (refactorName === 'tsslint/fix') {
					const errorCode = actionName.substring(0, actionName.lastIndexOf('-'));
					const fixIndex = actionName.substring(actionName.lastIndexOf('-') + 1);
					const fix = getFileFixes(sourceFile.fileName).get(errorCode)![Number(fixIndex)];
					return fix.getEdits();
				}
			},
		};

		function getFileFixes(fileName: string) {
			if (!fileFixes.has(fileName)) {
				fileFixes.set(fileName, new Map());
			}
			return fileFixes.get(fileName)!;
		}
	},
];
const init: ts.server.PluginModuleFactory = (modules) => {
	const { typescript: ts } = modules;
	const pluginModule: ts.server.PluginModule = {
		create(info) {

			const configFile = findConfigFile(info.project.getCurrentDirectory());
			if (!configFile) {
				return info.languageService;
			}

			let loadConfigResult: LoadConfigResult | undefined;
			let plugins: PluginInstance[] = [];

			const languageServiceHost = info.languageServiceHost;
			const languageService = info.languageService;
			const projectContext: ProjectContext = {
				configFile,
				tsconfig: info.project.projectKind === ts.server.ProjectKind.Configured
					? info.project.getProjectName()
					: undefined,
				languageServiceHost: languageServiceHost,
				languageService: languageService,
				typescript: ts,
			};

			decorateLanguageService();

			watchConfig(
				configFile,
				async result => {
					loadConfigResult = result;
					if (loadConfigResult.config) {
						plugins = await Promise.all([
							...basePlugins,
							...loadConfigResult.config.plugins ?? []
						].map(plugin => plugin(projectContext, result)));
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
					const rules = loadConfigResult?.config?.rules ?? {};

					for (const plugin of plugins) {
						if (token?.isCancellationRequested()) {
							break;
						}
						if (plugin.lint) {
							let pluginResult = plugin.lint?.(sourceFile, rules);
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
