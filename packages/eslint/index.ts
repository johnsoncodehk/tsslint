import type * as TSSLint from '@tsslint/types';
import type * as ESLint from 'eslint';
import type * as ts from 'typescript';
import type { ESLintRulesConfig } from './lib/types.js';

export { create as createDisableNextLinePlugin } from './lib/plugins/disableNextLine.js';
export { create as createShowDocsActionPlugin } from './lib/plugins/showDocsAction.js';

const estrees = new WeakMap<ts.SourceFile, {
	estree: ESLint.AST.Program;
	sourceCode: ESLint.SourceCode;
	eventQueue: any[];
}>();
const noop = () => { };
const plugins: Record<string, Promise<{
	rules: Record<string, ESLint.Rule.RuleModule>;
} | undefined>> = {};
const loader = async (moduleName: string) => {
	let mod: {} | undefined;
	try {
		mod ??= require(moduleName);
	} catch { }
	try {
		mod ??= await import(moduleName);
	} catch { }
	if (mod && 'default' in mod) {
		return mod.default;
	}
	return mod as any;
};

type S = 'error' | 'warn' | 'suggestion' | 'off' | 0 | 1 | 2;
type O<T extends any[]> = S | [S, ...options: T];

/**
 * @deprecated Use `defineRules` instead
 */
export async function convertRules(
	rulesConfig: { [K in keyof ESLintRulesConfig]: O<ESLintRulesConfig[K]> },
	context: Partial<ESLint.Rule.RuleContext> = {}
) {
	const rules: TSSLint.Rules = {};
	for (const [rule, severityOrOptions] of Object.entries(rulesConfig)) {
		let severity: boolean;
		let options: any[];
		if (Array.isArray(severityOrOptions)) {
			// @ts-expect-error
			[severity, ...options] = severityOrOptions;
		}
		else {
			// @ts-expect-error
			severity = severityOrOptions;
			options = [];
		}
		// @ts-expect-error backward compatibility
		if (severity === 'off' || severity === 0) {
			severity = false;
		}
		if (!severity) {
			rules[rule] = noop;
			continue;
		}
		const ruleModule = await loadRuleByKey(rule);
		if (!ruleModule) {
			throw new Error(`Failed to resolve rule "${rule}".`);
		}
		rules[rule] = convertRule(
			ruleModule,
			options,
			{ id: rule, ...context }
		);
	}
	return rules;
}

/**
 * Converts an ESLint rules configuration to TSSLint rules.
 *
 * The type definitions are generated when `@tsslint/eslint` is installed.
 * If the type definitions become outdated, please run
 * `node node_modules/@tsslint/eslint/scripts/generateDts.js` to update them.
 */
export async function defineRules(
	rulesConfig: { [K in keyof ESLintRulesConfig]: boolean | ESLintRulesConfig[K] },
	context: Partial<ESLint.Rule.RuleContext> = {}
) {
	const rules: TSSLint.Rules = {};
	for (const [rule, severityOrOptions] of Object.entries(rulesConfig)) {
		let severity: boolean;
		let options: any[];
		if (Array.isArray(severityOrOptions)) {
			severity = true;
			options = severityOrOptions;
		}
		else {
			severity = severityOrOptions;
			options = [];
		}
		if (!severity) {
			rules[rule] = noop;
			continue;
		}
		const ruleModule = await loadRuleByKey(rule);
		if (!ruleModule) {
			throw new Error(`Failed to resolve rule "${rule}".`);
		}
		rules[rule] = convertRule(
			ruleModule,
			options,
			{ id: rule, ...context }
		);
	}
	return rules;
}

function* resolveRuleKey(rule: string): Generator<[
	pluginName: string | undefined,
	ruleName: string,
]> {
	const slashIndex = rule.indexOf('/');
	if (slashIndex !== -1) {
		let pluginName = rule.startsWith('@')
			? `${rule.slice(0, slashIndex)}/eslint-plugin`
			: `eslint-plugin-${rule.slice(0, slashIndex)}`;
		let ruleName = rule.slice(slashIndex + 1);

		yield [pluginName, ruleName];

		if (ruleName.indexOf('/') >= 0) {
			pluginName += `-${ruleName.slice(0, ruleName.indexOf('/'))}`;
			ruleName = ruleName.slice(ruleName.indexOf('/') + 1);
			yield [pluginName, ruleName];
		}
	}
	else {
		yield [undefined, rule];
	}
}

async function loadRuleByKey(rule: string): Promise<ESLint.Rule.RuleModule | undefined> {
	for (const resolved of resolveRuleKey(rule)) {
		const ruleModule = await loadRule(...resolved);
		if (ruleModule) {
			return ruleModule;
		}
	}
}

