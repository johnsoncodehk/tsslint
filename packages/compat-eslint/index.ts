import type * as TSSLint from '@tsslint/types';
import type * as ESLint from 'eslint';
import type * as ts from 'typescript';

import path = require('path');

// ESLint internals — these reach into lib/ paths and may break on major ESLint
// upgrades. Resolved on first use so warm runs that hit TSSLint's per-rule
// cache for every file never have to load them.
let eslintInternals: {
	SourceCode: typeof ESLint.SourceCode;
	NodeEventGenerator: any;
	Traverser: { getKeys(node: object): string[] };
} | undefined;
function loadEslintInternals() {
	if (!eslintInternals) {
		const eslintRoot = path.dirname(require.resolve('eslint/package.json'));
		eslintInternals = {
			SourceCode: require(path.join(eslintRoot, 'lib/languages/js/source-code/source-code.js')),
			NodeEventGenerator: require(path.join(eslintRoot, 'lib/linter/node-event-generator.js')),
			Traverser: require(path.join(eslintRoot, 'lib/shared/traverser.js')),
		};
	}
	return eslintInternals;
}

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

	const tsslintRule: TSSLint.Rule = ({ file, report, program }) => {
		if (sharedCache?.file !== file) {
			sharedCache = { file, reports: new Map(), errors: new Map() };
			runSharedTraversal(file, program, sharedCache.reports, sharedCache.errors);
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

// A stripped-down replacement for ESLint's safe-emitter that knows which rule
// each listener belongs to. The per-listener try/catch + "skip if this rule
// already errored" guard runs inline at emit time, so we don't have to wrap
// every (rule × selector × file) listener in its own closure.
function makeRuleEmitter(errors: Map<ESLint.Rule.RuleModule, unknown>) {
	// Flat `[rule, fn, rule, fn, ...]` per event keeps the dispatch loop tight.
	const listeners = new Map<string, unknown[]>();
	let currentRule: ESLint.Rule.RuleModule | undefined;
	return {
		setCurrentRule(rule: ESLint.Rule.RuleModule | undefined) {
			currentRule = rule;
		},
		on(eventName: string, listener: (...args: unknown[]) => void) {
			let arr = listeners.get(eventName);
			if (!arr) {
				listeners.set(eventName, arr = []);
			}
			arr.push(currentRule, listener);
		},
		eventNames() {
			return [...listeners.keys()];
		},
		emit(eventName: string, ...args: unknown[]) {
			const arr = listeners.get(eventName);
			if (!arr) {
				return;
			}
			for (let i = 0; i < arr.length; i += 2) {
				const rule = arr[i] as ESLint.Rule.RuleModule;
				if (errors.has(rule)) {
					continue;
				}
				try {
					(arr[i + 1] as (...a: unknown[]) => void)(...args);
				}
				catch (err) {
					errors.set(rule, err);
				}
			}
		},
	};
}

function runSharedTraversal(
	file: ts.SourceFile,
	program: ts.Program,
	reports: Map<ESLint.Rule.RuleModule, DeferredReport[]>,
	errors: Map<ESLint.Rule.RuleModule, unknown>,
) {
	const { sourceCode, eventQueue } = getEstree(file, program);
	const emitter = makeRuleEmitter(errors);
	const cwd = program.getCurrentDirectory();

	let currentNode: any;

	for (const entry of ruleRegistry.values()) {
		const eslintRule = entry.eslintRule;
		emitter.setCurrentRule(eslintRule);
		// Lazy: rules that don't fire on this file pay no array allocation.
		let myReports: DeferredReport[] | undefined;
		const ruleListeners = eslintRule.create({
			cwd,
			getCwd() {
				return cwd;
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

				if (!myReports) {
					myReports = [];
					reports.set(eslintRule, myReports);
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
			if (listener) {
				emitter.on(selector, listener as (...a: unknown[]) => void);
			}
		}
	}
	emitter.setCurrentRule(undefined);

	const { NodeEventGenerator, Traverser } = loadEslintInternals();
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

// Probe every registered rule's listener selectors so the converter knows
// which TS-only AST node types it must NOT skip — a rule listening on
// `TSAnyKeyword` would never fire if the converter dropped that node.
// Run once per process: rules don't unregister, and the converter is
// re-configured from the default each call.
//
// Limitation: the probe only sees each rule's TOP-LEVEL listener
// selectors. Rules whose visitor body walks INTO a type subtree (e.g.
// `no-unnecessary-type-assertion` listens on `TSAsExpression` then
// reads `node.typeAnnotation.type`) can still null-deref when the
// converter has dropped that subtree. The stubContext below is left
// deliberately bare so any rule that needs real `parserServices` or
// scope state crashes during create() — that triggers the
// ALL_SKIPPABLE fallback, which conservatively preserves every type
// subtree and keeps such rules functional. Strengthening the stub
// would lower probe failure but expose the latent walk-into-skipped
// bug, so it stays minimal until selector-aware can also model
// listener-body reads.
let selectorProbeDone = false;
function ensureSelectorProbe() {
	if (selectorProbeDone) return;
	selectorProbeDone = true;
	const { configureSkipKindsForVisitors, validateSelector, ALL_SKIPPABLE_AST_NODE_TYPES } = require('./lib/skip-type-converter') as typeof import('./lib/skip-type-converter');
	const stubContext: any = {
		cwd: '/',
		getCwd: () => '/',
		filename: '/probe.ts',
		getFilename: () => '/probe.ts',
		physicalFilename: '/probe.ts',
		getPhysicalFilename: () => '/probe.ts',
		sourceCode: undefined,
		getSourceCode: () => undefined,
		settings: {},
		parserOptions: {},
		languageOptions: { parserOptions: {} },
		parserPath: undefined,
		id: 'probe',
		options: [],
		report: () => {},
		getAncestors: () => [],
		getDeclaredVariables: () => [],
		getScope: () => undefined,
		markVariableAsUsed: () => false,
	};
	const selectors: string[] = [];
	for (const entry of ruleRegistry.values()) {
		let listeners: Record<string, unknown> | undefined;
		try {
			listeners = entry.eslintRule.create({
				...stubContext,
				options: entry.options,
				...entry.context,
			}) as Record<string, unknown> | undefined;
		}
		catch {
			// Rule's create() crashed under the bare stub. We can't know
			// what selectors it uses, so be conservative: disable
			// skipping entirely. As noted above, this is also
			// load-bearing for rules that walk into type subtrees from
			// non-skipped listeners.
			configureSkipKindsForVisitors(ALL_SKIPPABLE_AST_NODE_TYPES);
			return;
		}
		if (!listeners) continue;
		for (const sel of Object.keys(listeners)) {
			try {
				validateSelector(sel);
			}
			catch (err) {
				throw new Error(
					`[${entry.id}] invalid selector ${JSON.stringify(sel)}: ${(err as Error).message.split('\n')[0]}`,
				);
			}
			selectors.push(sel);
		}
	}
	configureSkipKindsForVisitors(selectors);
}

function getEstree(file: ts.SourceFile, program: ts.Program) {
	if (cachedEstree?.[0] !== file) {
		// Skip @typescript-eslint/parser: parseForESLint dynamically loads the
		// whole parser package on first call (the heaviest single dep) and just
		// dispatches to typescript-estree's astConverter, which we already have
		// a ts.SourceFile for. Calling it directly avoids the parser require.
		const { visitorKeys } = require('@typescript-eslint/visitor-keys');
		const { SourceCode } = loadEslintInternals();
		const { TsScopeManager } = require('./lib/ts-scope-manager') as typeof import('./lib/ts-scope-manager');

		// `TSSLINT_LAZY_ESTREE=1` switches to the lazy ESTree shim
		// (lib/lazy-estree.ts). It produces byte-identical output to
		// typescript-estree's eager Converter on every file in our test
		// sweep, but materialises children on first read instead of upfront.
		// No selector probing needed (rules see real subtrees, can't
		// null-deref). Default off until perf wins are measured.
		let astMaps: { esTreeNodeToTSNodeMap: WeakMap<object, ts.Node>; tsNodeToESTreeNodeMap: WeakMap<ts.Node, object> };
		let estree: any;
		if (process.env.TSSLINT_LAZY_ESTREE === '1') {
			const { convertLazy } = require('./lib/lazy-estree') as typeof import('./lib/lazy-estree');
			const result = convertLazy(file);
			astMaps = result.astMaps as any;
			estree = result.estree;
			// tokens / comments come from typescript-estree's standalone
			// scanner helpers — neither depends on its Converter, so we
			// can borrow them without doing the eager AST conversion.
			// Rules like no-unnecessary-type-assertion call
			// `sourceCode.getTokenAfter()` and need the tokens array.
			const tseRoot = path.dirname(require.resolve('@typescript-eslint/typescript-estree/package.json'));
			const { convertTokens } = require(tseRoot + '/dist/node-utils.js') as { convertTokens(ast: ts.SourceFile): unknown[] };
			const { convertComments } = require(tseRoot + '/dist/convert-comments.js') as { convertComments(ast: ts.SourceFile): unknown[] };
			estree.tokens = convertTokens(file);
			estree.comments = convertComments(file);
		}
		else {
			const { astConvertSkipTypes } = require('./lib/skip-type-converter') as typeof import('./lib/skip-type-converter');
			ensureSelectorProbe();
			const result = astConvertSkipTypes(file, PARSE_SETTINGS as any, true);
			astMaps = result.astMaps as any;
			estree = result.estree;
		}
		estree.sourceType = (file as { externalModuleIndicator?: unknown }).externalModuleIndicator
			? 'module'
			: 'script';
		const scopeManager = new TsScopeManager(file, program, estree as any, astMaps as any, estree.sourceType);
		const sourceCode = new SourceCode({
			text: file.text,
			ast: estree as unknown as ESLint.AST.Program,
			scopeManager: scopeManager as unknown as ESLint.Scope.ScopeManager,
			visitorKeys,
			parserServices: {
				...astMaps,
				program,
				hasFullTypeInformation: true,
				emitDecoratorMetadata: undefined,
				experimentalDecorators: undefined,
				isolatedDeclarations: undefined,
				getSymbolAtLocation: (node: any) =>
					program.getTypeChecker().getSymbolAtLocation(astMaps.esTreeNodeToTSNodeMap.get(node)!),
				getTypeAtLocation: (node: any) =>
					program.getTypeChecker().getTypeAtLocation(astMaps.esTreeNodeToTSNodeMap.get(node)!),
			},
		});
		const eventQueue = (sourceCode as unknown as { traverse(): any[] }).traverse();
		cachedEstree = [file, sourceCode, eventQueue];
	}
	return {
		sourceCode: cachedEstree[1],
		eventQueue: cachedEstree[2],
	};
}
