import type { Plugin, Reporter, RuleContext } from '@tsslint/config';
import * as ErrorStackParser from 'error-stack-parser';
import type * as ts from 'typescript/lib/tsserverlibrary.js';

require('source-map-support').install();

export const builtInPlugins: Plugin[] = [
	ctx => {
		const ts = ctx.typescript;
		const fileFixes = new Map<string, Map<string, {
			title: string;
			start: number;
			end: number;
			getEdits: () => ts.FileTextChanges[];
		}[]>>();
		const sourceFiles = new Map<string, ts.SourceFile>();
		const configSourceFile = ts.createSourceFile(ctx.configFile, ts.sys.readFile(ctx.configFile) ?? '', ts.ScriptTarget.Latest, true);

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
							error.relatedInformation?.push({
								category: ts.DiagnosticCategory.Message,
								code: 0,
								file: stackFile,
								start: pos,
								length: 0,
								messageText: 'Related rule file',
							});
							error.relatedInformation?.push({
								category: ts.DiagnosticCategory.Message,
								code: 0,
								file: configSourceFile,
								start: 0,
								length: 0,
								messageText: 'Related config file',
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
			getFixes(fileName, start, end) {

				const fixesMap = getFileFixes(fileName);
				const result: ts.CodeFixAction[] = [];

				for (const [_errorCode, fixes] of fixesMap) {
					for (let i = 0; i < fixes.length; i++) {
						const fix = fixes[i];
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

				return result;
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
