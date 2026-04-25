import type * as TSSLint from '@tsslint/types';
import type * as ESLint from 'eslint';
import type * as ts from 'typescript';

import path = require('path');

// ESLint internals — these reach into lib/ paths and may break on major ESLint upgrades.
const eslintRoot = path.dirname(require.resolve('eslint/package.json'));
const SourceCode = require(path.join(eslintRoot, 'lib/languages/js/source-code/source-code.js'));
const createEmitter = require(path.join(eslintRoot, 'lib/linter/safe-emitter.js'));
const NodeEventGenerator = require(path.join(eslintRoot, 'lib/linter/node-event-generator.js'));
const Traverser = require(path.join(eslintRoot, 'lib/shared/traverser.js'));

interface RuleEntry {
	id: string;
	eslintRule: ESLint.Rule.RuleModule;
	options: any[];
	context: Partial<ESLint.Rule.RuleContext>;
	category: ts.DiagnosticCategory;
}

interface DeferredReport {
	stackErr: Error;
	message: string;
	start: number;
	end: number;
	category: ts.DiagnosticCategory;
	textChanges?: ts.TextChange[];
	suggestions?: { message: string; textChanges: ts.TextChange[] }[];
}

// Module-level state — populated by convertRule, queried at lint time.
const ruleRegistry = new Map</* eslintRule */ ESLint.Rule.RuleModule, RuleEntry>();

// Per-file shared cache: stash all rules' deferred reports built during a single
// traversal pass; each rule's tsslintRule call replays its own bucket. If a rule
// listener throws, capture it in `errors` so the rule's call can rethrow at
// replay time (preserving TSSLint core's per-rule type-aware retry semantics).
let sharedCache: {
	file: ts.SourceFile;
	reports: Map</* eslintRule */ ESLint.Rule.RuleModule, DeferredReport[]>;
	errors: Map</* eslintRule */ ESLint.Rule.RuleModule, unknown>;
} | undefined;

let cachedEstree: [sourceFile: ts.SourceFile, sourceCode: ESLint.SourceCode, eventQueue: any[]] | undefined;

export function convertRule(
	eslintRule: ESLint.Rule.RuleModule,
	options: any[] = [],
	context: Partial<ESLint.Rule.RuleContext> = {},
	category: ts.DiagnosticCategory = 3 satisfies ts.DiagnosticCategory.Message,
): TSSLint.Rule {
	if (eslintRule.meta?.defaultOptions) {
		for (let i = 0; i < eslintRule.meta.defaultOptions.length; i++) {
			options[i] ??= eslintRule.meta.defaultOptions[i];
		}
	}

	const id = (context as { id?: string }).id ?? 'unknown';
	const entry: RuleEntry = { id, eslintRule, options, context, category };
	ruleRegistry.set(eslintRule, entry);

	const tsslintRule: TSSLint.Rule = ({ file, report, ...ctx }) => {
		if (sharedCache?.file !== file) {
			sharedCache = { file, reports: new Map(), errors: new Map() };
			runSharedTraversal(file, () => ctx.program, sharedCache.reports, sharedCache.errors);
		}

		const ruleError = sharedCache.errors.get(eslintRule);
		if (ruleError !== undefined) {
			throw ruleError;
		}

		const myReports = sharedCache.reports.get(eslintRule);
		if (!myReports || myReports.length === 0) {
			return;
		}

		for (const r of myReports) {
			const reporter = report(r.message, r.start, r.end).at(r.stackErr, 1);
			if (r.category === 0 satisfies ts.DiagnosticCategory.Warning) {
				reporter.asWarning();
			}
			else if (r.category === 1 satisfies ts.DiagnosticCategory.Error) {
				reporter.asError();
			}
			else if (r.category === 2 satisfies ts.DiagnosticCategory.Suggestion) {
				reporter.asSuggestion();
			}
			if (r.textChanges) {
				const tc = r.textChanges;
				reporter.withFix(
					getTextChangeMessage(file, tc),
					() => [{ fileName: file.fileName, textChanges: tc }],
				);
			}
			if (r.suggestions) {
				for (const s of r.suggestions) {
					const tc = s.textChanges;
					reporter.withRefactor(
						s.message,
						() => [{ fileName: file.fileName, textChanges: tc }],
					);
				}
			}
		}
	};
	(tsslintRule as any).meta = eslintRule.meta;
	return tsslintRule;
}

