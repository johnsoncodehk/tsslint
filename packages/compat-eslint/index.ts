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
		// ESLint 9.39+ uses `eventGenerator.emit` (function) directly;
		// ESLint 9.0-9.38 called `eventGenerator.emitter.emit`. Provide
		// both shapes so we work across the supported range.
		emit?: (name: string, args: unknown[]) => void;
		emitter?: { emit(name: string, ...args: unknown[]): void };
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

// Vendored from `eslint/lib/shared/deep-merge-arrays.js`. Public API
// is `deepMergeArrays(defaults, userOptions)`. Array elements at the
// same index are merged via `deepMergeObjects` (object spread + recurse
// into shared keys); user values win on leaves.
function isObjectNotArray(v: unknown): v is Record<string, unknown> {
	return typeof v === 'object' && v !== null && !Array.isArray(v);
}
function deepMergeObjects(first: unknown, second: unknown): unknown {
	if (second === undefined) return first;
	if (!isObjectNotArray(first) || !isObjectNotArray(second)) return second;
	const result: Record<string, unknown> = { ...first, ...second };
	for (const key of Object.keys(second)) {
		if (Object.prototype.propertyIsEnumerable.call(first, key)) {
			result[key] = deepMergeObjects(first[key], second[key]);
		}
	}
	return result;
}
function deepMergeArrays(first: unknown[] | undefined, second: unknown[] | undefined): unknown[] {
	if (!first || !second) return second || first || [];
	return [
		...first.map((v, i) => deepMergeObjects(v, i < second.length ? second[i] : undefined)),
		...second.slice(first.length),
	];
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
	// ESLint deep-merges `meta.defaultOptions` into user options so each
	// rule sees the FULL options object (with all defaults filled in).
	// Element-wise nullish-coalescing isn't enough — when a user passes
	// `{ functions: false, classes: false }`, ESLint merges in the rule's
	// other defaults (`variables: true`, `enums: true`,
	// `ignoreTypeReferences: true`, …) so the rule's `!options.enums`
	// guards see `false`, not `undefined`. Without this merge, e.g.
	// `no-use-before-define` skips every const-enum/Type/Variable ref
	// because `!undefined` is true. Mirrors
	// `eslint/lib/shared/deep-merge-arrays.js`.
	if (eslintRule.meta?.defaultOptions) {
		options = deepMergeArrays(eslintRule.meta.defaultOptions, options);
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

function runSharedTraversal(
	file: ts.SourceFile,
	program: ts.Program,
	reports: Map<ESLint.Rule.RuleModule, DeferredReport[]>,
	errors: Map<ESLint.Rule.RuleModule, unknown>,
) {
	const { sourceCode } = getEstree(file, program);
	const cwd = program.getCurrentDirectory();

	let currentNode: any;
	// (rule, selector, listener) triples — fed into buildFastDispatch
	// which builds the per-type listener arrays dispatchFast walks.
	const allListeners: Array<[ESLint.Rule.RuleModule, string, (n: unknown) => void]> = [];

	for (const entry of ruleRegistry.values()) {
		const eslintRule = entry.eslintRule;
		// Lazy: rules that don't fire on this file pay no array allocation.
		let myReports: DeferredReport[] | undefined;
		const ruleContext = ({
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
			parserOptions: { ecmaVersion: 2026 as const, sourceType: 'module' as const },
			// Provide nested parserOptions to avoid TypeError in rules that read
			// `context.languageOptions.parserOptions.X` without a guard.
			// Set `ecmaVersion: 2026` (matches `ESLINT_BUILTIN_GLOBALS` set we
			// register) and `sourceType: 'module'` — many rules gate listener
			// registration on `ecmaVersion >= 2015` for ES6-only nodes
			// (BlockStatement:exit + VariableDeclaration on no-lone-blocks,
			// const/let detection, generator/async checks). Without this, those
			// rules degrade to a pre-ES6 dispatch that misses block-scoped
			// declarations and over-reports lone blocks.
			languageOptions: {
				parserOptions: {},
				ecmaVersion: 2026 as const,
				sourceType: 'module' as const,
			},
			parserPath: undefined,
			id: entry.id,
			options: entry.options,
			report(descriptor: ESLint.Rule.ReportDescriptor) {
				let message = 'message' in descriptor
					? descriptor.message
					: eslintRule.meta?.messages?.[descriptor.messageId] ?? '';
				message = message.replace(/\{\{\s*(\w+)\s*\}\}/gu, (key: string) => {
					return String(descriptor.data?.[key.slice(2, -2).trim()] ?? key);
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
								return String(suggest.data?.[key.slice(2, -2).trim()] ?? key);
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
			getDeclaredVariables(node: unknown) {
				return sourceCode.getDeclaredVariables(node as ESLint.Rule.Node);
			},
			getScope() {
				return sourceCode.getScope(currentNode);
			},
			markVariableAsUsed(name: string) {
				return sourceCode.markVariableAsUsed(name, currentNode);
			},
			...entry.context,
		}) as unknown as ESLint.Rule.RuleContext;
		const ruleListeners = eslintRule.create(ruleContext);

		for (const selector in ruleListeners) {
			const listener = ruleListeners[selector];
			if (listener) {
				allListeners.push([eslintRule, selector, listener as (n: unknown) => void]);
			}
		}
	}

	// Fast dispatch is the only path. Every selector decomposes into a
	// (typeSet, fieldFire?, typeFilter?, filter?) tuple via
	// `decomposeSimple`; if it can't, an UnsupportedSelectorError fires
	// — never silent NodeEventGenerator fallback. See `buildFastDispatch`.
	const fast = buildFastDispatch(allListeners);
	const onTarget = (t: unknown) => { currentNode = t; };

	// Two-mode dispatch path:
	//
	//  - CPA mode (any onCodePath* listener present): the walker's inline
	//    visitor is wrapped in a CodePathAnalyzer that needs its emit /
	//    enter / leave calls interleaved in source order. CPA's emits and
	//    node visits both land in one queue, then `dispatchFast` walks it.
	//    The queue is structurally necessary here because CPA emits arrive
	//    OUT-of-band relative to the enter/leave stream.
	//
	//  - Non-CPA mode (narrow + wildcard): no CPA wrapper, so there's no
	//    out-of-band emit interleaving. Skip the queue entirely — the
	//    walker's inline visitor calls `dispatchTarget` per hit. Saves the
	//    per-step object allocation (~28k on checker.ts) plus the second
	//    array walk in dispatchFast.
	if (fast.codePath.size > 0) {
		const eventQueue = buildCpaEventQueue(file, fast);
		dispatchFast(eventQueue, fast, errors, onTarget);
	} else {
		runTsScanInline(file, fast, errors, onTarget);
	}
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

// Build the predicate that decides which ts.Nodes get materialised.
// Three shapes, picked by inspecting `fast`:
//
//  1. CPA mode (any onCodePath* listener present) — predicate fires on
//     every ts.Node so the wrapped CodePathAnalyzer sees the full ESTree
//     stream.
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
function buildScanPredicate(fast: FastDispatch) {
	const { predicateForTriggerSet, predicateAllKinds } = require('./lib/ts-ast-scan') as typeof import('./lib/ts-ast-scan');
	const usesCodePath = fast.codePath.size > 0;
	const usesWildcard = fast.enterAll.length > 0 || fast.exitAll.length > 0;
	if (usesCodePath || usesWildcard) {
		return predicateAllKinds();
	}
	const types = new Set<string>();
	for (const t of fast.enter.keys()) types.add(t);
	for (const t of fast.exit.keys()) types.add(t);
	return predicateForTriggerSet(types);
}

// Non-CPA fast path. The walker's inline visitor calls `dispatchTarget`
// directly per hit — no intermediate event-queue array allocation, no
// per-step object alloc. This is the hot path for narrow + wildcard mode
// (every rule set without onCodePath* listeners).
function runTsScanInline(
	file: ts.SourceFile,
	fast: FastDispatch,
	errors: Map<ESLint.Rule.RuleModule, unknown>,
	onTarget: (target: unknown) => void,
): void {
	if (!cachedEstree) {
		throw new Error('runTsScanInline called without an active sourceCode cache');
	}
	const { tsScanTraverse } = require('./lib/ts-ast-scan') as typeof import('./lib/ts-ast-scan');
	const match = buildScanPredicate(fast);
	tsScanTraverse(file, match, cachedEstree.convertContext as any, {
		enterNode(target) {
			dispatchTarget(target, true, fast, errors, onTarget);
		},
		leaveNode(target) {
			dispatchTarget(target, false, fast, errors, onTarget);
		},
	});
}

// CPA-mode event-queue producer. The walker's inline visitor wraps a
// CodePathAnalyzer; CPA's onCodePath* emits arrive out-of-band relative
// to the enter/leave stream and have to be replayed in CPA's own ordering
// — that's why we materialise a queue here. Steps are appended in the
// order CPA produces them (state-update emits first, then the node
// visit), exactly mirroring what ESLint's CodePathAnalyzer-wrapped
// traverser would emit — but on the lazy ESTree built bottom-up from the
// TS AST, no second walker.
function buildCpaEventQueue(file: ts.SourceFile, fast: FastDispatch): any[] {
	if (!cachedEstree) {
		throw new Error('buildCpaEventQueue called without an active sourceCode cache');
	}
	const { tsScanTraverse } = require('./lib/ts-ast-scan') as typeof import('./lib/ts-ast-scan');
	const match = buildScanPredicate(fast);
	const queue: any[] = [];
	// CPA's emit API: ESLint 9.39 calls `analyzer.emit(name, args)` directly
	// (the analyzer copies `eventGenerator.emit` onto itself); older ESLint
	// 9.x called `analyzer.emitter.emit(name, ...args)`. Provide both to
	// stay forward and backward compatible.
	const emit = (name: string, args: unknown[]) => {
		queue.push({ kind: 2, target: name, args });
	};
	const fakeEmitter = {
		emit(name: string, ...args: unknown[]) {
			queue.push({ kind: 2, target: name, args });
		},
	};
	const wrapped = {
		emit,
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
	tsScanTraverse(file, match, cachedEstree.convertContext as any, {
		enterNode(target) { cpa.enterNode(target); },
		leaveNode(target) { cpa.leaveNode(target); },
	});
	return queue;
}

// Per-target dispatcher: type-keyed enter/exit list + wildcard list. Used
// by both the inline non-CPA path and dispatchFast's kind=1 branch.
// Updates `currentNode` (via `onTarget`) on enter so getScope/getAncestors
// see the right node when rules call them from inside a listener.
function dispatchTarget(
	target: unknown,
	isEnter: boolean,
	fast: FastDispatch,
	errors: Map<ESLint.Rule.RuleModule, unknown>,
	onTarget: (target: unknown) => void,
): void {
	if (isEnter) onTarget(target);
	const arr = (isEnter ? fast.enter : fast.exit).get((target as any).type);
	if (arr) runEntries(arr, target, errors);
	const allArr = isEnter ? fast.enterAll : fast.exitAll;
	if (allArr.length) runEntries(allArr, target, errors);
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
			dispatchTarget(step.target, step.phase === 1, fast, errors, onTarget);
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
		const { visitorKeys } = require('./lib/visitor-keys') as typeof import('./lib/visitor-keys');
		const { TsScopeManager, applyEslintGlobals } = require('./lib/ts-scope-manager') as typeof import('./lib/ts-scope-manager');
		const { convertLazy } = require('./lib/lazy-estree') as typeof import('./lib/lazy-estree');
		const { LazySourceCode } = require('./lib/lazy-source-code') as typeof import('./lib/lazy-source-code');

		// Lazy ESTree shim (lib/lazy-estree.ts). Byte-identical to
		// typescript-estree's eager Converter on every TS file under
		// packages/, but materialises children on first read. Rules see
		// real subtrees and can't null-deref into them.
		const { astMaps, estree, context: convertContext } = convertLazy(file) as { astMaps: any; estree: any; context: unknown };

		// tokens / comments come from our own scanner-based converters
		// (lib/tokens.ts) — byte-identical to typescript-estree's
		// `convertTokens` / `convertComments` on every checked fixture.
		// Rules like no-unnecessary-type-assertion call
		// `sourceCode.getTokenAfter()` and need the tokens array — but
		// most rules never touch tokens/comments. Defer the scan via lazy
		// getters: cheap when no rule reads, ~80ms saved on large files.
		const { convertTokens, convertComments } = require('./lib/tokens') as typeof import('./lib/tokens');
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
		// Inject ECMAScript built-ins + TS lib type globals so `no-undef`
		// doesn't fire on `undefined` / `Math` / `Record<K, V>` / etc.
		// `TsScopeManager` itself stays free of this lint-pipeline policy
		// (upstream eslint-scope parity tests rely on the un-injected
		// shape); the names + de-dupe logic live next to `addGlobals` in
		// `ts-scope-manager.ts`.
		applyEslintGlobals(scopeManager);
		const sourceCode = new LazySourceCode({
			text: file.text,
			ast: estree,
			tsFile: file,
			scopeManager,
			visitorKeys: visitorKeys as Record<string, string[]>,
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
		}) as unknown as ESLint.SourceCode;
		cachedEstree = { file, sourceCode, convertContext };
	}
	return {
		sourceCode: cachedEstree.sourceCode,
	};
}

