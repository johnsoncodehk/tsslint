import type { Plugin } from '@tsslint/types';
import type * as ts from 'typescript';

interface CommentState {
	used?: boolean;
	start: number;
	end: number;
}

export function create(cmd: string, reportsUnusedComments: boolean): Plugin {
	return ({ typescript: ts, languageService }) => {
		const reg = new RegExp(`//\\s*${cmd}\\b[ \\t]*(?<ruleId>\\S*)\\b`, 'g');
		const completeReg1 = /^\s*\/\/(\s*)([\S]*)?$/;
		const completeReg2 = new RegExp(`//\\s*${cmd}\\b[ \\t]*(\\S*)?$`);
		const reportedRulesOfFile = new Map<string, [string, number][]>();
		const { getCompletionsAtPosition } = languageService;

		languageService.getCompletionsAtPosition = (fileName, position, ...rest) => {
			let result = getCompletionsAtPosition(fileName, position, ...rest);

			const sourceFile = languageService.getProgram()?.getSourceFile(fileName);
			if (!sourceFile) {
				return result;
			}

			const reportedRules = reportedRulesOfFile.get(fileName);
			const line = sourceFile.getLineAndCharacterOfPosition(position).line;
			const lineStart = sourceFile.getPositionOfLineAndCharacter(line, 0);
			const prefix = sourceFile.text.slice(lineStart, position);
			const matchCmd = completeReg1
				? prefix.match(completeReg1)
				: undefined;

			if (matchCmd) {
				const nextLineRules = reportedRules?.filter(([, reportedLine]) => reportedLine === line + 1) ?? [];
				const item: ts.CompletionEntry = {
					name: cmd,
					insertText: matchCmd[1].length ? cmd : ` ${cmd}`,
					kind: ts.ScriptElementKind.keyword,
					sortText: 'a',
					replacementSpan: matchCmd[2]
						? {
							start: position - matchCmd[2].length,
							length: matchCmd[2].length,
						}
						: undefined,
					labelDetails: {
						description: nextLineRules.length >= 2
							? `Ignore ${nextLineRules.length} issues in next line`
							: nextLineRules.length
								? 'Ignore 1 issue in next line'
								: undefined,
					}
				};
				if (result) {
					result.entries.push(item);
				} else {
					result = {
						isGlobalCompletion: false,
						isMemberCompletion: false,
						isNewIdentifierLocation: false,
						entries: [item],
					};
				}
			} else if (reportedRules?.length) {
				const matchRule = completeReg2
					? prefix.match(completeReg2)
					: undefined;
				if (matchRule) {
					const visited = new Set<string>();
					for (const [ruleId] of reportedRules) {
						if (visited.has(ruleId)) {
							continue;
						}
						visited.add(ruleId);

						const reportedLines = reportedRules
							.filter(([r]) => r === ruleId)
							.map(([, l]) => l + 1);
						const item: ts.CompletionEntry = {
							name: ruleId,
							kind: ts.ScriptElementKind.keyword,
							sortText: ruleId,
							replacementSpan: matchRule[1]
								? {
									start: position - matchRule[1].length,
									length: matchRule[1].length,
								}
								: undefined,
							labelDetails: {
								description: `Reported in line${reportedLines.length >= 2 ? 's' : ''} ${reportedLines.join(', ')}`,
							},
						};
						if (result) {
							result.entries.push(item);
						} else {
							result = {
								isGlobalCompletion: false,
								isMemberCompletion: false,
								isNewIdentifierLocation: false,
								entries: [item],
							};
						}
					}
				}
			}

			return result;
		};

		return {
			resolveDiagnostics(sourceFile, results) {
				if (
					!reportsUnusedComments &&
					!results.some(error => error.source === 'tsslint')
				) {
					return results;
				}
				const disabledLines = new Map<number, CommentState>();
				const disabledLinesByRules = new Map<string, Map<number, CommentState>>();
				for (const comment of sourceFile.text.matchAll(reg)) {
					const line = sourceFile.getLineAndCharacterOfPosition(comment.index).line + 1;
					const ruleId = comment.groups?.ruleId;
					if (ruleId) {
						if (!disabledLinesByRules.has(ruleId)) {
							disabledLinesByRules.set(ruleId, new Map());
						}
						disabledLinesByRules.get(ruleId)!.set(line, {
							start: comment.index,
							end: comment.index + comment[0].length,
						});
					} else {
						disabledLines.set(line, {
							start: comment.index,
							end: comment.index + comment[0].length,
						});
					}
				}

				let reportedRules = reportedRulesOfFile.get(sourceFile.fileName);
				if (!reportedRules) {
					reportedRules = [];
					reportedRulesOfFile.set(sourceFile.fileName, reportedRules);
				}
				reportedRules.length = 0;

				results = results.filter(error => {
					if (error.source !== 'tsslint') {
						return true;
					}
					const line = sourceFile.getLineAndCharacterOfPosition(error.start).line;
					reportedRules.push([error.code as any, line]);
					if (disabledLines.has(line)) {
						disabledLines.get(line)!.used = true;
						return false;
					}
					const disabledLinesByRule = disabledLinesByRules.get(error.code as any);
					if (disabledLinesByRule?.has(line)) {
						disabledLinesByRule.get(line)!.used = true;
						return false;
					}
					return true;
				});
				if (reportsUnusedComments) {
					for (const state of disabledLines.values()) {
						if (!state.used) {
							results.push({
								file: sourceFile,
								start: state.start,
								length: state.end - state.start,
								code: 'tsslint:unused-ignore-comment' as any,
								messageText: `Unused ${cmd} comment.`,
								source: 'tsslint',
								category: 1,
							});
						}
					}
					for (const disabledLinesByRule of disabledLinesByRules.values()) {
						for (const state of disabledLinesByRule.values()) {
							if (!state.used) {
								results.push({
									file: sourceFile,
									start: state.start,
									length: state.end - state.start,
									code: 'tsslint:unused-ignore-comment' as any,
									messageText: `Unused ${cmd} comment.`,
									source: 'tsslint',
									category: 1,
								});
							}
						}
					}
				}
				return results;
			},
			resolveCodeFixes(sourceFile, diagnostic, codeFixes) {
				if (diagnostic.source !== 'tsslint' || diagnostic.start === undefined) {
					return codeFixes;
				}
				const line = sourceFile.getLineAndCharacterOfPosition(diagnostic.start).line;
				codeFixes.push({
					fixName: cmd,
					description: `Ignore with ${cmd}`,
					changes: [
						{
							fileName: sourceFile.fileName,
							textChanges: [{
								newText: `// ${cmd} ${diagnostic.code}\n`,
								span: {
									start: sourceFile.getPositionOfLineAndCharacter(line, 0),
									length: 0,
								},
							}],
						},
					],
				});
				return codeFixes;
			},
		};
	};
}