function runSharedTraversal(
	file: ts.SourceFile,
	getProgram: () => ts.Program,
	reports: Map<ESLint.Rule.RuleModule, DeferredReport[]>,
	errors: Map<ESLint.Rule.RuleModule, unknown>,
) {
	const { sourceCode, eventQueue } = getEstree(file, getProgram);
	const emitter = createEmitter();

	let currentNode: any;

	for (const entry of ruleRegistry.values()) {
		const myReports: DeferredReport[] = [];
		reports.set(entry.eslintRule, myReports);

		const eslintRule = entry.eslintRule;
		const ruleListeners = eslintRule.create({
			get cwd() {
				return getProgram().getCurrentDirectory();
			},
			getCwd() {
				return getProgram().getCurrentDirectory();
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
			// Provide nested parserOptions to avoid TypeError in rules that read
			// `context.languageOptions.parserOptions.X` without a guard.
			languageOptions: { parserOptions: {} },
			parserPath: undefined,
			id: entry.id,
			options: entry.options,
			report(descriptor) {
				let message = 'message' in descriptor
					? descriptor.message
					: eslintRule.meta?.messages?.[descriptor.messageId] ?? '';
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
						if (descriptor.node.loc) {
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

				const deferred: DeferredReport = {
					stackErr: new Error(),
					message,
					start,
					end,
					category: entry.category,
				};

				if (descriptor.fix) {
					deferred.textChanges = getTextChanges(file, descriptor.fix as ESLint.Rule.ReportFixer | null | undefined);
				}

				if (descriptor.suggest?.length) {
					deferred.suggestions = [];
					for (const suggest of descriptor.suggest) {
						let suggestMsg: string;
						if ('messageId' in suggest) {
							suggestMsg = eslintRule.meta?.messages?.[suggest.messageId] ?? '';
							suggestMsg = suggestMsg.replace(/\{\{\s*(\w+)\s*\}\}/gu, key => {
								return suggest.data?.[key.slice(2, -2).trim()] ?? key;
							});
						}
						else {
							suggestMsg = '';
						}
						const textChanges = getTextChanges(file, suggest.fix as ESLint.Rule.ReportFixer | null | undefined);
						deferred.suggestions.push({
							message: suggestMsg || getTextChangeMessage(file, textChanges),
							textChanges,
						});
					}
				}

				myReports.push(deferred);
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
			...entry.context,
		});

		for (const selector in ruleListeners) {
			const listener = ruleListeners[selector];
			if (!listener) continue;
			emitter.on(selector, (...args: unknown[]) => {
				if (errors.has(eslintRule)) return;
				try {
					(listener as (...a: unknown[]) => void)(...args);
				}
				catch (err) {
					errors.set(eslintRule, err);
				}
			});
		}
	}

	const eventGenerator = new NodeEventGenerator(emitter, {
		visitorKeys: sourceCode.visitorKeys,
		fallback: Traverser.getKeys,
	});

	for (const step of eventQueue) {
		switch (step.kind) {
			case 1: {
				if (step.phase === 1) {
					currentNode = step.target;
					eventGenerator.enterNode(step.target);
				}
				else {
					eventGenerator.leaveNode(step.target);
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
}

function getTextChangeMessage(file: ts.SourceFile, textChanges: ts.TextChange[]) {
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
			text = text.slice(0, text.length - removeRight);
			newText = newText.slice(0, newText.length - removeRight);
		}
	}
	else {
		removedRight = true;
		text = text.slice(0, text.length - removeRight);
		newText = newText.slice(0, newText.length - removeRight);
		if (text.length + newText.length > 50) {
			removedLeft = true;
			text = text.slice(removeLeft);
			newText = newText.slice(removeLeft);
		}
	}
	return `Replace \`${removedLeft ? '…' : ''}${text}${removedRight ? '…' : ''}\` with \`${
		removedLeft ? '…' : ''
	}${newText}${removedRight ? '…' : ''}\`.`;
}

function getTextChanges(
	_file: ts.SourceFile,
	fix: ESLint.Rule.ReportFixer | null | undefined,
): ts.TextChange[] {
	if (!fix) {
		return [];
	}
	const fixer: ESLint.Rule.RuleFixer = {
		insertTextAfter(nodeOrToken, text) {
			return this.insertTextAfterRange(nodeOrToken.range!, text);
		},
		insertTextAfterRange([, end], text) {
			return { range: [end, end], text };
		},
		insertTextBefore(nodeOrToken, text) {
			return this.insertTextBeforeRange(nodeOrToken.range!, text);
		},
		insertTextBeforeRange([start], text) {
			return { range: [start, start], text };
		},
		remove(nodeOrToken) {
			return this.removeRange(nodeOrToken.range!);
		},
		removeRange([start, end]) {
			return { range: [start, end], text: '' };
		},
		replaceText(nodeOrToken, text) {
			return this.replaceTextRange(nodeOrToken.range!, text);
		},
		replaceTextRange([start, end], text) {
			return { range: [start, end], text };
		},
	};
	const result = fix(fixer);
	if (!result) {
		return [];
	}
	const fixes = isIterable(result) ? [...result] : [result];
	const textChanges: ts.TextChange[] = [];
	for (const f of fixes) {
		textChanges.push({
			span: { start: f.range[0], length: f.range[1] - f.range[0] },
			newText: f.text,
		});
	}
	return textChanges;
}

function isIterable(obj: unknown): obj is Iterable<ESLint.Rule.Fix> {
	return obj != null && typeof (obj as { [Symbol.iterator]?: unknown })[Symbol.iterator] === 'function';
}

// Subset of ParseSettings that astConverter actually reads.
const PARSE_SETTINGS = {
	allowInvalidAST: false,
	comment: true,
	errorOnUnknownASTType: false,
	loc: true,
	range: true,
	suppressDeprecatedPropertyWarnings: true,
	tokens: true,
};

function getEstree(
	file: ts.SourceFile,
	getProgram: () => ts.Program,
) {
	if (cachedEstree?.[0] !== file) {
		let program: ts.Program | undefined;

		// Skip @typescript-eslint/parser: parseForESLint dynamically loads the
		// whole parser package on first call (the heaviest single dep) and just
		// dispatches to typescript-estree's astConverter, which we already have
		// a ts.SourceFile for. Calling it directly avoids the parser require.
		const { astConverter } = require('@typescript-eslint/typescript-estree/use-at-your-own-risk');
		const { analyze } = require('@typescript-eslint/scope-manager');
		const { visitorKeys } = require('@typescript-eslint/visitor-keys');

		const programProxy = new Proxy({} as ts.Program, {
			get(_target, p, receiver) {
				program ??= getProgram();
				return Reflect.get(program, p, receiver);
			},
		});

		// astConverter walks via ts.Node#getText, which needs parent pointers.
		// Type-checking sets these; the syntax-only path may not.
		if (file.statements.length > 0 && file.statements[0].parent !== file) {
			bindTsParents(file);
		}

		const { astMaps, estree } = astConverter(file, PARSE_SETTINGS, true);
		estree.sourceType = (file as { externalModuleIndicator?: unknown }).externalModuleIndicator
			? 'module'
			: 'script';
		const scopeManager = analyze(estree, {
			sourceType: estree.sourceType,
			childVisitorKeys: visitorKeys,
		});
		const sourceCode = new SourceCode({
			text: file.text,
			ast: estree,
			scopeManager,
			visitorKeys,
			parserServices: {
				...astMaps,
				program: programProxy,
				emitDecoratorMetadata: undefined,
				experimentalDecorators: undefined,
				isolatedDeclarations: undefined,
				getSymbolAtLocation: (node: any) =>
					programProxy.getTypeChecker().getSymbolAtLocation(astMaps.esTreeNodeToTSNodeMap.get(node)),
				getTypeAtLocation: (node: any) =>
					programProxy.getTypeChecker().getTypeAtLocation(astMaps.esTreeNodeToTSNodeMap.get(node)),
			},
		});
		const eventQueue = sourceCode.traverse();
		cachedEstree = [file, sourceCode, eventQueue];
	}
	return {
		sourceCode: cachedEstree[1],
		eventQueue: cachedEstree[2],
	};
}

function bindTsParents(node: ts.Node): void {
	node.forEachChild(child => {
		(child as { parent: ts.Node }).parent = node;
		bindTsParents(child);
	});
}
