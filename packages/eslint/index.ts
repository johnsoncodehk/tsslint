import type * as TSSLint from '@tsslint/types';
import type { TSESTree } from '@typescript-eslint/typescript-estree';
import type * as ESLint from 'eslint';
import type * as ts from 'typescript';

import ScopeManager = require('@typescript-eslint/scope-manager');
import path = require('path');
import eslint = require('eslint');

const estreeModuleDir = path.dirname(require.resolve('@typescript-eslint/typescript-estree/package.json'));
const astConverter = require(path.resolve(estreeModuleDir, 'dist', 'ast-converter.js')).astConverter;
const createParserServices = require(path.resolve(estreeModuleDir, 'dist', 'createParserServices.js')).createParserServices;
const createParseSettings = require(path.resolve(estreeModuleDir, 'dist', 'parseSettings', 'createParseSettings.js')).createParseSettings;
const simpleTraverse = require(path.resolve(estreeModuleDir, 'dist', 'simple-traverse.js')).simpleTraverse;

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
		const scopeManager = ScopeManager.analyze(estree);
		const parserServices = createParserServices(astMaps, languageService.getProgram() ?? null);
		const sourceCode = new eslint.SourceCode({
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
					reporter.withFix(message, convertFix(suggest.fix));
				}
				if (descriptor.fix) {
					reporter.withFix('Fix TSSLint error', convertFix(descriptor.fix));
				}
			},
		});
		const visitors: Record<string, (node: TSESTree.Node, parent: TSESTree.Node | undefined) => void> = {};
		const visitorCbs: Record<string, Record<'enter' | 'exit', {
			filter?: {
				key: string;
				op: '=' | '!=';
				value: string;
			};
			cb: (node: TSESTree.Node) => void;
		}[]>> = {};
		interface Order {
			selector: string;
			node: TSESTree.Node;
			children: Order[];
		}
		const ordersToVisit: Order[] = [];
		for (const rawSelector in ruleListener) {
			const selectors = rawSelector
				.split(',')
				.map(selector => selector.trim());
			for (let selector of selectors) {
				let mode: 'enter' | 'exit' = 'enter';
				if (selector.endsWith(':exit')) {
					mode = 'exit';
					selector = selector.slice(0, -5);
				}
				const filter = selector.match(/\[(?<key>[^!=\s]+)\s*(?<op>=|!=)\s*(?<value>[^\]]+)\]/u)?.groups;
				if (filter) {
					selector = selector.split('[')[0];
				}
				visitorCbs[selector] ??= { enter: [], exit: [] };
				visitorCbs[selector][mode].push({
					filter: filter as any,
					// @ts-expect-error
					cb: ruleListener[rawSelector],
				});
				visitors[selector] ??= node => {
					const parents = new Set();
					let current: TSESTree.Node | undefined = node;
					let parentOrder: Order | undefined;
					while (current) {
						parents.add(current);
						current = current.parent;
					}
					ordersToVisit.forEach(function cb(order) {
						if (parents.has(order.node)) {
							parentOrder = order;
							order.children.forEach(cb);
						}
					});
					if (parentOrder) {
						parentOrder.children.push({ selector, node, children: [] });
					}
					else {
						ordersToVisit.push({ selector, node, children: [] });
					}
				};
			}
		}
		fillParent(estree);
		simpleTraverse(estree, { visitors }, true);

		ordersToVisit.forEach(function cb({ selector, node, children }) {
			for (const { cb, filter } of visitorCbs[selector].enter) {
				if (filter?.op === '=' && node[filter.key as keyof TSESTree.Node] !== filter.value) {
					continue;
				}
				if (filter?.op === '!=' && node[filter.key as keyof TSESTree.Node] === filter.value) {
					continue;
				}
				try {
					cb(node);
				} catch (err) {
					console.error(err);
				}
			}
			children.forEach(cb);
			for (const { cb, filter } of visitorCbs[selector].exit) {
				if (filter?.op === '=' && node[filter.key as keyof TSESTree.Node] !== filter.value) {
					continue;
				}
				if (filter?.op === '!=' && node[filter.key as keyof TSESTree.Node] === filter.value) {
					continue;
				}
				try {
					cb(node);
				} catch (err) {
					console.error(err);
				}
			}
		});

		function convertFix(fix: ESLint.Rule.ReportFixer) {
			return () => {
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
			};
		}

		function getMessage(messageId: string) {
			return rule.meta?.messages?.[messageId] ?? '';
		}
	};
}

function fillParent(target: any, currentParent?: any): any {
	if ('type' in target) {
		if (!target.parent) {
			target.parent = currentParent;
		}
		currentParent = target;
	}
	for (const key of Object.keys(target)) {
		if (key === 'parent') {
			continue;
		}
		const value = target[key];
		if (value && typeof value === 'object') {
			if (Array.isArray(value)) {
				for (const element of value) {
					if (element && typeof element === 'object') {
						fillParent(element, currentParent);
					}
				}
			}
			else {
				fillParent(value, currentParent);
			}
		}
	}
}
