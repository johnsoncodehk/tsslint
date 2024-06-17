import type * as TSSLint from '@tsslint/types';
import type * as ESLint from 'eslint';
import type * as ts from 'typescript';

import ScopeManager = require('@typescript-eslint/scope-manager');
import path = require('path');
import eslint = require('eslint');

const estreeModuleDir = path.dirname(require.resolve('@typescript-eslint/typescript-estree/package.json'));
const eslintModuleDir = path.dirname(require.resolve('eslint/package.json'));

// TS-ESLint internal scripts
const astConverter = require(path.resolve(estreeModuleDir, 'dist', 'ast-converter.js')).astConverter;
const createParserServices = require(path.resolve(estreeModuleDir, 'dist', 'createParserServices.js')).createParserServices;
const createParseSettings = require(path.resolve(estreeModuleDir, 'dist', 'parseSettings', 'createParseSettings.js')).createParseSettings;

// ESLint internal scripts
const createEmitter = require(path.resolve(eslintModuleDir, 'lib', 'linter', 'safe-emitter.js'));
const NodeEventGenerator = require(path.resolve(eslintModuleDir, 'lib', 'linter', 'node-event-generator.js'));
const Traverser = require(path.resolve(eslintModuleDir, 'lib', 'shared', 'traverser.js'));

const estrees = new WeakMap<ts.SourceFile, {
	estree: any;
	sourceCode: any;
	eventQueue: any[];
}>();

export function convertRule(
	rule: ESLint.Rule.RuleModule,
	options: any[] = [],
	severity: ts.DiagnosticCategory =
		rule.meta?.type === 'problem' ? 1 satisfies ts.DiagnosticCategory.Error
			: rule.meta?.type === 'suggestion' ? 0 satisfies ts.DiagnosticCategory.Warning
				: rule.meta?.type === 'layout' ? 2 satisfies ts.DiagnosticCategory.Suggestion
					: 3 satisfies ts.DiagnosticCategory.Message,
	context: Partial<ESLint.Rule.RuleContext> = {}
): TSSLint.Rule {
	return ({ typescript: ts, sourceFile, languageService, reportError, reportWarning, reportSuggestion }) => {
		const report =
			severity === ts.DiagnosticCategory.Error ? reportError
				: severity === ts.DiagnosticCategory.Warning ? reportWarning
					: reportSuggestion;
		const { sourceCode, eventQueue } = getEstree(sourceFile, languageService);
		const emitter = createEmitter();

		// @ts-expect-error
		const ruleListeners = rule.create({
			...context,
			filename: sourceFile.fileName,
			physicalFilename: sourceFile.fileName,
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
				const defaultMessage = 'Fix TSSLint error';
				for (const suggest of descriptor.suggest ?? []) {
					const message = 'messageId' in suggest
						? getMessage(suggest.messageId)
						: defaultMessage;
					reporter.withFix(message, convertFix(suggest.fix));
				}
				if (descriptor.fix) {
					reporter.withFix(defaultMessage, convertFix(descriptor.fix));
				}
			},
		});

		for (const selector in ruleListeners) {
			emitter.on(selector, ruleListeners[selector]);
		}

		const eventGenerator = new NodeEventGenerator(emitter, { visitorKeys: sourceCode.visitorKeys, fallback: Traverser.getKeys });

		for (const step of eventQueue) {
			switch (step.kind) {
				case 1: {
					try {
						if (step.phase === 1) {
							eventGenerator.enterNode(step.target);
						} else {
							eventGenerator.leaveNode(step.target);
						}
					} catch (err) {
						throw err;
					}
					break;
				}

				case 2: {
					emitter.emit(step.target, ...step.args);
					break;
				}

				default:
					throw new Error(`Invalid traversal step found: "${step.type}".`);
			}
		}

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

function getEstree(sourceFile: ts.SourceFile, languageService: ts.LanguageService) {
	if (!estrees.has(sourceFile)) {
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
		const eventQueue = sourceCode.traverse(); // parent should fill in this call, but don't consistent-type-imports rule is still broken, and fillParent is still needed
		fillParent(estree);
		estrees.set(sourceFile, { estree, sourceCode, eventQueue });
	}
	return estrees.get(sourceFile)!;
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
