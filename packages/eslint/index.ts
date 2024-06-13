import type * as TSSLint from '@tsslint/types';
import { analyze } from '@typescript-eslint/scope-manager';
import type { TSESTree } from '@typescript-eslint/typescript-estree';
import * as ESLint from 'eslint';
import type * as ts from 'typescript';
import { astConverter } from './node_modules/@typescript-eslint/typescript-estree/dist/ast-converter';
import { createParserServices } from './node_modules/@typescript-eslint/typescript-estree/dist/createParserServices';
import { createParseSettings } from './node_modules/@typescript-eslint/typescript-estree/dist/parseSettings/createParseSettings';
import { simpleTraverse } from './node_modules/@typescript-eslint/typescript-estree/dist/simple-traverse';

export function convertRule(
	rule: ESLint.Rule.RuleModule,
	options: any[] = [],
	severity: ts.DiagnosticCategory = 2
): TSSLint.Rule {
	return ({ typescript: ts, sourceFile, languageService, reportError, reportWarning, reportSuggestion }) => {
		const report =
			severity === ts.DiagnosticCategory.Error ? reportError
				: severity === ts.DiagnosticCategory.Warning ? reportWarning
					: reportSuggestion;
		const { estree, astMaps } = astConverter(
			sourceFile,
			createParseSettings(sourceFile, {
				comment: true,
				tokens: true,
				range: true,
				loc: true,
				preserveNodeMaps: true,
				filePath: sourceFile.fileName,
			}),
			true
		);
		const scopeManager = analyze(estree);
		const parserServices = createParserServices(astMaps, languageService.getProgram() ?? null);
		const sourceCode = new ESLint.SourceCode({
			ast: estree as ESLint.AST.Program,
			text: sourceFile.text,
			scopeManager: scopeManager as ESLint.Scope.ScopeManager,
			parserServices,
		});
		// @ts-expect-error
		const ruleListener = rule.create({
			filename: sourceFile.fileName,
			sourceCode,
			options,
			report(descriptor) {
				let message = 'message' in descriptor
					? descriptor.message
					: getMessage(descriptor.messageId);
				message = message.replace(/\{\{(\w+)\}\}/gu, key => {
					return descriptor.data?.[key.slice(2, -2)] ?? key;
				});
				let start = 0;
				let end = 0;
				try {
					if ('loc' in descriptor) {
						if ('line' in descriptor.loc) {
							start = sourceFile.getPositionOfLineAndCharacter(descriptor.loc.line - 1, descriptor.loc.column);
							end = start;
						}
						else {
							start = sourceFile.getPositionOfLineAndCharacter(descriptor.loc.start.line - 1, descriptor.loc.start.column);
							end = sourceFile.getPositionOfLineAndCharacter(descriptor.loc.end.line - 1, descriptor.loc.end.column);
						}
					}
					else if ('node' in descriptor) {
						if (descriptor.node.range) {
							start = descriptor.node.range[0];
							end = descriptor.node.range[1];
						}
						else if (descriptor.node.loc) {
							start = sourceFile.getPositionOfLineAndCharacter(descriptor.node.loc.start.line - 1, descriptor.node.loc.start.column);
							end = sourceFile.getPositionOfLineAndCharacter(descriptor.node.loc.end.line - 1, descriptor.node.loc.end.column);
						}
					}
				} catch { }
				const reporter = report(message, start, end, 1);
				for (const suggest of descriptor.suggest ?? []) {
					const message = 'messageId' in suggest
						? getMessage(suggest.messageId)
						: 'Fix TSSLint error';
					addFix(reporter, message, suggest.fix);
				}
				if (descriptor.fix) {
					addFix(reporter, 'Fix TSSLint error', descriptor.fix);
				}
			},
		});
		const visitors: Record<string, (node: TSESTree.Node, parent: TSESTree.Node | undefined) => void> = {};
		const visitorCbs: Record<string, {
			isFilter?: {
				key: string;
				value: string;
			};
			isNotFilter?: {
				key: string;
				value: string;
			};
			cb: (node: TSESTree.Node) => void;
		}[]> = {};
		for (const rawSelector in ruleListener) {
			const selectors = rawSelector
				.split(',')
				.map(selector => selector.trim().replace(/:exit$/u, ''));
			for (let selector of selectors) {
				const isFilter = selector.match(/\[(?<key>[^=\s]+)\s*=\s*(?<value>[^\]]+)\]/u)?.groups;
				const isNotFilter = selector.match(/\[(?<key>[^=\s]+)\s*!=\s*(?<value>[^\]]+)\]/u)?.groups;
				if (isFilter || isNotFilter) {
					selector = selector.replace(/\[(?:[^=\s]+)\s*(?:=\s*[^\]]+|!=\s*[^\]]+)\]/u, '');
				}
				visitorCbs[selector] ??= [];
				visitorCbs[selector].push({
					isFilter: isFilter ? {
						key: isFilter['key'],
						value: JSON.parse(isFilter['value']),
					} : undefined,
					isNotFilter: isNotFilter ? {
						key: isNotFilter['key'],
						value: JSON.parse(isNotFilter['value']),
					} : undefined,
					// @ts-expect-error
					cb: ruleListener[rawSelector],
				});
				visitors[selector] ??= node => {
					for (const { cb, isFilter, isNotFilter } of visitorCbs[selector]) {
						if (isFilter && node[isFilter.key as keyof TSESTree.Node] !== isFilter.value) {
							continue;
						}
						if (isNotFilter && node[isNotFilter.key as keyof TSESTree.Node] === isNotFilter.value) {
							continue;
						}
						try {
							['test', 'argument', 'left', 'right'].forEach(key => {
								// monkey-fix for @typescript-eslint/strict-boolean-expressions
								// @ts-expect-error
								if (key in node && node[key] && !node[key].parent) {
									// @ts-expect-error
									node[key].parent = node;
								}
							});
							cb(node);
						} catch (err) {
							console.error(err);
						}
					}
				};
			}
		}
		simpleTraverse(estree, { visitors }, true);

		function addFix(reporter: TSSLint.Reporter, title: string, fix: ESLint.Rule.ReportFixer) {
			reporter.withFix(
				title,
				() => {
					const fixes = fix({
						insertTextAfter(nodeOrToken, text) {
							if (!nodeOrToken.loc?.end) {
								throw new Error('Cannot insert text after a node without a location.');
							}
							const start = sourceFile.getPositionOfLineAndCharacter(nodeOrToken.loc.end.line - 1, nodeOrToken.loc.end.column);
							return this.insertTextAfterRange([start, start], text);
						},
						insertTextAfterRange(range, text) {
							return {
								text,
								range: [range[1], range[1]],
							};
						},
						insertTextBefore(nodeOrToken, text) {
							if (!nodeOrToken.loc?.start) {
								throw new Error('Cannot insert text before a node without a location.');
							}
							const start = sourceFile.getPositionOfLineAndCharacter(nodeOrToken.loc.start.line - 1, nodeOrToken.loc.start.column);
							return this.insertTextBeforeRange([start, start], text);
						},
						insertTextBeforeRange(range, text) {
							return {
								text,
								range: [range[0], range[0]],
							};
						},
						remove(nodeOrToken) {
							if (!nodeOrToken.loc) {
								throw new Error('Cannot remove a node without a location.');
							}
							const start = sourceFile.getPositionOfLineAndCharacter(nodeOrToken.loc.start.line - 1, nodeOrToken.loc.start.column);
							const end = sourceFile.getPositionOfLineAndCharacter(nodeOrToken.loc.end.line - 1, nodeOrToken.loc.end.column);
							return this.removeRange([start, end]);
						},
						removeRange(range) {
							return {
								text: '',
								range,
							};
						},
						replaceText(nodeOrToken, text) {
							if (!nodeOrToken.loc) {
								throw new Error('Cannot replace text of a node without a location.');
							}
							const start = sourceFile.getPositionOfLineAndCharacter(nodeOrToken.loc.start.line - 1, nodeOrToken.loc.start.column);
							const end = sourceFile.getPositionOfLineAndCharacter(nodeOrToken.loc.end.line - 1, nodeOrToken.loc.end.column);
							return this.replaceTextRange([start, end], text);
						},
						replaceTextRange(range, text) {
							return {
								text,
								range,
							};
						},
					});
					const textChanges: ts.TextChange[] = [];
					if (fixes && 'text' in fixes) {
						textChanges.push({
							newText: fixes.text,
							span: {
								start: fixes.range[0],
								length: fixes.range[1] - fixes.range[0],
							},
						});
					}
					else if (fixes) {
						for (const fix of fixes) {
							textChanges.push({
								newText: fix.text,
								span: {
									start: fix.range[0],
									length: fix.range[1] - fix.range[0],
								},
							});
						}
					}
					return [{
						fileName: sourceFile.fileName,
						textChanges,
					}];
				}
			);
		}

		function getMessage(messageId: string) {
			return rule.meta?.messages?.[messageId] ?? '';
		}
	};
}
