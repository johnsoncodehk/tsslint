import type * as TSSLint from '@tsslint/types';
import type * as ESLint from 'eslint';
import type * as ts from 'typescript';

import ScopeManager = require('@typescript-eslint/scope-manager');

// TS-ESLint internal scripts
const astConverter: typeof import('./node_modules/@typescript-eslint/typescript-estree/dist/ast-converter.js').astConverter = require('../../@typescript-eslint/typescript-estree/dist/ast-converter.js').astConverter;
const createParserServices: typeof import('./node_modules/@typescript-eslint/typescript-estree/dist/createParserServices.js').createParserServices = require('../../@typescript-eslint/typescript-estree/dist/createParserServices.js').createParserServices;
const createParseSettings: typeof import('./node_modules/@typescript-eslint/typescript-estree/dist/parseSettings/createParseSettings.js').createParseSettings = require('../../@typescript-eslint/typescript-estree/dist/parseSettings/createParseSettings.js').createParseSettings;

// ESLint internal scripts
const SourceCode = require('../../eslint/lib/languages/js/source-code/source-code.js');
const createEmitter = require('../../eslint/lib/linter/safe-emitter.js');
const NodeEventGenerator = require('../../eslint/lib/linter/node-event-generator.js');
const Traverser = require('../../eslint/lib/shared/traverser.js');

const estrees = new WeakMap<ts.SourceFile, {
	estree: any;
	sourceCode: any;
	eventQueue: any[];
}>();

/**
 * @deprecated Use `convertConfig` instead.
 */
export function loadPluginRules(
	rulesConfig: Record<string, any>,
	ruleOptions?: Record<string, any[]>
) {
	return convertConfig(rulesConfig, ruleOptions);
}

export function convertConfig(
	rulesConfig: Record<string, any>,
	ruleOptions?: Record<string, any[]>
) {
	const rules: TSSLint.Rules = {};
	const plugins: Record<string, {
		rules: Record<string, ESLint.Rule.RuleModule>;
	}> = {};
	for (const [rule, severityOrOptions] of Object.entries(rulesConfig)) {
		let severity: string;
		let options: any[];
		if (typeof severityOrOptions === 'string') {
			severity = severityOrOptions;
			options = [];
		}
		else {
			[severity, ...options] = severityOrOptions;
		}
		if (severity === 'off') {
			continue;
		}
		if (!rule.includes('/')) {
			console.warn(`Unhandled rule: ${rule}`);
			continue;
		}
		const [pluginName, ruleName] = rule.split('/');
		const moduleName = pluginName.startsWith('@') ? `${pluginName}/eslint-plugin` : `eslint-plugin-${pluginName}`;
		plugins[pluginName] ??= require(moduleName);
		let plugin = plugins[pluginName];
		if ('default' in plugin) {
			// @ts-expect-error
			plugin = plugin.default;
		}
		const ruleModule = plugin.rules[ruleName];
		if (!ruleModule) {
			console.warn(`Unhandled rule: ${rule}`);
			continue;
		}
		rules[rule] = convertRule(
			ruleModule,
			ruleOptions?.[ruleName] ?? options,
			severity === 'error'
				? 1 satisfies ts.DiagnosticCategory.Error
				: 0 satisfies ts.DiagnosticCategory.Warning
		);
	}
	return rules;
}

