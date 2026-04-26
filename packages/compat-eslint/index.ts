import type * as TSSLint from '@tsslint/types';
import type * as ESLint from 'eslint';
import type * as ts from 'typescript';

import path = require('path');

// ESLint internals — these reach into lib/ paths and may break on major
// ESLint upgrades. Resolved on first use so warm runs that hit TSSLint's
// per-rule cache for every file never have to load them. We only keep
// what fast-dispatch + CPA-aware TS-scan actually need: `SourceCode` to
// build the rule's `sourceCode` view of the lazy ESTree, and
// `CodePathAnalyzer` to drive `onCodePath*` events from the inline
// visitor. NodeEventGenerator and Traverser are no longer used anywhere.
let eslintInternals: {
	SourceCode: typeof ESLint.SourceCode;
	CodePathAnalyzer: new (eventGenerator: {
		emitter: { emit(name: string, ...args: unknown[]): void };
		enterNode(node: unknown): void;
		leaveNode(node: unknown): void;
	}) => { enterNode(node: unknown): void; leaveNode(node: unknown): void };
} | undefined;
function loadEslintInternals() {
	if (!eslintInternals) {
		const eslintRoot = path.dirname(require.resolve('eslint/package.json'));
		eslintInternals = {
			SourceCode: require(path.join(eslintRoot, 'lib/languages/js/source-code/source-code.js')),
			CodePathAnalyzer: require(path.join(eslintRoot, 'lib/linter/code-path-analysis/code-path-analyzer.js')),
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

// sourceCode cache is per-file. The eventQueue itself is no longer
// cached — every call to `runSharedTraversal` rebuilds it from the TS
// AST scan, since the path now serves both CPA and non-CPA modes
// uniformly (CPA's per-walk state can't be replayed from a stale queue
// anyway). `convertContext` is kept so the TS-scan path can call
// `materialize(tsNode, context)` for each hit without rebuilding the
// converter state.
let cachedEstree: {
	file: ts.SourceFile;
	sourceCode: ESLint.SourceCode;
	convertContext: unknown;
} | undefined;

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
	const { sourceCode } = getEstree(file, program);
	const emitter = makeRuleEmitter(errors);
	const cwd = program.getCurrentDirectory();

	let currentNode: any;
	// (rule, selector, listener) triples — used to build fast dispatch
	// tables when every selector is simple. Parallel to emitter.on().
	const allListeners: Array<[ESLint.Rule.RuleModule, string, (n: unknown) => void]> = [];

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
				allListeners.push([eslintRule, selector, listener as (n: unknown) => void]);
			}
		}
	}
	emitter.setCurrentRule(undefined);

	// Fast dispatch is the only path. Every selector decomposes into a
	// (typeSet, fieldFire?, typeFilter?, filter?) tuple via
	// `decomposeSimple`; if it can't, an UnsupportedSelectorError fires
	// — never silent NodeEventGenerator fallback. See `buildFastDispatch`.
	const fast = buildFastDispatch(allListeners);

	// Single TS-AST scan path produces the entire event queue. When any
	// rule registers an onCodePath* listener, the walker's inline visitor
	// is wrapped in a CodePathAnalyzer that emits onCodePath* events into
	// the same queue (kind=2 steps); without CPA listeners we narrow the
	// predicate to the union of trigger types so most ts.Nodes never get
	// materialised. Either way `dispatchFast` consumes one queue — no
	// NodeEventGenerator, no lazy-ESTree full traversal.
	const eventQueue = buildTsScanEventQueue(file, fast);

	dispatchFast(eventQueue, fast, errors, t => { currentNode = t; });
}


interface DispatchEntry {
	rule: ESLint.Rule.RuleModule;
	listener: (n: unknown) => void;
	// When set, the listener receives `target[fieldFire]` instead of the
	// triggering node (Parent > *.field selectors).
	fieldFire?: string;
	// Required type for the dispatched node (post fieldFire if any).
	typeFilter?: string;
	// Per-target predicate composing attribute / ancestry checks.
	filter?: (target: any) => boolean;
}
interface FastDispatch {
	enter: Map<string, DispatchEntry[]>;
	exit: Map<string, DispatchEntry[]>;
	// Listeners with wildcard-type triggers (`*` or `Parent > *`). Fire
	// on every visited node, after the type-keyed lists.
	enterAll: DispatchEntry[];
	exitAll: DispatchEntry[];
	// `onCodePathStart` / `onCodePathEnd` / `onCodePathSegment*` listeners
	// gathered per event name. When non-empty, we have to drive every
	// node through ESLint's CodePathAnalyzer so it can update internal
	// state and emit these events.
	codePath: Map<string, Array<[ESLint.Rule.RuleModule, (...args: unknown[]) => void]>>;
}

