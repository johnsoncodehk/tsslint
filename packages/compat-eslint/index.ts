import type * as TSSLint from '@tsslint/types';
import type * as ESLint from 'eslint';
import type * as ts from 'typescript';
import CodePathAnalyzer = require('./lib/code-path-analysis/code-path-analyzer.js');
import { convertLazy } from './lib/lazy-estree';
import { LazySourceCode } from './lib/lazy-source-code';
import { decomposeSimple, isCodePathListener } from './lib/selector-analysis';
import { convertComments, convertTokens } from './lib/tokens';
import { predicateAllKinds, predicateForTriggerSet, tsScanTraverse } from './lib/ts-ast-scan';
import { applyEslintGlobals, TsScopeManager } from './lib/ts-scope-manager';
import { visitorKeys } from './lib/visitor-keys';

// Build a parse-time-named wrapper around a rule listener. V8's CPU
// profile reads the SharedFunctionInfo's parse-time-inferred name, so we
// have to compile fresh source per rule with the rule id baked in as a
// string literal; runtime renames (`Function.prototype.name = ...` or a
// computed-property-key object literal) only show up in
// `Function.prototype.name` and stack traces, not in profile frames.
//
// Two specialised wrappers, both per-rule cached and compiled fresh
// via `new Function` so the rule id is parse-time literal:
//   - selector listener: `function (node) { return fn(node); }` —
//     covers the AST-visit hot path (~99% of listener calls). V8
//     decides per-rule whether to inline; rules whose listener body
//     does enough work to register on the profiler keep their frame.
//   - code-path listener: `function () { return fn.apply(this, arguments); }`
//     — preserves variadic dispatch for `onCodePath*` listeners that
//     take multiple args.
const _wrapCache = new Map<string, [
	selectorWrap: (fn: (n: unknown) => unknown) => (n: unknown) => unknown,
	variadicWrap: (fn: (...args: unknown[]) => unknown) => (...args: unknown[]) => unknown,
]>();
function _getWrappers(ruleId: string) {
	let pair = _wrapCache.get(ruleId);
	if (pair) return pair;
	const key = JSON.stringify(ruleId);
	// `//# sourceURL=` directive gives the resulting SharedFunctionInfo a
	// non-empty `url`, so Chrome DevTools surfaces these frames in
	// flame graphs / Bottom-Up / search instead of hiding them as native.
	// Different URL per rule so each frame is independently navigable.
	const selectorWrap = new Function(
		'fn',
		`return ({ ${key}: function (node) { return fn(node); } })[${key}];\n//# sourceURL=tsslint-listener/${ruleId}.js`,
	) as any;
	const variadicWrap = new Function(
		'fn',
		`return ({ ${key}: function () { return fn.apply(this, arguments); } })[${key}];\n//# sourceURL=tsslint-listener/${ruleId}.js`,
	) as any;
	pair = [selectorWrap, variadicWrap];
	_wrapCache.set(ruleId, pair);
	return pair;
}
function wrapSelectorListener(ruleId: string, fn: (n: unknown) => unknown) {
	return _getWrappers(ruleId)[0](fn);
}
function wrapVariadicListener(ruleId: string, fn: (...args: unknown[]) => unknown) {
	return _getWrappers(ruleId)[1](fn);
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

// Per-file lint state. Single object that bundles:
//   - `sourceCode` / `convertContext`: lazy ESTree + LazySourceCode for
//     this file. `convertContext` survives across rule replays so each
//     `materialize(tsNode, context)` hit hits the same identity-preserved
//     LazyNode cache.
//   - `reports`: deferred per-rule reports collected during a single
//     shared traversal; each tsslintRule call replays its own bucket.
//   - `errors`: per-rule listener throws, captured so a rule's tsslintRule
//     can rethrow at replay time (preserving TSSLint core's per-rule
//     type-aware retry semantics).
//
// Everything in here invalidates together when `file` changes — there's
// no scenario where one part is reusable without the others, so a single
// per-file slot replaces the two separate caches the earlier design had.
let perFileState: {
	file: ts.SourceFile;
	sourceCode: ESLint.SourceCode;
	convertContext: unknown;
	reports: Map</* eslintRule */ ESLint.Rule.RuleModule, DeferredReport[]>;
	errors: Map</* eslintRule */ ESLint.Rule.RuleModule, unknown>;
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
		if (perFileState?.file !== file) {
			const { sourceCode, convertContext } = buildEstree(file, program);
			perFileState = {
				file,
				sourceCode,
				convertContext,
				reports: new Map(),
				errors: new Map(),
			};
			runSharedTraversal(file, program, perFileState);
		}

		const ruleError = perFileState.errors.get(eslintRule);
		if (ruleError !== undefined) {
			throw ruleError;
		}

		const myReports = perFileState.reports.get(eslintRule);
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
	state: NonNullable<typeof perFileState>,
) {
	const { sourceCode, convertContext, reports, errors } = state;
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
			if (!listener) continue;
			// Wrap the listener in a parse-time-named thunk so V8's CPU
			// profile attributes the listener's run time to the rule id.
			// Single-arg fast wrap for AST visit listeners (the ~99 % hot
			// path), variadic wrap for code-path listeners that take
			// multiple args.
			const wrapped = isCodePathListener(selector)
				? wrapVariadicListener(entry.id, listener as (...args: unknown[]) => unknown)
				: wrapSelectorListener(entry.id, listener as (n: unknown) => unknown);
			allListeners.push([eslintRule, selector, wrapped]);
		}
	}

	// Fast dispatch is the only path. Every selector decomposes into a
	// (typeSet, fieldFire?, typeFilter?, filter?) tuple via
	// `decomposeSimple`; if it can't, an UnsupportedSelectorError fires
	// — never silent NodeEventGenerator fallback. See `buildFastDispatch`.
	const fast = buildFastDispatch(allListeners);
	const onTarget = (t: unknown) => {
		currentNode = t;
	};

	// Single dispatch path. The walker is `tsScanTraverse` either way; the
	// only difference between the two modes is whether the visitor wraps a
	// CodePathAnalyzer.
	//
	//  - Non-CPA mode (narrow + wildcard): visitor calls `dispatchTarget`
	//    directly per hit.
	//  - CPA mode (any onCodePath* listener present): visitor wraps a CPA
	//    whose `emit` / `enterNode` / `leaveNode` hooks dispatch inline.
	//    No event queue — CPA's order of calls IS the dispatch order.
	if (fast.codePath.size > 0) {
		runCpaInline(file, fast, errors, onTarget, convertContext);
	}
	else {
		runTsScanInline(file, fast, errors, onTarget, convertContext);
	}
}