export function convertRule(
	eslintRule: ESLint.Rule.RuleModule,
	options: any[] = [],
	severity: ts.DiagnosticCategory =
		eslintRule.meta?.type === 'problem' ? 1 satisfies ts.DiagnosticCategory.Error
			: eslintRule.meta?.type === 'suggestion' ? 0 satisfies ts.DiagnosticCategory.Warning
				: eslintRule.meta?.type === 'layout' ? 2 satisfies ts.DiagnosticCategory.Suggestion
					: 3 satisfies ts.DiagnosticCategory.Message,
	context: Partial<ESLint.Rule.RuleContext> = {}
): TSSLint.Rule {
	const tsslintRule: TSSLint.Rule = ({ typescript: ts, sourceFile, languageService, reportError, reportWarning, reportSuggestion }) => {
		const report =
			severity === ts.DiagnosticCategory.Error ? reportError
				: severity === ts.DiagnosticCategory.Warning ? reportWarning
					: reportSuggestion;
		const { sourceCode, eventQueue } = getEstree(sourceFile, languageService);
		const emitter = createEmitter();

		// @ts-expect-error
		const ruleListeners = eslintRule.create({
			settings: {},
			languageOptions: {},
			filename: sourceFile.fileName,
			physicalFilename: sourceFile.fileName,
			sourceCode,
			options,
			report(descriptor) {
				let message = 'message' in descriptor
					? descriptor.message
					: getMessage(descriptor.messageId);
				message = message.replace(/\{\{\s*(\w+)\s*\}\}/gu, key => {
					return descriptor.data?.[key.slice(2, -2).trim()] ?? key;
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
				if (descriptor.fix) {
					const textChanges = getTextChanges(descriptor.fix);
					reporter.withFix(
						getTextChangeMessage(textChanges),
						() => [{
							fileName: sourceFile.fileName,
							textChanges,
						}]
					);
				}
				for (const suggest of descriptor.suggest ?? []) {
					if ('messageId' in suggest) {
						let message = getMessage(suggest.messageId);
						message = message.replace(/\{\{\s*(\w+)\s*\}\}/gu, key => {
							return suggest.data?.[key.slice(2, -2).trim()] ?? key;
						});
						reporter.withRefactor(
							message,
							() => [{
								fileName: sourceFile.fileName,
								textChanges: getTextChanges(suggest.fix),
							}]
						);
					}
					else {
						const textChanges = getTextChanges(suggest.fix);
						reporter.withRefactor(
							getTextChangeMessage(textChanges),
							() => [{
								fileName: sourceFile.fileName,
								textChanges,
							}]
						);
					}
				}
			},
			...context,
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

		function getTextChangeMessage(textChanges: ts.TextChange[]) {
			if (textChanges.length === 1) {
				const change = textChanges[0];
				const originalText = sourceFile.text.substring(change.span.start, change.span.start + change.span.length);
				if (change.newText.length === 0) {
					return `Remove \`${originalText}\`.`;
				}
				else if (change.span.length === 0) {
					const line = sourceFile.getLineAndCharacterOfPosition(change.span.start).line;
					const lineStart = sourceFile.getPositionOfLineAndCharacter(line, 0);
					const lineText = sourceFile.text.substring(lineStart, change.span.start).trimStart();
					return `Insert \`${change.newText}\` after \`${lineText}\`.`;
				}
			}
			const changes = [...textChanges].sort((a, b) => a.span.start - b.span.start);
			let text = '';
			let newText = '';
			for (let i = 0; i < changes.length; i++) {
				const change = changes[i];
				text += sourceFile.text.substring(change.span.start, change.span.start + change.span.length);
				newText += change.newText;
				if (i !== changes.length - 1) {
					text += '…';
					newText += '…';
				}
			}
			if (text.length + newText.length <= 50) {
				return `Replace \`${text}\` with \`${newText}\`.`;
			}
			let removeLeft = 0;
			let removeRight = 0;
			let removedLeft = false;
			let removedRight = false;
			for (let i = 0; i < text.length && i < newText.length; i++) {
				if (text[i] !== newText[i]) {
					break;
				}
				removeLeft++;
			}
			for (let i = 0; i < text.length && i < newText.length; i++) {
				if (text[text.length - 1 - i] !== newText[newText.length - 1 - i]) {
					break;
				}
				removeRight++;
			}
			if (removeLeft > removeRight) {
				removedLeft = true;
				text = text.slice(removeLeft);
				newText = newText.slice(removeLeft);
				if (text.length + newText.length > 50) {
					removedRight = true;
					text = text.slice(0, -removeRight);
					newText = newText.slice(0, -removeRight);
				}
			}
			else {
				removedRight = true;
				text = text.slice(0, -removeRight);
				newText = newText.slice(0, -removeRight);
				if (text.length + newText.length > 50) {
					removedLeft = true;
					text = text.slice(removeLeft);
					newText = newText.slice(removeLeft);
				}
			}
			if (removedLeft) {
				text = '…' + text;
				newText = '…' + newText;
			}
			if (removedRight) {
				text += '…';
				newText += '…';
			}
			return `Replace \`${text}\` with \`${newText}\`.`;
		}

		function getTextChanges(fix: ESLint.Rule.ReportFixer) {
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
			return textChanges;
		}

		function getMessage(messageId: string) {
			return eslintRule.meta?.messages?.[messageId] ?? '';
		}
	};
	(tsslintRule as any).meta = eslintRule.meta;
	return tsslintRule;
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
		const sourceCode = new SourceCode({
			ast: estree as ESLint.AST.Program,
			text: sourceFile.text,
			scopeManager: scopeManager as ESLint.Scope.ScopeManager,
			parserServices,
		});
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
