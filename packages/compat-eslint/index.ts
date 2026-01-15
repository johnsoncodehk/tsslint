import type * as TSSLint from '@tsslint/types';
import type * as ESLint from 'eslint';
import type * as ts from 'typescript';

const estrees = new WeakMap<ts.SourceFile, {
	estree: ESLint.AST.Program;
	sourceCode: ESLint.SourceCode;
	eventQueue: any[];
}>();

export function convertRule(
	eslintRule: ESLint.Rule.RuleModule,
	options: any[] = [],
	context: Partial<ESLint.Rule.RuleContext> = {},
	category: ts.DiagnosticCategory = 3 satisfies ts.DiagnosticCategory.Message,
): TSSLint.Rule {
	// ESLint internal scripts
	let createEmitter;
	let NodeEventGenerator;
	let Traverser;
	try {
		createEmitter = require('../../eslint/lib/linter/safe-emitter.js');
		NodeEventGenerator = require('../../eslint/lib/linter/node-event-generator.js');
		Traverser = require('../../eslint/lib/shared/traverser.js');
	}
	catch {
		createEmitter = require(require.resolve('./node_modules/eslint/lib/linter/safe-emitter.js'));
		NodeEventGenerator = require(require.resolve('./node_modules/eslint/lib/linter/node-event-generator.js'));
		Traverser = require(require.resolve('./node_modules/eslint/lib/shared/traverser.js'));
	}

	const tsslintRule: TSSLint.Rule = ({ file, report, ...ctx }) => {
		const { sourceCode, eventQueue } = getEstree(file, () => ctx.program);
		const emitter = createEmitter();

		if (eslintRule.meta?.defaultOptions) {
			for (let i = 0; i < eslintRule.meta.defaultOptions.length; i++) {
				options[i] ??= eslintRule.meta.defaultOptions[i];
			}
		}

		let currentNode: any;

		const ruleListeners = eslintRule.create({
			get cwd() {
				return ctx.program.getCurrentDirectory();
			},
			getCwd() {
				return ctx.program.getCurrentDirectory();
			},
			filename: file.fileName,
			getFilename() {
				return file.fileName;
			},
			physicalFilename: file.fileName,
			getPhysicalFilename() {
				return file.fileName;
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
							start = file.getPositionOfLineAndCharacter(descriptor.loc.line - 1, descriptor.loc.column);
							end = start;
						}
						else {
							start = file.getPositionOfLineAndCharacter(descriptor.loc.start.line - 1, descriptor.loc.start.column);
							end = file.getPositionOfLineAndCharacter(descriptor.loc.end.line - 1, descriptor.loc.end.column);
						}
					}
					else if ('node' in descriptor) {
						if (descriptor.node.range) {
							start = descriptor.node.range[0];
							end = descriptor.node.range[1];
						}
						else if (descriptor.node.loc) {
							start = file.getPositionOfLineAndCharacter(
								descriptor.node.loc.start.line - 1,
								descriptor.node.loc.start.column,
							);
							end = file.getPositionOfLineAndCharacter(
								descriptor.node.loc.end.line - 1,
								descriptor.node.loc.end.column,
							);
						}
					}
				}
				catch {}
				const reporter = report(message, start, end).at(new Error(), 1);

				if (category === 0 satisfies ts.DiagnosticCategory.Warning) {
					reporter.asWarning();
				}
				else if (category === 1 satisfies ts.DiagnosticCategory.Error) {
					reporter.asError();
				}
				else if (category === 2 satisfies ts.DiagnosticCategory.Suggestion) {
					reporter.asSuggestion();
				}

				if (descriptor.fix) {
					// @ts-expect-error
					const textChanges = getTextChanges(descriptor.fix);
					reporter.withFix(
						getTextChangeMessage(textChanges),
						() => [{
							fileName: file.fileName,
							textChanges,
						}],
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
								fileName: file.fileName,
								// @ts-expect-error
								textChanges: getTextChanges(suggest.fix),
							}],
						);
					}
					else {
						// @ts-expect-error
						const textChanges = getTextChanges(suggest.fix);
						reporter.withRefactor(
							getTextChangeMessage(textChanges),
							() => [{
								fileName: file.fileName,
								textChanges,
							}],
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

		const eventGenerator = new NodeEventGenerator(emitter, {
			visitorKeys: sourceCode.visitorKeys,
			fallback: Traverser.getKeys,
		});

		for (const step of eventQueue) {
			switch (step.kind) {
				case 1: {
					try {
						if (step.phase === 1) {
							currentNode = step.target;
							eventGenerator.enterNode(step.target);
						}
						else {
							eventGenerator.leaveNode(step.target);
						}
					}
					catch (err) {
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
				const originalText = file.text.substring(change.span.start, change.span.start + change.span.length);
				if (change.newText.length === 0) {
					return `Remove \`${originalText}\`.`;
				}
				else if (change.span.length === 0) {
					const line = file.getLineAndCharacterOfPosition(change.span.start).line;
					const lineStart = file.getPositionOfLineAndCharacter(line, 0);
					const lineText = file.text.substring(lineStart, change.span.start).trimStart();
					return `Insert \`${change.newText}\` after \`${lineText}\`.`;
				}
			}
			const changes = [...textChanges].sort((a, b) => a.span.start - b.span.start);
			let text = '';
			let newText = '';
			for (let i = 0; i < changes.length; i++) {
				const change = changes[i];
				text += file.text.substring(change.span.start, change.span.start + change.span.length);
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
					const start = file.getPositionOfLineAndCharacter(nodeOrToken.loc.end.line - 1, nodeOrToken.loc.end.column);
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
					const start = file.getPositionOfLineAndCharacter(
						nodeOrToken.loc.start.line - 1,
						nodeOrToken.loc.start.column,
					);
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
					const start = file.getPositionOfLineAndCharacter(
						nodeOrToken.loc.start.line - 1,
						nodeOrToken.loc.start.column,
					);
					const end = file.getPositionOfLineAndCharacter(nodeOrToken.loc.end.line - 1, nodeOrToken.loc.end.column);
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
					const start = file.getPositionOfLineAndCharacter(
						nodeOrToken.loc.start.line - 1,
						nodeOrToken.loc.start.column,
					);
					const end = file.getPositionOfLineAndCharacter(nodeOrToken.loc.end.line - 1, nodeOrToken.loc.end.column);
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
	file: ts.SourceFile,
	getProgram: () => ts.Program,
) {
	if (!estrees.has(file)) {
		let program: ts.Program | undefined;
		let SourceCode;

		const Parser = require('@typescript-eslint/parser');
		try {
			SourceCode = require('../../eslint/lib/languages/js/source-code/source-code.js');
		}
		catch {
			SourceCode = require(require.resolve('./node_modules/eslint/lib/languages/js/source-code/source-code.js'));
		}

		const programProxy = new Proxy({} as ts.Program, {
			get(_target, p, receiver) {
				program ??= getProgram();
				return Reflect.get(program, p, receiver);
			},
		});
		const { ast, scopeManager, visitorKeys, services } = Parser.parseForESLint(file, {
			tokens: true,
			comment: true,
			loc: true,
			range: true,
			preserveNodeMaps: true,
			filePath: file.fileName,
		});
		const sourceCode = new SourceCode({
			text: file.text,
			ast,
			scopeManager,
			visitorKeys,
			parserServices: {
				...services,
				program: programProxy,
				getSymbolAtLocation: (node: any) =>
					programProxy.getTypeChecker().getSymbolAtLocation(services.esTreeNodeToTSNodeMap.get(node)),
				getTypeAtLocation: (node: any) =>
					programProxy.getTypeChecker().getTypeAtLocation(services.esTreeNodeToTSNodeMap.get(node)),
			},
		});
		const eventQueue = sourceCode.traverse();
		estrees.set(file, { estree: ast, sourceCode, eventQueue });
	}
	return estrees.get(file)!;
}