async function loadRule(pluginName: string | undefined, ruleName: string): Promise<ESLint.Rule.RuleModule | undefined> {
	if (pluginName) {
		plugins[pluginName] ??= loader(pluginName);
		const plugin = await plugins[pluginName];
		return plugin?.rules[ruleName];
	}
	try {
		return require(`../../eslint/lib/rules/${ruleName}.js`);
	} catch {
		return require(`./node_modules/eslint/lib/rules/${ruleName}.js`);
	}
}

export function convertRule(
	eslintRule: ESLint.Rule.RuleModule,
	options: any[] = [],
	context: Partial<ESLint.Rule.RuleContext> = {}
): TSSLint.Rule {
	// ESLint internal scripts
	let createEmitter;
	let NodeEventGenerator;
	let Traverser;
	try {
		createEmitter = require('../../eslint/lib/linter/safe-emitter.js');
		NodeEventGenerator = require('../../eslint/lib/linter/node-event-generator.js');
		Traverser = require('../../eslint/lib/shared/traverser.js');
	} catch {
		createEmitter = require(require.resolve('./node_modules/eslint/lib/linter/safe-emitter.js'));
		NodeEventGenerator = require(require.resolve('./node_modules/eslint/lib/linter/node-event-generator.js'));
		Traverser = require(require.resolve('./node_modules/eslint/lib/shared/traverser.js'));
	}

	const tsslintRule: TSSLint.Rule = ({ sourceFile, languageService, languageServiceHost, report }) => {
		const { sourceCode, eventQueue } = getEstree(
			sourceFile,
			languageService,
			languageServiceHost.getCompilationSettings()
		);
		const emitter = createEmitter();

		if (eslintRule.meta?.defaultOptions) {
			for (let i = 0; i < eslintRule.meta.defaultOptions.length; i++) {
				options[i] ??= eslintRule.meta.defaultOptions[i];
			}
		}

		let currentNode: any;

		const cwd = languageServiceHost.getCurrentDirectory();
		const ruleListeners = eslintRule.create({
			cwd,
			getCwd() {
				return cwd;
			},
			filename: sourceFile.fileName,
			getFilename() {
				return sourceFile.fileName;
			},
			physicalFilename: sourceFile.fileName,
			getPhysicalFilename() {
				return sourceFile.fileName;
			},
			sourceCode,
			getSourceCode() {
				return sourceCode;
			},
			settings: {},
			parserOptions: {},
			languageOptions: {},
			parserPath: undefined,
			id: 'unknown',
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
				const reporter = report(message, start, end, 2);
				if (descriptor.fix) {
					// @ts-expect-error
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
								// @ts-expect-error
								textChanges: getTextChanges(suggest.fix),
							}]
						);
					}
					else {
						// @ts-expect-error
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
			getAncestors() {
				return sourceCode.getAncestors(currentNode);
			},
			getDeclaredVariables(node) {
				return sourceCode.getDeclaredVariables(node);
			},
			getScope() {
				return sourceCode.getScope(currentNode);
			},
			markVariableAsUsed(name) {
				return sourceCode.markVariableAsUsed(name, currentNode);
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
							currentNode = step.target;
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

		function getTextChanges(fix: ESLint.Rule.ReportFixer | null | undefined) {
			const fixes = fix?.({
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

function getEstree(
	sourceFile: ts.SourceFile,
	languageService: ts.LanguageService,
	compilationSettings: ts.CompilerOptions
) {
	if (!estrees.has(sourceFile)) {
		let program: ts.Program | undefined;
		let SourceCode;

		const Parser = require('@typescript-eslint/parser');
		try {
			SourceCode = require('../../eslint/lib/languages/js/source-code/source-code.js');
		} catch {
			SourceCode = require(require.resolve('./node_modules/eslint/lib/languages/js/source-code/source-code.js'));
		}

		const programProxy = new Proxy({} as ts.Program, {
			get(_target, p, receiver) {
				program ??= languageService.getProgram()!;
				return Reflect.get(program, p, receiver);
			},
		});
		const { ast, scopeManager, visitorKeys, services } = Parser.parseForESLint(sourceFile, {
			tokens: true,
			comment: true,
			loc: true,
			range: true,
			preserveNodeMaps: true,
			filePath: sourceFile.fileName,
			emitDecoratorMetadata: compilationSettings.emitDecoratorMetadata ?? false,
			experimentalDecorators: compilationSettings.experimentalDecorators ?? false,
		});
		const sourceCode = new SourceCode({
			text: sourceFile.text,
			ast,
			scopeManager,
			visitorKeys,
			parserServices: {
				...services,
				program: programProxy,
				getSymbolAtLocation: (node: any) => programProxy.getTypeChecker().getSymbolAtLocation(services.esTreeNodeToTSNodeMap.get(node)),
				getTypeAtLocation: (node: any) => programProxy.getTypeChecker().getTypeAtLocation(services.esTreeNodeToTSNodeMap.get(node)),
			},
		});
		const eventQueue = sourceCode.traverse();
		estrees.set(sourceFile, { estree: ast, sourceCode, eventQueue });
	}
	return estrees.get(sourceFile)!;
}
