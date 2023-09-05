import * as ErrorStackParser from 'error-stack-parser';
import type * as ts from 'typescript/lib/tsserverlibrary.js';
import { loadConfig, Config, ProjectContext, Reporter, RuleContext } from 'tsslint';

const sourceFiles = new Map<string, ts.SourceFile>();

const init: ts.server.PluginModuleFactory = (modules) => {
	const { typescript: ts } = modules;
	const pluginModule: ts.server.PluginModule = {
		create(info) {

			let config: Config | undefined;

			const languageServiceHost = info.languageServiceHost;
			const languageService = info.languageService;
			const fileFixes = new Map<string, Map<string, {
				title: string;
				start: number;
				end: number;
				getEdits: () => ts.FileTextChanges[];
			}[]>>();

			load();

			return {
				...info.languageService,
				getSemanticDiagnostics: fileName => {

					let currentRuleId: string;
					let errors = languageService.getSemanticDiagnostics(fileName);

					const sourceFile = info.languageService.getProgram()?.getSourceFile(fileName);
					if (!sourceFile) {
						return errors;
					}

					const fixes = getFileFixes(fileName);
					const token = languageServiceHost.getCancellationToken?.();
					const rulesContext: RuleContext = {
						sourceFile,
						languageServiceHost: languageServiceHost,
						languageService: languageService,
						typescript: ts,
						reportError,
						reportWarning,
						reportSuggestion,
					};
					const projectContext: ProjectContext = {
						tsconfig: info.project.projectKind === ts.server.ProjectKind.Configured
							? info.project.getProjectName()
							: undefined,
						languageServiceHost: languageServiceHost,
						languageService: languageService,
						typescript: ts,
					};

					fixes.clear();

					let rules = config?.rules ?? {};

					if (config?.resolveRules) {
						rules = config.resolveRules(projectContext, rules);
					}

					for (const [id, rule] of Object.entries(rules)) {
						if (token?.isCancellationRequested()) {
							break;
						}
						currentRuleId = id;
						rule(rulesContext);
					}

					if (config?.resolveResults) {
						errors = config.resolveResults(projectContext, errors);
					}

					return errors;

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
											languageServiceHost.readFile(fileName)!,
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

						errors.push(error);

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
				getApplicableRefactors(fileName, positionOrRange, ...rest) {

					const start = typeof positionOrRange === 'number' ? positionOrRange : positionOrRange.pos;
					const end = typeof positionOrRange === 'number' ? positionOrRange : positionOrRange.end;
					const fixes = getFileFixes(fileName);
					const refactors = languageService.getApplicableRefactors(fileName, positionOrRange, ...rest);

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
										description: 'TSSLint Rules Fix',
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
				getEditsForRefactor(fileName, formatOptions, positionOrRange, refactorName, actionName, ...rest) {
					if (refactorName === 'tsslint/fix') {
						const errorCode = actionName.substring(0, actionName.lastIndexOf('-'));
						const fixIndex = actionName.substring(actionName.lastIndexOf('-') + 1);
						const fix = getFileFixes(fileName).get(errorCode)![Number(fixIndex)];
						return { edits: fix.getEdits() };
					}
					else {
						return languageService.getEditsForRefactor(fileName, formatOptions, positionOrRange, refactorName, actionName, ...rest);
					}
				},
			};

			async function load() {
				config = await loadConfig(languageServiceHost.getCurrentDirectory());
				info.project.refreshDiagnostics();
			}

			function getFileFixes(fileName: string) {
				if (!fileFixes.has(fileName)) {
					fileFixes.set(fileName, new Map());
				}
				return fileFixes.get(fileName)!;
			}
		},
	};
	return pluginModule;
};

export = init;
