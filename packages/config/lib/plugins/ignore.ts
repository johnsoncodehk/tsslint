import type { Plugin } from '@tsslint/types';
import { forEachComment } from 'ts-api-utils';
import type * as ts from 'typescript';

interface CommentState {
	used?: boolean;
	commentRange: [number, number];
	nextLine: number;
	lastLine?: number;
}

export function create(
	cmdOption: string | [string, string],
	reportsUnusedComments: boolean
): Plugin {
	const mode = typeof cmdOption === 'string' ? 'singleLine' : 'multiLine';
	const [cmd, endCmd] = Array.isArray(cmdOption) ? cmdOption : [cmdOption, undefined];
	const cmdText = cmd.replace(/\?/g, '');
	const withRuleId = '[ \\t]*(?<ruleId>\\w\\S*)?';
	const ending = '([ \\t]+[^\\r\\n]*)?$';
	const reg = new RegExp(`\\s*${cmd}${withRuleId}${ending}`);
	const endReg = endCmd ? new RegExp(`\\s*${endCmd}${withRuleId}${ending}`) : undefined;
	const completeReg1 = /^\s*\/\/(\s*)([\S]*)?$/;
	const completeReg2 = new RegExp(`//\\s*${cmd}(\\S*)?$`);

	return ({ typescript: ts, languageService }) => {
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
					name: cmdText,
					insertText: matchCmd[1].length ? cmdText : ` ${cmdText}`,
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
				const comments = new Map<string | undefined, CommentState[]>();
				const logs: string[] = [];

				forEachComment(sourceFile, (fullText, { pos, end }) => {
					pos += 2; // Trim the // or /* characters
					const commentText = fullText.substring(pos, end);
					logs.push(commentText);
					const startComment = commentText.match(reg);

					if (startComment?.index !== undefined) {
						const index = startComment.index + pos;
						const nextLine = sourceFile.getLineAndCharacterOfPosition(index).line + 1;
						const ruleId = startComment.groups?.ruleId;

						if (!comments.has(ruleId)) {
							comments.set(ruleId, []);
						}
						const disabledLines = comments.get(ruleId)!;
						disabledLines.push({
							commentRange: [
								index - 2,
								index + startComment[0].length,
							],
							nextLine,
						});
					}
					else if (endReg) {
						const endComment = commentText.match(endReg);

						if (endComment?.index !== undefined) {
							const index = endComment.index + pos;
							const prevLine = sourceFile.getLineAndCharacterOfPosition(index).line - 1;
							const ruleId = endComment.groups?.ruleId;

							const disabledLines = comments.get(ruleId);
							if (disabledLines) {
								disabledLines[disabledLines.length - 1].lastLine = prevLine;
							}
						}
					}
				});

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

					for (const code of [undefined, error.code]) {
						const states = comments.get(code as any);
						if (states) {
							if (mode === 'singleLine') {
								if (states.some(({ nextLine }) => nextLine === line)) {
									for (const state of states) {
										if (state.nextLine === line) {
											state.used = true;
											break;
										}
									}
									return false;
								}
							} else {
								if (states.some(({ nextLine, lastLine }) => line >= nextLine && line <= (lastLine ?? Number.MAX_VALUE))) {
									for (const state of states) {
										if (line >= state.nextLine && line <= (state.lastLine ?? Number.MAX_VALUE)) {
											state.used = true;
											break;
										}
									}
									return false;
								}
							}
						}
					}
					return true;
				});
				if (reportsUnusedComments) {
					for (const comment of comments.values()) {
						for (const state of comment.values()) {
							if (!state.used) {
								results.push({
									file: sourceFile,
									start: state.commentRange[0],
									length: state.commentRange[1] - state.commentRange[0],
									code: 'tsslint:unused-ignore-comment' as any,
									messageText: `Unused comment.`,
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
					description: `Ignore with ${cmdText}`,
					changes: [
						{
							fileName: sourceFile.fileName,
							textChanges: [{
								newText: reg.test(`${cmdText}${diagnostic.code}`)
									? `// ${cmdText}${diagnostic.code}\n`
									: `// ${cmdText} ${diagnostic.code}\n`,
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