// Always returns a FastDispatch — never null. `decomposeSimple` throws
// when it encounters a selector form it can't decompose, and we let
// that throw propagate. The legacy NodeEventGenerator fallback was
// retired once selector coverage hit 100% of the ESLint / typescript-
// eslint rule catalogue; any new gap should surface immediately as
// an UnsupportedSelectorError, not silently degrade performance.
function buildFastDispatch(
	allListeners: Array<[ESLint.Rule.RuleModule, string, (n: unknown) => void]>,
): FastDispatch {
	const { decomposeSimple, isCodePathListener } = require('./lib/selector-analysis') as typeof import('./lib/selector-analysis');
	const enter = new Map<string, DispatchEntry[]>();
	const exit = new Map<string, DispatchEntry[]>();
	const enterAll: DispatchEntry[] = [];
	const exitAll: DispatchEntry[] = [];
	const codePath = new Map<string, Array<[ESLint.Rule.RuleModule, (...args: unknown[]) => void]>>();
	for (const [rule, selector, listener] of allListeners) {
		if (isCodePathListener(selector)) {
			let arr = codePath.get(selector);
			if (!arr) codePath.set(selector, arr = []);
			arr.push([rule, listener as (...args: unknown[]) => void]);
			continue;
		}
		const infos = decomposeSimple(selector);
		for (const info of infos) {
			const map = info.isExit ? exit : enter;
			const allList = info.isExit ? exitAll : enterAll;
			const entry: DispatchEntry = {
				rule, listener,
				fieldFire: info.fieldFire,
				typeFilter: info.typeFilter,
				filter: info.filter,
			};
			if (info.types === 'all') {
				allList.push(entry);
			} else {
				for (const type of info.types) {
					let arr = map.get(type);
					if (!arr) map.set(type, arr = []);
					arr.push(entry);
				}
			}
		}
	}
	return { enter, exit, enterAll, exitAll, codePath };
}

// Build the eventQueue by scanning the TS AST instead of walking the lazy
// ESTree. Three modes, picked by inspecting `fast`:
//
//  1. CPA mode (any onCodePath* listener present) — predicate fires on
//     every ts.Node so the wrapped CodePathAnalyzer sees the full ESTree
//     stream. CPA's `onCodePath*` emits become kind=2 steps; node visits
//     become kind=1 steps. dispatchFast handles both uniformly.
//
//  2. Wildcard mode (`*` / `Parent > *` listener) — predicate fires on
//     every ts.Node, no CPA wrapper. Same materialisation cost as CPA
//     mode but no per-step CPA bookkeeping.
//
//  3. Narrow mode (default) — predicate is a Uint8Array bitmap built from
//     the trigger ESTree types. The vast majority of ts.Nodes never get
//     materialised. predicateForTriggerSet throws UnsupportedSelectorError
//     if any type lacks a registered predicate (same philosophy as
//     decomposeSimple — surface coverage gaps as hard errors).
function buildTsScanEventQueue(
	file: ts.SourceFile,
	fast: FastDispatch,
): any[] {
	if (!cachedEstree) {
		throw new Error('buildTsScanEventQueue called without an active sourceCode cache');
	}
	const { predicateForTriggerSet, predicateAllKinds, tsScanTraverse } = require('./lib/ts-ast-scan') as typeof import('./lib/ts-ast-scan');
	const ctx = cachedEstree.convertContext;
	const usesCodePath = fast.codePath.size > 0;
	const usesWildcard = fast.enterAll.length > 0 || fast.exitAll.length > 0;
	let match;
	if (usesCodePath || usesWildcard) {
		match = predicateAllKinds();
	} else {
		const types = new Set<string>();
		for (const t of fast.enter.keys()) types.add(t);
		for (const t of fast.exit.keys()) types.add(t);
		match = predicateForTriggerSet(types);
	}

	if (!usesCodePath) {
		return tsScanTraverse(file, match, ctx as any) as any[];
	}

	// CPA mode: the walker's inline visitor wraps a CodePathAnalyzer.
	// Steps are appended in the order CPA produces them (state-update
	// emits first, then the node visit), exactly mirroring what ESLint's
	// CodePathAnalyzer-wrapped traverser would emit — but on the lazy
	// ESTree built bottom-up from the TS AST, no second walker.
	const queue: any[] = [];
	const fakeEmitter = {
		emit(name: string, ...args: unknown[]) {
			queue.push({ kind: 2, target: name, args });
		},
	};
	const wrapped = {
		emitter: fakeEmitter,
		enterNode(target: unknown) {
			queue.push({ kind: 1, target, phase: 1 });
		},
		leaveNode(target: unknown) {
			queue.push({ kind: 1, target, phase: 2 });
		},
	};
	const { CodePathAnalyzer } = loadEslintInternals();
	const cpa = new CodePathAnalyzer(wrapped);
	tsScanTraverse(file, match, ctx as any, {
		enterNode(target) { cpa.enterNode(target); },
		leaveNode(target) { cpa.leaveNode(target); },
	});
	return queue;
}

