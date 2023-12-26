import type { Config, ProjectContext, Reporter, RuleContext } from '@tsslint/config';
import * as ErrorStackParser from 'error-stack-parser';
import type * as ts from 'typescript/lib/tsserverlibrary.js';

export type Linter = ReturnType<typeof createLinter>;

export function createLinter(ctx: ProjectContext, config: Config, withStack: boolean) {
	if (withStack) {
		require('source-map-support').install();
	}
	const ts = ctx.typescript;
	const fileFixes = new Map<string, Map<string, {
		diagnostic: ts.Diagnostic;
		title: string;
		start: number;
		end: number;
		getEdits: () => ts.FileTextChanges[];
	}[]>>();
	const sourceFiles = new Map<string, ts.SourceFile>();
	const configSourceFile = ts.createSourceFile(ctx.configFile, ts.sys.readFile(ctx.configFile) ?? '', ts.ScriptTarget.Latest, true);
	const plugins = (config.plugins ?? []).map(plugin => plugin(ctx));

	let rules = { ...config.rules };

	for (const plugin of plugins) {
		if (plugin.resolveRules) {
			rules = plugin.resolveRules(rules);
		}
	}

	return {
		lint(fileName: string) {
			const sourceFile = ctx.languageService.getProgram()?.getSourceFile(fileName);
			if (!sourceFile) {
				throw new Error(`No source file found for ${fileName}`);
			}

			const rulesContext: RuleContext = {
				...ctx,
				sourceFile,
				reportError,
				reportWarning,
				reportSuggestion,
			};
			const token = ctx.languageServiceHost.getCancellationToken?.();
			const fixes = getFileFixes(sourceFile.fileName);

			let result: ts.Diagnostic[] = [];
			let currentRuleId: string;

			fixes.clear();

			for (const [id, rule] of Object.entries(rules)) {
				if (token?.isCancellationRequested()) {
					break;
				}
				currentRuleId = id;
				rule(rulesContext);
			}

			for (const plugin of plugins) {
				if (plugin.resolveDiagnostics) {
					result = plugin.resolveDiagnostics(result);
				}
			}

			return result;

			function reportError(message: string, start: number, end: number, trace = true) {
				return report(ts.DiagnosticCategory.Error, message, start, end, trace);
			}

			function reportWarning(message: string, start: number, end: number, trace = true) {
				return report(ts.DiagnosticCategory.Warning, message, start, end, trace);
			}

			function reportSuggestion(message: string, start: number, end: number, trace = true) {
				return report(ts.DiagnosticCategory.Suggestion, message, start, end, trace);
			}

			function report(category: ts.DiagnosticCategory, message: string, start: number, end: number, trace: boolean): Reporter {

				const error: ts.Diagnostic = {
					category,
					code: currentRuleId as any,
					messageText: message,
					file: sourceFile,
					start,
					length: end - start,
					source: 'tsslint',
					relatedInformation: [],
				};
				const stacks = trace ? ErrorStackParser.parse(new Error()) : [];

				if (stacks.length >= 3) {
					const stack = stacks[2];
					if (stack.fileName && stack.lineNumber !== undefined && stack.columnNumber !== undefined) {
						let fileName = stack.fileName.replace(/\\/g, '/');
						if (fileName.startsWith('file://')) {
							fileName = fileName.substring('file://'.length);
						}
						if (!sourceFiles.has(fileName)) {
							const text = ctx.languageServiceHost.readFile(fileName) ?? '';
							sourceFiles.set(
								fileName,
								ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true),
							);
						}
						const stackFile = sourceFiles.get(fileName)!;
						const pos = stackFile?.getPositionOfLineAndCharacter(stack.lineNumber - 1, stack.columnNumber - 1);
						if (withStack) {
							error.relatedInformation?.push({
								category: ts.DiagnosticCategory.Message,
								code: 0,
								file: stackFile,
								start: pos,
								length: 0,
								messageText: '',
							});
							error.relatedInformation?.push({
								category: ts.DiagnosticCategory.Message,
								code: 0,
								file: configSourceFile,
								start: 0,
								length: 0,
								messageText: '',
							});
						}
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
							diagnostic: error,
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
		getCodeFixes(fileName: string, start: number, end: number, diagnostics?: ts.Diagnostic[]) {

			const fixesMap = getFileFixes(fileName);

			let result: ts.CodeFixAction[] = [];

			for (const [_ruleId, fixes] of fixesMap) {
				for (let i = 0; i < fixes.length; i++) {
					const fix = fixes[i];
					if (diagnostics && !diagnostics.includes(fix.diagnostic)) {
						continue;
					}
					if (
						(fix.start >= start && fix.start <= end) ||
						(fix.end >= start && fix.end <= end) ||
						(start >= fix.start && start <= fix.end) ||
						(end >= fix.start && end <= fix.end)
					) {
						result.push({
							fixName: `tsslint: ${fix.title}`,
							description: fix.title,
							changes: fix.getEdits(),
						});
					}
				}
			}

			for (const plugin of plugins) {
				if (plugin.resolveCodeFixes) {
					result = plugin.resolveCodeFixes(result);
				}
			}

			return result;
		},
	};

	function getFileFixes(fileName: string) {
		if (!fileFixes.has(fileName)) {
			fileFixes.set(fileName, new Map());
		}
		return fileFixes.get(fileName)!;
	}
}