interface DispatchEntry {
	rule: ESLint.Rule.RuleModule;
	listener: (n: unknown) => void;
	// When set, the listener receives `target[fieldFire]` instead of the
	// triggering node (Parent > *.field selectors).
	fieldFire?: string;
	// Multi-level field walk for chains like `A > B.f1 > C.f2`. Each
	// step extracts `actual[fieldChain[i]]` and (if `fieldChainTypes[i]`
	// is set) checks the intermediate node's `.type`. Listener receives
	// the final extracted node. Mutually exclusive with `fieldFire`.
	fieldChain?: string[];
	fieldChainTypes?: (string | undefined)[];
	// Required type for the dispatched node (post fieldFire / fieldChain
	// if any).
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
	const enter = new Map<string, DispatchEntry[]>();
	const exit = new Map<string, DispatchEntry[]>();
	const enterAll: DispatchEntry[] = [];
	const exitAll: DispatchEntry[] = [];
	const codePath = new Map<string, Array<[ESLint.Rule.RuleModule, (...args: unknown[]) => void]>>();
	for (const [rule, selector, listener] of allListeners) {
		if (isCodePathListener(selector)) {
			let arr = codePath.get(selector);
			if (!arr) codePath.set(selector, arr = []);
			arr.push([rule, listener]);
			continue;
		}
		const infos = decomposeSimple(selector);
		for (const info of infos) {
			const map = info.isExit ? exit : enter;
			const allList = info.isExit ? exitAll : enterAll;
			const entry: DispatchEntry = {
				rule,
				listener,
				fieldFire: info.fieldFire,
				fieldChain: info.fieldChain,
				fieldChainTypes: info.fieldChainTypes,
				typeFilter: info.typeFilter,
				filter: info.filter,
			};
			if (info.types === 'all') {
				allList.push(entry);
			}
			else {
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
	convertContext: unknown,
): void {
	const match = buildScanPredicate(fast);
	tsScanTraverse(file, match, convertContext as any, {
		enterNode(target) {
			dispatchTarget(target, true, fast, errors, onTarget);
		},
		leaveNode(target) {
			dispatchTarget(target, false, fast, errors, onTarget);
		},
	});
}

// CPA mode: drive every node through CodePathAnalyzer, dispatching listener
// events inline as CPA emits them. Same architectural shape as
// `runTsScanInline` (one walker, inline dispatch); the only difference is
// the visitor wraps a CPA so `onCodePath*` events fire in source order
// alongside `:enter` / `:exit`. CPA's order of emit / enterNode / leaveNode
// calls IS the dispatch order — no replay buffer needed.
function runCpaInline(
	file: ts.SourceFile,
	fast: FastDispatch,
	errors: Map<ESLint.Rule.RuleModule, unknown>,
	onTarget: (target: unknown) => void,
	convertContext: unknown,
): void {
	const match = buildScanPredicate(fast);
	// CPA emits `onCodePathStart` / `onCodePathSegment*` / etc. Dispatch
	// directly to the per-event listener arrays we collected up front.
	const dispatchEvent = (name: string, args: unknown[]) => {
		const listeners = fast.codePath.get(name);
		if (!listeners) return;
		for (let j = 0; j < listeners.length; j++) {
			const [rule, fn] = listeners[j];
			if (errors.has(rule)) continue;
			try {
				fn(...args);
			}
			catch (err) {
				errors.set(rule, err);
			}
		}
	};
	// CPA's emit API: ESLint 9.39 calls `analyzer.emit(name, args)` directly
	// (the analyzer copies `eventGenerator.emit` onto itself); older ESLint
	// 9.x called `analyzer.emitter.emit(name, ...args)`. Provide both shapes.
	const wrapped = {
		emit: (name: string, args: unknown[]) => dispatchEvent(name, args),
		emitter: {
			emit(name: string, ...args: unknown[]) {
				dispatchEvent(name, args);
			},
		},
		enterNode: (target: unknown) => dispatchTarget(target, true, fast, errors, onTarget),
		leaveNode: (target: unknown) => dispatchTarget(target, false, fast, errors, onTarget),
	};
	const cpa = new CodePathAnalyzer(wrapped);
	tsScanTraverse(file, match, convertContext as any, {
		enterNode(target) {
			cpa.enterNode(target);
		},
		leaveNode(target) {
			cpa.leaveNode(target);
		},
	});
}

// Per-target dispatcher: type-keyed enter/exit list + wildcard list.
// Called inline by both `runTsScanInline` and `runCpaInline`.
// Updates `currentNode` (via `onTarget`) on BOTH enter and exit so that
// `getScope` / `getAncestors` / `markVariableAsUsed` from inside an exit
// listener see the node being exited — not the last-entered descendant.
// ESLint's Linter sets the same `currentNode` before invoking either
// phase's listener; matching that contract is what rules like `no-shadow`
// / `no-redeclare` (which read scope from `:exit` listeners on inner
// nodes) depend on.
function dispatchTarget(
	target: unknown,
	isEnter: boolean,
	fast: FastDispatch,
	errors: Map<ESLint.Rule.RuleModule, unknown>,
	onTarget: (target: unknown) => void,
): void {
	onTarget(target);
	const arr = (isEnter ? fast.enter : fast.exit).get((target as any).type);
	if (arr) runEntries(arr, target, errors);
	const allArr = isEnter ? fast.enterAll : fast.exitAll;
	if (allArr.length) runEntries(allArr, target, errors);
}

function runEntries(
	arr: DispatchEntry[],
	target: any,
	errors: Map<ESLint.Rule.RuleModule, unknown>,
): void {
	for (let j = 0; j < arr.length; j++) {
		const e = arr[j];
		if (errors.has(e.rule)) continue;
		let actual: any = target;
		if (e.fieldFire !== undefined) {
			actual = target[e.fieldFire];
			if (actual == null) continue;
			if (Array.isArray(actual)) continue; // arrays aren't single targets
		}
		else if (e.fieldChain !== undefined) {
			// Multi-level field walk for `A > B.f1 > C.f2 [> …]` chains.
			// Each step extracts and (when fieldChainTypes[k] is set)
			// type-checks the intermediate node before walking further.
			// Final extracted node is passed to the listener.
			let bail = false;
			const chain = e.fieldChain;
			const types = e.fieldChainTypes;
			for (let k = 0; k < chain.length; k++) {
				actual = actual[chain[k]];
				if (actual == null || Array.isArray(actual)) {
					bail = true;
					break;
				}
				const t = types?.[k];
				if (t !== undefined && actual.type !== t) {
					bail = true;
					break;
				}
			}
			if (bail) continue;
		}
		if (e.typeFilter !== undefined && actual.type !== e.typeFilter) continue;
		if (e.filter !== undefined && !e.filter(actual)) continue;
		try {
			e.listener(actual);
		}
		catch (err) {
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

// Build a fresh `LazySourceCode` + lazy-estree convert context for `file`.
// Pure: no module-level caching here — callers cache via `perFileState`.
//
// Skips @typescript-eslint/parser: `parseForESLint` dynamically loads the
// whole parser package on first call (the heaviest single dep) and just
// dispatches to typescript-estree's astConverter, which we already have a
// ts.SourceFile for. Calling our own converter directly avoids the require.
function buildEstree(file: ts.SourceFile, program: ts.Program): {
	sourceCode: ESLint.SourceCode;
	convertContext: unknown;
} {
	// Lazy ESTree shim (lib/lazy-estree.ts). Byte-identical to
	// typescript-estree's eager Converter on every TS file under
	// packages/, but materialises children on first read. Rules see
	// real subtrees and can't null-deref into them.
	const { astMaps, estree, context: convertContext } = convertLazy(file) as {
		astMaps: any;
		estree: any;
		context: unknown;
	};

	// tokens / comments come from our own scanner-based converters
	// (lib/tokens.ts) — byte-identical to typescript-estree's
	// `convertTokens` / `convertComments` on every checked fixture.
	// Rules like no-unnecessary-type-assertion call
	// `sourceCode.getTokenAfter()` and need the tokens array — but
	// most rules never touch tokens/comments. Defer the scan via lazy
	// getters: cheap when no rule reads, ~80ms saved on large files.
	let _tokens: unknown[] | undefined;
	let _comments: unknown[] | undefined;
	Object.defineProperty(estree, 'tokens', {
		configurable: true,
		enumerable: true,
		get: () => _tokens ??= convertTokens(file),
		set: (v: unknown[]) => {
			_tokens = v;
		},
	});
	Object.defineProperty(estree, 'comments', {
		configurable: true,
		enumerable: true,
		get: () => _comments ??= convertComments(file),
		set: (v: unknown[]) => {
			_comments = v;
		},
	});

	estree.sourceType = (file as { externalModuleIndicator?: unknown }).externalModuleIndicator
		? 'module'
		: 'script';
	const scopeManager = new TsScopeManager(file, program, estree, astMaps, estree.sourceType);
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
				program.getTypeChecker().getSymbolAtLocation(astMaps.esTreeNodeToTSNodeMap.get(node)),
			getTypeAtLocation: (node: any) =>
				program.getTypeChecker().getTypeAtLocation(astMaps.esTreeNodeToTSNodeMap.get(node)),
		},
	}) as unknown as ESLint.SourceCode;
	return { sourceCode, convertContext };
}