function dispatchFast(
	eventQueue: any[],
	fast: FastDispatch,
	errors: Map<ESLint.Rule.RuleModule, unknown>,
	onTarget: (target: unknown) => void,
): void {
	for (let i = 0; i < eventQueue.length; i++) {
		const step = eventQueue[i];
		if (step.kind === 1) {
			const target = step.target;
			const isEnter = step.phase === 1;
			if (isEnter) onTarget(target);
			const arr = (isEnter ? fast.enter : fast.exit).get((target as any).type);
			if (arr) runEntries(arr, target, errors);
			const allArr = isEnter ? fast.enterAll : fast.exitAll;
			if (allArr.length) runEntries(allArr, target, errors);
		} else if (step.kind === 2) {
			// CodePathAnalyzer emit step: target is the event name
			// (`onCodePathStart`, `onCodePathSegmentEnd`, …) and args is
			// the payload. Dispatch directly to the per-event listener
			// arrays we collected up front — no emitter, no NEG.
			const listeners = fast.codePath.get(step.target);
			if (listeners) {
				for (let j = 0; j < listeners.length; j++) {
					const [rule, fn] = listeners[j];
					if (errors.has(rule)) continue;
					try {
						fn(...step.args);
					} catch (err) {
						errors.set(rule, err);
					}
				}
			}
		}
	}
}

function runEntries(
	arr: DispatchEntry[],
	target: any,
	errors: Map<ESLint.Rule.RuleModule, unknown>,
): void {
	for (let j = 0; j < arr.length; j++) {
		const e = arr[j];
		if (errors.has(e.rule)) continue;
		let actual = target;
		if (e.fieldFire !== undefined) {
			actual = target[e.fieldFire];
			if (actual == null) continue;
			if (Array.isArray(actual)) continue; // arrays aren't single targets
		}
		if (e.typeFilter !== undefined && actual.type !== e.typeFilter) continue;
		if (e.filter !== undefined && !e.filter(actual)) continue;
		try {
			e.listener(actual);
		} catch (err) {
			errors.set(e.rule, err);
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

function getEstree(file: ts.SourceFile, program: ts.Program) {
	if (cachedEstree?.file !== file) {
		// Skip @typescript-eslint/parser: parseForESLint dynamically loads the
		// whole parser package on first call (the heaviest single dep) and just
		// dispatches to typescript-estree's astConverter, which we already have
		// a ts.SourceFile for. Calling it directly avoids the parser require.
		const { visitorKeys } = require('@typescript-eslint/visitor-keys');
		const { SourceCode } = loadEslintInternals();
		const { TsScopeManager } = require('./lib/ts-scope-manager') as typeof import('./lib/ts-scope-manager');
		const { convertLazy } = require('./lib/lazy-estree') as typeof import('./lib/lazy-estree');

		// Lazy ESTree shim (lib/lazy-estree.ts). Byte-identical to
		// typescript-estree's eager Converter on every TS file under
		// packages/, but materialises children on first read. Rules see
		// real subtrees and can't null-deref into them.
		const { astMaps, estree, context: convertContext } = convertLazy(file) as { astMaps: any; estree: any; context: unknown };

		// tokens / comments come from typescript-estree's standalone scanner
		// helpers. Rules like no-unnecessary-type-assertion call
		// `sourceCode.getTokenAfter()` and need the tokens array — but most
		// rules never touch tokens/comments. Defer the scan via lazy
		// getters: cheap when no rule reads, ~80ms saved on large files.
		const tseRoot = path.dirname(require.resolve('@typescript-eslint/typescript-estree/package.json'));
		const { convertTokens } = require(tseRoot + '/dist/node-utils.js') as { convertTokens(ast: ts.SourceFile): unknown[] };
		const { convertComments } = require(tseRoot + '/dist/convert-comments.js') as { convertComments(ast: ts.SourceFile): unknown[] };
		let _tokens: unknown[] | undefined;
		let _comments: unknown[] | undefined;
		Object.defineProperty(estree, 'tokens', {
			configurable: true,
			enumerable: true,
			get: () => _tokens ??= convertTokens(file),
			set: (v: unknown[]) => { _tokens = v; },
		});
		Object.defineProperty(estree, 'comments', {
			configurable: true,
			enumerable: true,
			get: () => _comments ??= convertComments(file),
			set: (v: unknown[]) => { _comments = v; },
		});

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
		cachedEstree = { file, sourceCode, convertContext };
	}
	return {
		sourceCode: cachedEstree.sourceCode,
	};
}

