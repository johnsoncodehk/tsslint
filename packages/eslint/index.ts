import type * as TSSLint from '@tsslint/types';
import type * as ESLint from 'eslint';
import type * as ts from 'typescript';
import type { ESLintRulesConfig } from './lib/types.js';

export { create as createDisableNextLinePlugin } from './lib/plugins/disableNextLine.js';
export { create as createShowDocsActionPlugin } from './lib/plugins/showDocsAction.js';

const estrees = new WeakMap<ts.SourceFile, {
	estree: any;
	sourceCode: any;
	eventQueue: any[];
}>();

export function convertConfig(
	rulesConfig: ESLintRulesConfig,
	loader = require
) {
	const rules: TSSLint.Rules = {};
	const plugins: Record<string, {
		rules: Record<string, ESLint.Rule.RuleModule>;
	}> = {};
	for (const [rule, severityOrOptions] of Object.entries(rulesConfig)) {
		let rawSeverity: 'error' | 'warn' | 'suggestion' | 'off' | 0 | 1 | 2;
		let options: any[];
		if (Array.isArray(severityOrOptions)) {
			[rawSeverity, ...options] = severityOrOptions;
		}
		else {
			rawSeverity = severityOrOptions;
			options = [];
		}
		let tsSeverity: ts.DiagnosticCategory | undefined;
		if (rawSeverity === 'off' || rawSeverity === 0) {
			tsSeverity = undefined;
		}
		else if (rawSeverity === 'warn' || rawSeverity === 1) {
			tsSeverity = 0 satisfies ts.DiagnosticCategory.Warning;
		}
		else if (rawSeverity === 'error' || rawSeverity === 2) {
			tsSeverity = 1 satisfies ts.DiagnosticCategory.Error;
		}
		else if (rawSeverity === 'suggestion') {
			tsSeverity = 2 satisfies ts.DiagnosticCategory.Suggestion;
		} else {
			tsSeverity = 3 satisfies ts.DiagnosticCategory.Message;
		}
		if (tsSeverity === undefined) {
			rules[rule] = () => {
				// Do nothing
			};
			continue;
		}
		let _rule: TSSLint.Rule | undefined;
		rules[rule] = (...args) => {
			if (!_rule) {
				let ruleModule: ESLint.Rule.RuleModule;
				const slashIndex = rule.indexOf('/');
				if (slashIndex !== -1) {
					const pluginName = rule.startsWith('@')
						? `${rule.slice(0, slashIndex)}/eslint-plugin`
						: `eslint-plugin-${rule.slice(0, slashIndex)}`;
					const ruleName = rule.slice(slashIndex + 1);

					try {
						plugins[pluginName] ??= loader(pluginName);
					} catch (e) {
						_rule = () => { };
						console.log('\n\n', new Error(`Plugin "${pluginName}" does not exist.`));
						return;
					}

					let plugin = plugins[pluginName];
					if ('default' in plugin) {
						// @ts-expect-error
						plugin = plugin.default;
					}
					ruleModule = plugin.rules[ruleName];
					if (!ruleModule) {
						_rule = () => { };
						console.log('\n\n', new Error(`Rule "${ruleName}" does not exist in plugin "${pluginName}".`));
						return;
					}
				}
				else {
					try {
						ruleModule = loader(`../../eslint/lib/rules/${rule}.js`);
					} catch {
						ruleModule = loader(`./node_modules/eslint/lib/rules/${rule}.js`);
					}
				}
				_rule = rules[rule] = convertRule(ruleModule, options, tsSeverity);
			}
			return _rule(...args);
		};
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

	const tsslintRule: TSSLint.Rule = ({ typescript: ts, sourceFile, languageService, languageServiceHost, reportError, reportWarning, reportSuggestion }) => {
		const report =
			severity === ts.DiagnosticCategory.Error ? reportError
				: severity === ts.DiagnosticCategory.Warning ? reportWarning
					: reportSuggestion;
		const { sourceCode, eventQueue } = getEstree(
			sourceFile,
			languageService,
			() => languageServiceHost.getCompilationSettings()
		);
		const emitter = createEmitter();

		if (eslintRule.meta?.defaultOptions) {
			for (let i = 0; i < eslintRule.meta.defaultOptions.length; i++) {
				options[i] ??= eslintRule.meta.defaultOptions[i];
			}
		}

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
				const reporter = report(message, start, end, 3);
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

function getEstree(
	sourceFile: ts.SourceFile,
	languageService: ts.LanguageService,
	getCompilationSettings: () => ts.CompilerOptions
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
			emitDecoratorMetadata: getCompilationSettings().emitDecoratorMetadata ?? false,
			experimentalDecorators: getCompilationSettings().experimentalDecorators ?? false,
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
