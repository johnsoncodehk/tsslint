// End-to-end integration tests for the compat-eslint pipeline.
//
// Each unit test file (lazy-estree, ts-ast-scan, selector-analysis)
// covers one layer in isolation. This file drives the full
// `runSharedTraversal` flow with mock ESLint rules and verifies:
//   - listener fire order and target shape (TS-scan / fast dispatch path)
//   - `.parent` walking via bottom-up materialise after a TS-scan hit
//   - CPA fallback (rule with `onCodePath*` listener forces ESLint traverser)
//   - rule-level error isolation
//
// Run via:
//   node --experimental-strip-types --no-warnings packages/compat-eslint/test/compat-pipeline.test.ts

import type * as ESLint from 'eslint';
import * as ts from 'typescript';

const compat = require('../index.js') as typeof import('../index.js');

const failures: string[] = [];
function check(name: string, cond: boolean, detail?: string) {
	if (cond) {
		process.stdout.write('.');
	}
	else {
		failures.push(name + (detail ? ' — ' + detail : ''));
		process.stdout.write('F');
	}
}

// --- Test fixtures ---------------------------------------------------

interface Recorded {
	selector: string;
	type: string;
	name?: string;
	parents: string[];
}

interface MockRule {
	rule: ESLint.Rule.RuleModule;
	calls: Recorded[];
}

function makeRule(listeners: Record<string, true>): MockRule {
	const calls: Recorded[] = [];
	const rule: ESLint.Rule.RuleModule = {
		meta: { type: 'problem', schema: [], messages: { x: 'x' } } as any,
		create(_ctx) {
			const out: Record<string, (n: any) => void> = {};
			for (const sel of Object.keys(listeners)) {
				out[sel] = n => {
					const parents: string[] = [];
					let p = (n as { parent?: { type?: string } }).parent;
					while (p && parents.length < 20) {
						parents.push(p.type ?? '?');
						p = (p as { parent?: { type?: string } }).parent;
					}
					calls.push({ selector: sel, type: n.type, name: (n as { name?: string }).name, parents });
				};
			}
			return out;
		},
	};
	return { rule, calls };
}

// Build a minimal ts.Program from in-memory code. Compiler host serves
// `/test.ts` only; type-checker calls in our pipeline are best-effort
// (parserServices.getSymbolAtLocation only fires if a rule explicitly
// asks, which our mock rules don't).
function buildProgram(
	code: string,
	kind: ts.ScriptKind = ts.ScriptKind.TS,
): { program: ts.Program; file: ts.SourceFile } {
	const fileName = kind === ts.ScriptKind.TSX ? '/test.tsx' : '/test.ts';
	const sf = ts.createSourceFile(fileName, code, ts.ScriptTarget.Latest, true, kind);
	const realLibPath = ts.getDefaultLibFilePath({ target: ts.ScriptTarget.Latest });
	const realLibName = realLibPath.split(/[\\/]/).pop()!;
	const realLibContent = ts.sys.readFile(realLibPath) ?? '';
	const realLib = ts.createSourceFile(
		realLibPath,
		realLibContent,
		ts.ScriptTarget.Latest,
		true,
		ts.ScriptKind.TS,
	);
	const host: ts.CompilerHost = {
		getSourceFile: n => n === fileName ? sf : (n === realLibPath ? realLib : undefined),
		getDefaultLibFileName: () => realLibName,
		getDefaultLibLocation: () => realLibPath.replace('/' + realLibName, ''),
		writeFile: () => {},
		getCurrentDirectory: () => '/',
		getDirectories: () => [],
		fileExists: n => n === fileName || n === realLibPath,
		readFile: n => n === fileName ? code : (n === realLibPath ? realLibContent : undefined),
		getCanonicalFileName: n => n,
		useCaseSensitiveFileNames: () => true,
		getNewLine: () => '\n',
	};
	const program = ts.createProgram({
		rootNames: [fileName],
		options: {
			target: ts.ScriptTarget.Latest,
			lib: [realLibName],
			noEmit: true,
			jsx: kind === ts.ScriptKind.TSX ? ts.JsxEmit.Preserve : undefined,
		},
		host,
	});
	return { program, file: sf };
}

// Drive the rule through the TSSLint pipeline. Returns the reports the
// rule produced (mock rules don't report; we capture listener calls
// instead, which exercises the same path before the report-replay step).
function runRule(
	rule: ESLint.Rule.RuleModule,
	program: ts.Program,
	file: ts.SourceFile,
): { reports: any[]; threw?: unknown } {
	const reports: any[] = [];
	let threw: unknown;
	const tsslintRule = compat.convertRule(rule, [], { id: 'mock' });
	const reportFn: any = (msg: string, start: number, end: number) => {
		const r: any = { msg, start, end };
		reports.push(r);
		// Mimic the .at(...) and chained .asXxx() / .withFix() the real
		// reporter exposes — tests don't exercise these but the pipeline
		// calls them.
		const chain = {
			at() {
				return chain;
			},
			asWarning() {
				return chain;
			},
			asError() {
				return chain;
			},
			asSuggestion() {
				return chain;
			},
			withFix() {
				return chain;
			},
			withRefactor() {
				return chain;
			},
		};
		return chain;
	};
	try {
		tsslintRule({ file, report: reportFn, program } as any);
	}
	catch (e) {
		threw = e;
	}
	return { reports, threw };
}

function runMock(
	code: string,
	listeners: Record<string, true>,
	kind: ts.ScriptKind = ts.ScriptKind.TS,
): { calls: Recorded[]; threw?: unknown } {
	const { program, file } = buildProgram(code, kind);
	const m = makeRule(listeners);
	const r = runRule(m.rule, program, file);
	return { calls: m.calls, threw: r.threw };
}

// --- Tests -----------------------------------------------------------

// 1. Simple selector → fast dispatch path → listener receives correct
//    target shape, and `.parent` walks via bottom-up materialise.
{
	const code = `
		import { foo } from './bar';
		function f(): number { return 1; }
	`;
	const { calls } = runMock(code, {
		'ImportDeclaration': true,
		'FunctionDeclaration': true,
		'TSNumberKeyword': true,
	});

	const imports = calls.filter(c => c.selector === 'ImportDeclaration');
	check('integration: ImportDeclaration listener fires', imports.length === 1);
	check('integration: ImportDeclaration target.type matches', imports[0]?.type === 'ImportDeclaration');

	const fns = calls.filter(c => c.selector === 'FunctionDeclaration');
	check('integration: FunctionDeclaration listener fires', fns.length === 1);
	check('integration: FunctionDeclaration target.type matches', fns[0]?.type === 'FunctionDeclaration');

	const nums = calls.filter(c => c.selector === 'TSNumberKeyword');
	check('integration: TSNumberKeyword fires inside type annotation', nums.length === 1);
	// Walk up via .parent — verify materialise builds the chain bottom-up.
	const parents = nums[0]?.parents ?? [];
	check(
		'integration: TSNumberKeyword.parent.parent reaches FunctionDeclaration via .parent walk',
		parents.includes('FunctionDeclaration'),
		`parent chain: [${parents.join(' → ')}]`,
	);
}

// 2. Compound :exit selector — fast dispatch handles `Type:exit` as the
//    same simple decomposition, fires on leave phase.
{
	const code = `
		import a from 'a';
		import b from 'b';
	`;
	const { calls } = runMock(code, {
		'Program:exit': true,
		'ImportDeclaration': true,
	});

	// Both program:exit and import enters fire. Listener firings are in
	// pre-order, but :exit fires AFTER its enter+children. So the order
	// should be: ImportDeclaration enter × 2, then Program:exit.
	check(
		'integration: 2 ImportDeclaration enter events',
		calls.filter(c => c.selector === 'ImportDeclaration').length === 2,
	);
	check('integration: 1 Program:exit event', calls.filter(c => c.selector === 'Program:exit').length === 1);
	const lastSel = calls[calls.length - 1]?.selector;
	check('integration: Program:exit fires LAST', lastSel === 'Program:exit', `last call: ${lastSel}`);
}

// 3. CPA fallback — registering an `onCodePathStart` listener forces
//    the slow path (ESLint's traverser). Verify the fall-back actually
//    fires the listener (which only ESLint's CodePathAnalyzer can emit).
{
	const code = `function f() { return 1; }`;
	const { program, file } = buildProgram(code);
	const cpaCalls: { event: string; node?: any }[] = [];
	const rule: ESLint.Rule.RuleModule = {
		meta: { type: 'problem', schema: [], messages: { x: 'x' } } as any,
		create() {
			return {
				onCodePathStart(_codePath: any, node: any) {
					cpaCalls.push({ event: 'onCodePathStart', node: node?.type });
				},
				onCodePathEnd(_codePath: any, node: any) {
					cpaCalls.push({ event: 'onCodePathEnd', node: node?.type });
				},
				FunctionDeclaration(n: any) {
					cpaCalls.push({ event: 'FunctionDeclaration', node: n.type });
				},
			};
		},
	};
	runRule(rule, program, file);

	check('CPA fallback: onCodePathStart fires (slow path)', cpaCalls.some(c => c.event === 'onCodePathStart'));
	check('CPA fallback: onCodePathEnd fires', cpaCalls.some(c => c.event === 'onCodePathEnd'));
	check(
		'CPA fallback: FunctionDeclaration also fires alongside CPA events',
		cpaCalls.some(c => c.event === 'FunctionDeclaration'),
	);
}

// 3b. CPA correctness — method shorthand inside object literal must open
//     its own code path. ESLint's CodePathAnalyzer hooks `FunctionExpression`
//     enter to push a new path; method shorthand's ESTree shape is
//     `Property{method:true, value:FunctionExpression}` — two layers. If
//     the walker enters `Property` without expanding into its `.value`
//     FunctionExpression, CPA never sees the inner function and treats the
//     method's `return` as terminating the OUTER scope's path, marking
//     subsequent statements unreachable. Regression test for the
//     no-unreachable false-positive seen on TS repo's checker.ts.
{
	const code = `const obj = { method() { return 1; } };\nvar x = 1;`;
	const { program, file } = buildProgram(code);
	const eslintRoot = require('path').dirname(require.resolve('eslint/package.json'));
	const noUnreachable = require(eslintRoot + '/lib/rules/no-unreachable.js');
	const reports: { start: number; end: number }[] = [];
	const tsslintRule = compat.convertRule(noUnreachable, [], { id: 'no-unreachable' });
	const reportFn: any = (_msg: string, start: number, end: number) => {
		reports.push({ start, end });
		const r: any = {
			at() {
				return r;
			},
			asWarning() {
				return r;
			},
			asError() {
				return r;
			},
			asSuggestion() {
				return r;
			},
			withFix() {
				return r;
			},
			withRefactor() {
				return r;
			},
			withDeprecated() {
				return r;
			},
			withUnnecessary() {
				return r;
			},
			withoutCache() {
				return r;
			},
		};
		return r;
	};
	tsslintRule({ file, report: reportFn, program } as any);
	check(
		'no-unreachable: method shorthand return does not poison outer scope reachability',
		reports.length === 0,
		`got ${reports.length} reports, first at [${reports[0]?.start}, ${reports[0]?.end}]`,
	);
}

// 3c. Wrapping nodes (ExportNamed / ExportDefault / TSParameterProperty) must
//     re-point their inner's `.parent` to the wrapper. typescript-estree's
//     ESTree shape is `Program → ExportNamedDeclaration → FunctionDeclaration`
//     — inner FunctionDeclaration's parent is the wrapper, not Program.
//     Many rules (padding-line-between-statements, no-redeclare, …) gate on
//     `node.parent.type` being a statement-list parent and silently skip
//     when it is not — so a wrong parent here causes silent rule misbehavior
//     (false positives or negatives depending on the rule's intent).
{
	const code = `
		function before() {}

		/** @internal */
		export function after() {}
	`;
	const { program, file } = buildProgram(code);
	const eslintRoot = require('path').dirname(require.resolve('eslint/package.json'));
	const paddingRule = require(eslintRoot + '/lib/rules/padding-line-between-statements.js');
	const reports: { start: number; end: number }[] = [];
	const tsslintRule = compat.convertRule(
		paddingRule,
		[{ blankLine: 'always', prev: '*', next: 'function' }],
		{ id: 'padding-line-between-statements' },
	);
	const reportFn: any = (_msg: string, start: number, end: number) => {
		reports.push({ start, end });
		const r: any = {
			at() {
				return r;
			},
			asWarning() {
				return r;
			},
			asError() {
				return r;
			},
			asSuggestion() {
				return r;
			},
			withFix() {
				return r;
			},
			withRefactor() {
				return r;
			},
			withDeprecated() {
				return r;
			},
			withUnnecessary() {
				return r;
			},
			withoutCache() {
				return r;
			},
		};
		return r;
	};
	tsslintRule({ file, report: reportFn, program } as any);
	check(
		'padding-line: export-wrapped function inherits proper parent (no false positive on JSDoc-then-export)',
		reports.length === 0,
		`got ${reports.length} reports`,
	);
}

// 3d. Scope-manager Definition.parent for for-of / for-in / for-init bindings
//     must point at the standalone VariableDeclaration (ESTree), not at the
//     enclosing ForOfStatement. ESLint's `no-loop-func` reads
//     `definition.parent.kind` to skip `let`/`const` block-scoped bindings —
//     wrong parent → kind === undefined → every block-scoped iteration var
//     gets reported as unsafe.
{
	// `const` binding in a for-of: ESLint says safe, TSSLint must agree.
	const code = `for (const x of arr) { items.filter(y => y === x); }`;
	const { program, file } = buildProgram(code);
	const eslintRoot = require('path').dirname(require.resolve('eslint/package.json'));
	const noLoopFunc = require(eslintRoot + '/lib/rules/no-loop-func.js');
	const reports: { msg: string }[] = [];
	const tsslintRule = compat.convertRule(noLoopFunc, [], { id: 'no-loop-func' });
	const reportFn: any = (msg: string) => {
		reports.push({ msg });
		const r: any = {
			at() {
				return r;
			},
			asWarning() {
				return r;
			},
			asError() {
				return r;
			},
			asSuggestion() {
				return r;
			},
			withFix() {
				return r;
			},
			withRefactor() {
				return r;
			},
			withDeprecated() {
				return r;
			},
			withUnnecessary() {
				return r;
			},
			withoutCache() {
				return r;
			},
		};
		return r;
	};
	tsslintRule({ file, report: reportFn, program } as any);
	check(
		'no-loop-func: const for-of binding is block-scoped (safe), no false positive',
		reports.length === 0,
		`got ${reports.length} reports`,
	);
}

// 3e. `materialize()` fallback to GenericTSNode(parent=null) must pass
//     ConvertContext explicitly. Reachable when bottom-up materialise
//     gets a ts.Node whose parent chain doesn't reach the cached
//     SourceFile — happens via scope-manager's `TsDefinition.get node()`
//     calling `tsToEstreeOrStub(decl)` from inside `naming-convention`'s
//     `collectUnusedVariables.isExported` helper. Without ctx, `LazyNode`
//     reads `parent!._ctx` → `Cannot read properties of null (reading
//     '_ctx')` → silently kills the rule on that file (per-rule error
//     isolation). Originally surfaced on `src/lib/es5.d.ts` in TS repo.
//
//     Direct call into `materialize()` with a detached node — the only
//     deterministic way to drive the walker into the no-cached-ancestor
//     branch. (CLI repro depends on a long chain of rule + scope-manager
//     state that's hard to reduce in-memory.)
{
	const lazy = require('../lib/lazy-estree.js') as typeof import('../lib/lazy-estree');
	const code = `const x = 1;\n`;
	const { file } = buildProgram(code);
	const { context } = lazy.convertLazy(file);
	// A factory-created Identifier has no parent — walking up
	// `tsNode.parent` from it yields undefined immediately, so the
	// materialize loop exits with `parent === null` and falls through to
	// the GenericTSNode(parent=null) branch.
	const detached = ts.factory.createIdentifier('detached');
	let threw: unknown;
	let result: unknown;
	try {
		result = lazy.materialize(detached, context);
	}
	catch (e) {
		threw = e;
	}
	check(
		'materialize: GenericTSNode fallback receives ctx (no parent!._ctx throw)',
		threw === undefined,
		threw ? `threw: ${(threw as Error).message}` : 'unexpected',
	);
	check(
		'materialize: GenericTSNode fallback returns a usable node',
		!!result && typeof (result as { type?: unknown }).type === 'string',
		`got: ${result === undefined ? 'undefined' : typeof result}`,
	);
}

// 3f. `prefer-const` with array destructuring + mixed reassign — under
//     ESLint's default `destructuring: 'any'`, each binding is evaluated
//     independently: bindings never reassigned report individually even
//     if a sibling IS reassigned. Surfaced on TS repo
//     `src/compiler/moduleSpecifiers.ts:407` where 4 of 5 bindings should
//     report. Originally TSSLint reported 0 (acted like `'all'`).
{
	// `modulePaths` is reassigned via `||=`; `kind`, `specifiers`,
	// `moduleSourceFile`, `cache` are read-only → 4 reports expected.
	const code = `
function f(): [number, string, object, number[], Set<number> | undefined] {
	return [0, '', {}, [], undefined];
}
function g() {
	let [kind, specifiers, moduleSourceFile, modulePaths, cache] = f();
	if (specifiers) return kind;
	if (!moduleSourceFile) return undefined;
	modulePaths ||= [];
	cache?.add(modulePaths.length);
	return modulePaths.length;
}
`;
	const { program, file } = buildProgram(code);
	const eslintRoot = require('path').dirname(require.resolve('eslint/package.json'));
	const preferConst = require(eslintRoot + '/lib/rules/prefer-const.js');
	const reports: { msg: string }[] = [];
	const tsslintRule = compat.convertRule(preferConst, [], { id: 'prefer-const' });
	const reportFn: any = (msg: string) => {
		reports.push({ msg });
		const r: any = {
			at() {
				return r;
			},
			asWarning() {
				return r;
			},
			asError() {
				return r;
			},
			asSuggestion() {
				return r;
			},
			withFix() {
				return r;
			},
			withRefactor() {
				return r;
			},
			withDeprecated() {
				return r;
			},
			withUnnecessary() {
				return r;
			},
			withoutCache() {
				return r;
			},
		};
		return r;
	};
	tsslintRule({ file, report: reportFn, program } as any);
	check(
		'prefer-const: array destructuring with mixed reassign reports each non-reassigned binding (destructuring: any default)',
		reports.length === 4,
		`got ${reports.length} reports: ${reports.map(r => r.msg).join(' | ')}`,
	);
}

// 3g. ECMAScript built-in globals (`undefined`, `Math`, `String`, etc.)
//     must NOT be reported by `no-undef`. ESLint core registers them via
//     `addDeclaredGlobals` from `conf/globals.js`'s per-ecmaVersion list;
//     compat-eslint mirrors this by calling `scopeManager.addGlobals(...)`
//     in `getEstree`. Without that step, every `undefined`/`Math`/`String`
//     reference fires `no-undef` (5027 false positives on TS repo
//     src/compiler before the fix).
//
//     `@typescript-eslint/scope-manager`'s lib data merges
//     es5's `[Math, TYPE_VALUE]` with es2015.core's `[Math, TYPE]`,
//     ending up TYPE-only — so `isValueVariable=false` and
//     scope-manager wouldn't add it as a usable global. ESLint's
//     hard-coded `conf/globals.js` is the source of truth for "which
//     names should never be `no-undef`'d."
{
	const code = `
const a = undefined;
const b = Math.PI;
const c = String(1);
const d = Array.isArray([]);
const e = JSON.stringify({});
const f = parseInt('1', 10);
const g = NOT_A_REAL_GLOBAL;
`;
	const { program, file } = buildProgram(code);
	const eslintRoot = require('path').dirname(require.resolve('eslint/package.json'));
	const noUndef = require(eslintRoot + '/lib/rules/no-undef.js');
	const reports: { msg: string }[] = [];
	const tsslintRule = compat.convertRule(noUndef, [], { id: 'no-undef' });
	const reportFn: any = (msg: string) => {
		reports.push({ msg });
		const r: any = {
			at() {
				return r;
			},
			asWarning() {
				return r;
			},
			asError() {
				return r;
			},
			asSuggestion() {
				return r;
			},
			withFix() {
				return r;
			},
			withRefactor() {
				return r;
			},
			withDeprecated() {
				return r;
			},
			withUnnecessary() {
				return r;
			},
			withoutCache() {
				return r;
			},
		};
		return r;
	};
	tsslintRule({ file, report: reportFn, program } as any);
	check(
		'no-undef: built-in ECMAScript globals (undefined/Math/String/Array/JSON/parseInt) are recognised',
		reports.length === 1,
		`expected 1 report (NOT_A_REAL_GLOBAL); got ${reports.length}: ${reports.map(r => r.msg).join(' | ')}`,
	);
	check(
		'no-undef: the one report is for the truly undefined name',
		reports.length === 1 && reports[0].msg.includes('NOT_A_REAL_GLOBAL'),
		`got: ${reports[0]?.msg}`,
	);
}

// 3h. `TsVariable.defs` must filter out declarations that aren't in the
//     user's source file (e.g. TS lib `.d.ts` declarations for `Map`,
//     `Set`, `Promise`). `materialize()` can't reach lib-source nodes
//     because `convertLazy` only pre-registers the user's SourceFile,
//     so they fall back to `GenericTSNode(parent=null)`. Rules that
//     read `def.node.parent.type` (naming-convention's
//     `collectVariables` → `isExported`, no-unused-vars, no-redeclare)
//     crash on null parent. Upstream models the same symbols as
//     `ImplicitLibVariable` with empty defs.
//
//     Originally surfaced when adding `addGlobals` made eager
//     `_ensureRefIndex()` populate lib vars in globalScope before
//     naming-convention's `collectVariables` walked them.
{
	// `Map<string>` is a type-only lib reference — scope-manager adds the
	// Map symbol's TsVariable to globalScope. Without the filter, its
	// defs[0].node materializes from lib.es2015.collection.d.ts and
	// returns GenericTSNode(parent=null). naming-convention crashes on
	// `def.node.parent.type.startsWith('Export')`.
	const code = `
const m: Map<string, number> = new Map();
const x = m.size;
`;
	const { program, file } = buildProgram(code);
	const eslintRoot = require('path').dirname(require.resolve('eslint/package.json'));
	const tsPlugin = require(require.resolve('@typescript-eslint/eslint-plugin', { paths: [eslintRoot] }));
	const namingConvention = tsPlugin.rules['naming-convention'];
	const reports: { msg: string }[] = [];
	const tsslintRule = compat.convertRule(
		namingConvention,
		[{ selector: 'typeLike', format: ['PascalCase'] }],
		{ id: 'naming-convention' },
	);
	const reportFn: any = (msg: string) => {
		reports.push({ msg });
		const r: any = {
			at() {
				return r;
			},
			asWarning() {
				return r;
			},
			asError() {
				return r;
			},
			asSuggestion() {
				return r;
			},
			withFix() {
				return r;
			},
			withRefactor() {
				return r;
			},
			withDeprecated() {
				return r;
			},
			withUnnecessary() {
				return r;
			},
			withoutCache() {
				return r;
			},
		};
		return r;
	};
	let threw: unknown;
	try {
		tsslintRule({ file, report: reportFn, program } as any);
	}
	catch (e) {
		threw = e;
	}
	check(
		'TsVariable.defs: lib-source declarations are filtered (no naming-convention crash on def.node.parent.type)',
		threw === undefined,
		threw ? `threw: ${(threw as Error).message}` : 'unexpected',
	);
}

// 3i. `addGlobals` must NOT trigger eager `materialize()` on through
//     ref identifiers — doing so partially populates the lazy ESTree
//     wrapper cache (ChainExpression / ExportNamedDeclaration /
//     TSParameterProperty etc.) before ts-ast-scan walks the AST. The
//     pre-built wrappers desync CPA's choice-context stack: enter fires
//     for a wrapper that ts-ast-scan's source-order traversal didn't
//     produce, so push/pop pair-up breaks and `popChoiceContext` reads
//     null. Crashes 9 files in TS repo's `src/compiler` with
//     `TypeError: Cannot read properties of null (reading
//     'trueForkContext')`.
//
//     Fix: read `ref.tsIdentifier.text` directly (pure TS) instead of
//     `ref.identifier.name` (lazy materialize).
//
//     Repro: a control-flow rule registers `onCodePath*` listeners,
//     forcing the CPA dispatch path. The file contains a logical
//     expression nested inside an optional chain (or any chain wrapper)
//     where one operand references a global like `Math` — addGlobals's
//     re-resolution loop materializes that operand's chain, the wrapper
//     class registers itself in the cache, and the later traversal
//     dispatches enter on it out of order.
{
	// Minimal pattern: optional chain + logical expression with global
	// reference. consistent-return triggers CPA dispatch.
	const code = `
function f(obj?: { x: { y: string } | undefined }) {
	if (obj?.x?.y && Math.random() > 0.5) {
		return obj.x.y;
	}
	return undefined;
}
`;
	const { program, file } = buildProgram(code);
	const eslintRoot = require('path').dirname(require.resolve('eslint/package.json'));
	const consistentReturn = require(eslintRoot + '/lib/rules/consistent-return.js');
	const reports: { msg: string }[] = [];
	const tsslintRule = compat.convertRule(consistentReturn, [], { id: 'consistent-return' });
	const reportFn: any = (msg: string) => {
		reports.push({ msg });
		const r: any = {
			at() {
				return r;
			},
			asWarning() {
				return r;
			},
			asError() {
				return r;
			},
			asSuggestion() {
				return r;
			},
			withFix() {
				return r;
			},
			withRefactor() {
				return r;
			},
			withDeprecated() {
				return r;
			},
			withUnnecessary() {
				return r;
			},
			withoutCache() {
				return r;
			},
		};
		return r;
	};
	let threw: unknown;
	try {
		tsslintRule({ file, report: reportFn, program } as any);
	}
	catch (e) {
		threw = e;
	}
	check(
		'addGlobals: no eager materialize, CPA stack stays balanced (no popChoiceContext null crash)',
		threw === undefined,
		threw ? `threw: ${(threw as Error).message}` : 'unexpected',
	);
}

// 3j. `BinaryExpression(operator=',')` must convert to ESTree
//     `SequenceExpression`, not stay as BinaryExpression. typescript-
//     estree's `convertBinaryExpression` checks the operator and emits
//     SequenceExpression with `expressions[]`, flattening nested commas
//     unless the left side is parenthesized. Without the conversion,
//     `no-sequences` (listens on `SequenceExpression`) misses every
//     comma-operator usage — 34 false negatives on TS repo's
//     `src/compiler` before the fix.
{
	// `a, b` BARE (no parens) is reported. With `allowInParentheses`
	// default-true, parens around the sequence skip the report — so the
	// repro must avoid parens. `for (init; test; update)` pieces also
	// need bare commas. The flatten case `a, b, c` ensures the
	// SequenceExpression has 3 expressions (not nested).
	const code = `
let x: number;
function f() {
	for (let i = 0, j = 0; i < 10; i++, j++) { x = i, j; }
}
`;
	const { program, file } = buildProgram(code);
	const eslintRoot = require('path').dirname(require.resolve('eslint/package.json'));
	const noSequences = require(eslintRoot + '/lib/rules/no-sequences.js');
	const reports: { msg: string }[] = [];
	const tsslintRule = compat.convertRule(noSequences, [], { id: 'no-sequences' });
	const reportFn: any = (msg: string) => {
		reports.push({ msg });
		const r: any = {
			at() {
				return r;
			},
			asWarning() {
				return r;
			},
			asError() {
				return r;
			},
			asSuggestion() {
				return r;
			},
			withFix() {
				return r;
			},
			withRefactor() {
				return r;
			},
			withDeprecated() {
				return r;
			},
			withUnnecessary() {
				return r;
			},
			withoutCache() {
				return r;
			},
		};
		return r;
	};
	tsslintRule({ file, report: reportFn, program } as any);
	// `x = i, j` — bare comma in expression statement. Not in
	// allowed-parens skip list, not for-update, no parens → reports.
	check(
		'SequenceExpression: BinaryExpression(",") converts to SequenceExpression so no-sequences fires',
		reports.length === 1,
		`expected 1 report; got ${reports.length}`,
	);
}

// 3k. `convertRule` must DEEP-merge `meta.defaultOptions` with the
//     user-supplied options (mirroring ESLint's
//     `eslint/lib/shared/deep-merge-arrays.js`). Previous behaviour was
//     element-wise nullish coalescing — when the user passed
//     `{ functions: false, classes: false }` to `no-use-before-define`,
//     the rule's other defaults (`enums: true`, `variables: true`,
//     `ignoreTypeReferences: true`, …) ended up `undefined`. The
//     `!options.enums && definitionType === 'TSEnumName'` guard then
//     evaluated `!undefined` as truthy and SKIPPED every const-enum /
//     type / variable use-before-define case (~376 false negatives on
//     TS repo `src/compiler` before the fix).
{
	const code = `
namespace M {
	function f() { return Bar.A; }
	const enum Bar { A, B }
	f();
}
`;
	const { program, file } = buildProgram(code);
	const eslintRoot = require('path').dirname(require.resolve('eslint/package.json'));
	const noUseBeforeDef = require(eslintRoot + '/lib/rules/no-use-before-define.js');
	const reports: { msg: string }[] = [];
	const tsslintRule = compat.convertRule(
		noUseBeforeDef,
		// Partial user options — the merge must fill in `enums: true`
		// from defaultOptions for the rule to fire on the const enum.
		[{ functions: false, classes: false }],
		{ id: 'no-use-before-define' },
	);
	const reportFn: any = (msg: string) => {
		reports.push({ msg });
		const r: any = {
			at() {
				return r;
			},
			asWarning() {
				return r;
			},
			asError() {
				return r;
			},
			asSuggestion() {
				return r;
			},
			withFix() {
				return r;
			},
			withRefactor() {
				return r;
			},
			withDeprecated() {
				return r;
			},
			withUnnecessary() {
				return r;
			},
			withoutCache() {
				return r;
			},
		};
		return r;
	};
	tsslintRule({ file, report: reportFn, program } as any);
	check(
		'convertRule: deep-merges meta.defaultOptions with user options (no-use-before-define enums fires on const enum)',
		reports.length === 1 && reports[0].msg.includes("'Bar'"),
		`expected 1 report for Bar; got ${reports.length}: ${reports.map(r => r.msg).join(' | ')}`,
	);
}

// 3l. `TsVariable.isValueVariable` / `isTypeVariable` must mirror
//     upstream's `Variable.isValueVariable = defs.some(d =>
//     d.isVariableDefinition)`. Reading `symbol.flags & SymbolFlags.Value`
//     directly misses ImportBinding (TS Alias symbols don't have the
//     Value bit set until alias resolution). `no-shadow`'s
//     `isTypeValueShadow` then sees the imported value as
//     `isValueVariable=false`, the function param as
//     `isValueVariable=true`, decides "type-value mismatch", and SKIPS
//     the report — 147 false negatives on TS repo `src/compiler`.
{
	// Module-level `import { sys }` (value) vs function-param `sys` (value)
	// — same value/value pair. ESLint reports the shadow. TSSLint
	// must too.
	const code = `
import { sys } from './y.js';
function f(sys: string) { return sys; }
`;
	const { program, file } = buildProgram(code);
	const eslintRoot = require('path').dirname(require.resolve('eslint/package.json'));
	const noShadow = require(eslintRoot + '/lib/rules/no-shadow.js');
	const reports: { msg: string }[] = [];
	const tsslintRule = compat.convertRule(noShadow, [], { id: 'no-shadow' });
	const reportFn: any = (msg: string) => {
		reports.push({ msg });
		const r: any = {
			at() {
				return r;
			},
			asWarning() {
				return r;
			},
			asError() {
				return r;
			},
			asSuggestion() {
				return r;
			},
			withFix() {
				return r;
			},
			withRefactor() {
				return r;
			},
			withDeprecated() {
				return r;
			},
			withUnnecessary() {
				return r;
			},
			withoutCache() {
				return r;
			},
		};
		return r;
	};
	tsslintRule({ file, report: reportFn, program } as any);
	check(
		'TsVariable.isValueVariable: ImportBinding counts as value (no-shadow fires on import-vs-param value/value shadow)',
		reports.length === 1 && reports[0].msg.includes("'sys'"),
		`expected 1 sys shadow; got ${reports.length}: ${reports.map(r => r.msg).join(' | ')}`,
	);
}

// 3m. `TsScope.block` and `TsDefinition.node` must unwrap
//     `ExportNamedDeclaration` / `ExportDefaultDeclaration` wrappers.
//     `materialize(FunctionDeclaration)` for an exported function returns
//     the export wrapper (because it claims the cache slot). ESLint
//     listens on `FunctionDeclaration` and tests `scope.block === node`
//     to enter the scope; without unwrapping, comparison fails and
//     `no-redeclare` skips the entire function body — 111 false
//     negatives on overloaded exported functions in TS repo
//     `src/compiler`.
{
	// Mirror TS repo's `factory/nodeFactory.ts` createToken pattern:
	// exported function with overloaded inner function. ESLint reports
	// the overloads as redeclarations.
	const code = `
export function outer() {
	function inner(x: number): void;
	function inner(x: string): void;
	function inner(x: any): void {}
	return inner;
}
`;
	const { program, file } = buildProgram(code);
	const eslintRoot = require('path').dirname(require.resolve('eslint/package.json'));
	const noRedecl = require(eslintRoot + '/lib/rules/no-redeclare.js');
	const reports: { msg: string }[] = [];
	const tsslintRule = compat.convertRule(noRedecl, [], { id: 'no-redeclare' });
	const reportFn: any = (msg: string) => {
		reports.push({ msg });
		const r: any = {
			at() {
				return r;
			},
			asWarning() {
				return r;
			},
			asError() {
				return r;
			},
			asSuggestion() {
				return r;
			},
			withFix() {
				return r;
			},
			withRefactor() {
				return r;
			},
			withDeprecated() {
				return r;
			},
			withUnnecessary() {
				return r;
			},
			withoutCache() {
				return r;
			},
		};
		return r;
	};
	tsslintRule({ file, report: reportFn, program } as any);
	check(
		'scope.block / def.node: unwrap export wrappers (no-redeclare fires on overloads inside exported function)',
		reports.length === 2,
		`expected 2 inner overload redeclares; got ${reports.length}`,
	);
}

// 3n. `scope.through` must use `_variableBySymbol` (alias-aware) instead
//     of comparing `v.symbol === ref.symbol` directly. TS gives synthetic
//     `arguments` two distinct ts.Symbol instances:
//     `getSymbolsInScope(body, Variable)` returns one (stored on
//     `argsVar.symbol`), `getSymbolAtLocation(node)` returns another
//     (stored on `ref.symbol`). Both bound via `_variableBySymbol` to
//     the same TsVariable. Without the alias-aware lookup, refs to
//     `arguments` escape the function scope and report as undefined.
//     Same shape applies to lib globals (Map / Set / Object): the ref's
//     symbol differs from the stored lib var's symbol unless we register
//     it in `_variableBySymbol` at the lib-add site.
{
	const code = `
function f() {
	if (arguments.length > 0) return 1;
	const m = new Map<string, number>();
	return m.size;
}
`;
	const { program, file } = buildProgram(code);
	const eslintRoot = require('path').dirname(require.resolve('eslint/package.json'));
	const noUndef = require(eslintRoot + '/lib/rules/no-undef.js');
	const reports: { msg: string }[] = [];
	const tsslintRule = compat.convertRule(noUndef, [], { id: 'no-undef' });
	const reportFn: any = (msg: string) => {
		reports.push({ msg });
		const r: any = {
			at() {
				return r;
			},
			asWarning() {
				return r;
			},
			asError() {
				return r;
			},
			asSuggestion() {
				return r;
			},
			withFix() {
				return r;
			},
			withRefactor() {
				return r;
			},
			withDeprecated() {
				return r;
			},
			withUnnecessary() {
				return r;
			},
			withoutCache() {
				return r;
			},
		};
		return r;
	};
	tsslintRule({ file, report: reportFn, program } as any);
	check(
		'scope.through: alias-aware lookup resolves synthetic `arguments` and lib `Map` (no-undef false positives)',
		reports.length === 0,
		`expected 0 reports; got ${reports.length}: ${reports.map(r => r.msg).join(' | ')}`,
	);
}

// 3o. `export { foo }` (no `from`) must resolve `foo` to the LOCAL
//     binding. TS produces an alias Symbol whose declaration is the
//     ExportSpecifier — distinct from the local symbol. Without using
//     `getExportSpecifierLocalTargetSymbol`, the ref doesn't resolve and
//     reports as undefined. Originally surfaced on TS repo's
//     `_namespaces/ts.ts` (`import * as performance; export
//     { performance };` reported `performance` undefined).
{
	const code = `
import * as foo from "./foo.js";
export { foo };
`;
	const { program, file } = buildProgram(code);
	const eslintRoot = require('path').dirname(require.resolve('eslint/package.json'));
	const noUndef = require(eslintRoot + '/lib/rules/no-undef.js');
	const reports: { msg: string }[] = [];
	const tsslintRule = compat.convertRule(noUndef, [], { id: 'no-undef' });
	const reportFn: any = (msg: string) => {
		reports.push({ msg });
		const r: any = {
			at() {
				return r;
			},
			asWarning() {
				return r;
			},
			asError() {
				return r;
			},
			asSuggestion() {
				return r;
			},
			withFix() {
				return r;
			},
			withRefactor() {
				return r;
			},
			withDeprecated() {
				return r;
			},
			withUnnecessary() {
				return r;
			},
			withoutCache() {
				return r;
			},
		};
		return r;
	};
	tsslintRule({ file, report: reportFn, program } as any);
	check(
		'export specifier: re-export resolves to local target via getExportSpecifierLocalTargetSymbol',
		reports.length === 0,
		`expected 0; got ${reports.length}: ${reports.map(r => r.msg).join(' | ')}`,
	);
}

// 3p. `TsDefinition.parent` for `ImportSpecifier` / `NamespaceImport` /
//     `ImportClause` must walk up past `NamedImports` / `ImportClause`
//     to the `ImportDeclaration`. ESTree skips those wrappers — an
//     `ImportSpecifier`'s parent IS `ImportDeclaration`. no-shadow's
//     `isTypeValueShadow` reads
//     `def.parent.specifiers.some(s => s.importKind === 'type')` to
//     widen the type-value shadow filter when ANY specifier in the
//     same import is type-only; without unwrapping we hand back
//     `TSNamedImports`, the check silently fails, and the rule
//     over-reports param/const shadows of imported names. Surfaced as
//     19 false positives in TS repo's `src/compiler/utilities.ts`.
{
	// `import { length, type SomeType }` makes `length` a value but the
	// import block has a type-only specifier — no-shadow should skip
	// the `length` parameter shadow check.
	const code = `
import { length, type SomeType } from "./y.js";
function f(start: number, length: number) { return start + length; }
`;
	const { program, file } = buildProgram(code);
	const eslintRoot = require('path').dirname(require.resolve('eslint/package.json'));
	const noShadow = require(eslintRoot + '/lib/rules/no-shadow.js');
	const reports: { msg: string }[] = [];
	const tsslintRule = compat.convertRule(noShadow, [], { id: 'no-shadow' });
	const reportFn: any = (msg: string) => {
		reports.push({ msg });
		const r: any = {
			at() {
				return r;
			},
			asWarning() {
				return r;
			},
			asError() {
				return r;
			},
			asSuggestion() {
				return r;
			},
			withFix() {
				return r;
			},
			withRefactor() {
				return r;
			},
			withDeprecated() {
				return r;
			},
			withUnnecessary() {
				return r;
			},
			withoutCache() {
				return r;
			},
		};
		return r;
	};
	tsslintRule({ file, report: reportFn, program } as any);
	check(
		'TsDefinition.parent: ImportSpecifier walks to ImportDeclaration so no-shadow filter sees specifiers',
		reports.length === 0,
		`expected 0 (any-type-specifier widens skip); got ${reports.length}: ${reports.map(r => r.msg).join(' | ')}`,
	);
}

// 3q. `TSImportType` qualifier (`import("mod").Foo`,
//     `import("mod").Foo.Bar`) must NOT be classified as a free
//     reference. The qualifier names exports of the imported module,
//     not locals. Upstream's TypeVisitor explicitly skips visiting
//     them. Without the skip, every `Foo` ends up in
//     `globalScope.through` → no-undef false positive.
{
	const code = `
function f(): import("inspector").Profiler.Profile { return null as any; }
function g(): import("inspector").Session { return null as any; }
`;
	const { program, file } = buildProgram(code);
	const eslintRoot = require('path').dirname(require.resolve('eslint/package.json'));
	const noUndef = require(eslintRoot + '/lib/rules/no-undef.js');
	const reports: { msg: string }[] = [];
	const tsslintRule = compat.convertRule(noUndef, [], { id: 'no-undef' });
	const reportFn: any = (msg: string) => {
		reports.push({ msg });
		const r: any = {
			at() {
				return r;
			},
			asWarning() {
				return r;
			},
			asError() {
				return r;
			},
			asSuggestion() {
				return r;
			},
			withFix() {
				return r;
			},
			withRefactor() {
				return r;
			},
			withDeprecated() {
				return r;
			},
			withUnnecessary() {
				return r;
			},
			withoutCache() {
				return r;
			},
		};
		return r;
	};
	tsslintRule({ file, report: reportFn, program } as any);
	check(
		'TSImportType qualifier: not classified as a free reference (single + nested QualifiedName)',
		reports.length === 0,
		`expected 0; got ${reports.length}: ${reports.map(r => r.msg).join(' | ')}`,
	);
}

// 3r. Conditional type's `infer X` must define `X` in the conditional's
//     scope. Upstream's `TypeVisitor.TSConditionalType` opens a scope
//     and `TSInferType` defines the inferred type parameter on it.
//     Without this, refs to the inferred name escape to globalScope
//     → no-undef false positive on patterns like
//     `T extends { name: infer TName } ? TName : never`.
{
	const code = `
type ExtractName<T> = T extends { name: infer TName } ? TName extends string ? TName : never : never;
`;
	const { program, file } = buildProgram(code);
	const eslintRoot = require('path').dirname(require.resolve('eslint/package.json'));
	const noUndef = require(eslintRoot + '/lib/rules/no-undef.js');
	const reports: { msg: string }[] = [];
	const tsslintRule = compat.convertRule(noUndef, [], { id: 'no-undef' });
	const reportFn: any = (msg: string) => {
		reports.push({ msg });
		const r: any = {
			at() {
				return r;
			},
			asWarning() {
				return r;
			},
			asError() {
				return r;
			},
			asSuggestion() {
				return r;
			},
			withFix() {
				return r;
			},
			withRefactor() {
				return r;
			},
			withDeprecated() {
				return r;
			},
			withUnnecessary() {
				return r;
			},
			withoutCache() {
				return r;
			},
		};
		return r;
	};
	tsslintRule({ file, report: reportFn, program } as any);
	check(
		'infer type parameter: defined on the enclosing conditional-type scope',
		reports.length === 0,
		`expected 0; got ${reports.length}: ${reports.map(r => r.msg).join(' | ')}`,
	);
}

// 3s. `BindingElement` with a `ComputedPropertyName` propertyName must
//     mark the materialised Property as `computed: true`. Pattern:
//     `const { ["foo-bar"]: x } = obj` — the propertyName is wrapped in
//     `ComputedPropertyName`. no-useless-computed-key listens on
//     `Property` and reads `node.computed`; without the flag it never
//     fires on destructure-with-computed-key.
{
	const code = `
const obj = { "foo-bar": 1 };
const { ["foo-bar"]: x } = obj;
console.log(x);
`;
	const { program, file } = buildProgram(code);
	const eslintRoot = require('path').dirname(require.resolve('eslint/package.json'));
	const noUselessComputedKey = require(eslintRoot + '/lib/rules/no-useless-computed-key.js');
	const reports: { msg: string }[] = [];
	const tsslintRule = compat.convertRule(noUselessComputedKey, [], { id: 'no-useless-computed-key' });
	const reportFn: any = (msg: string) => {
		reports.push({ msg });
		const r: any = {
			at() {
				return r;
			},
			asWarning() {
				return r;
			},
			asError() {
				return r;
			},
			asSuggestion() {
				return r;
			},
			withFix() {
				return r;
			},
			withRefactor() {
				return r;
			},
			withDeprecated() {
				return r;
			},
			withUnnecessary() {
				return r;
			},
			withoutCache() {
				return r;
			},
		};
		return r;
	};
	tsslintRule({ file, report: reportFn, program } as any);
	check(
		'BindingElement.computed: ComputedPropertyName propertyName produces Property with computed=true',
		reports.length === 1,
		`expected 1 useless-computed-key on the destructure key; got ${reports.length}`,
	);
}

// 3t. TS lib utility types (`Pick`, `Record`, `Extract`, `Partial`, …)
//     used in type-arg positions must NOT be reported by `no-undef`.
//     Sanity check: `applyEslintGlobals` registers them via
//     `addGlobals(TS_LIB_TYPE_GLOBALS)` and the through-ref reconciliation
//     drains those names from `_through`. Companion lib-detection
//     reuse-fake fix is exercised by the TS-repo benchmark (712 → 56
//     no-undef over-fire reduction); single-file fixtures don't
//     trigger the lib-detection path because `getSymbolAtLocation` on a
//     TypeReference's typeName returns undefined unless the program
//     has more cross-file context (so reconciliation alone covers
//     the leak in this simple form).
{
	const code = `
type A = Pick<{ a: 1; b: 2 }, 'a'>;
type B = Record<string, number>;
type C = Extract<'a' | 'b' | 'c', 'a' | 'b'>;
type D = Partial<{ a: 1 }>;
type E = NonNullable<string | null>;
type F = Exclude<'a' | 'b', 'a'>;
function f(x: A, y: B, z: C): D | E | F { return null!; }
f({ a: 1 } as A, {} as B, 'a' as C);
`;
	const { program, file } = buildProgram(code);
	const eslintRoot = require('path').dirname(require.resolve('eslint/package.json'));
	const noUndef = require(eslintRoot + '/lib/rules/no-undef.js');
	const reports: { msg: string }[] = [];
	const tsslintRule = compat.convertRule(noUndef, [], { id: 'no-undef' });
	const reportFn: any = (msg: string) => {
		reports.push({ msg });
		const r: any = {
			at() { return r; },
			asWarning() { return r; },
			asError() { return r; },
			asSuggestion() { return r; },
			withFix() { return r; },
			withRefactor() { return r; },
			withDeprecated() { return r; },
			withUnnecessary() { return r; },
			withoutCache() { return r; },
		};
		return r;
	};
	tsslintRule({ file, report: reportFn, program } as any);
	check(
		'no-undef: TS lib utility types in type-arg positions are recognised globals',
		reports.length === 0,
		`expected 0 reports; got ${reports.length}: ${reports.map(r => r.msg).join(' | ')}`,
	);
}

// 3u. Type parameters in `.d.ts` files where the host declaration merges
//     across files (cross-file declaration merging — TS lib types
//     declared in both bundled `lib.*.d.ts` and user-loaded
//     `src/lib/*.d.ts`, ambient interface redeclarations, etc.) must
//     still resolve at usage sites. `_collectVariables` binds the type
//     param via `getSymbolAtLocation(tp.name)` so registration uses the
//     SAME symbol identity that reference resolution returns. Pre-fix
//     it used `tp.symbol` (the local declaration symbol) which differs
//     from the merged symbol the resolver returns; without the fix
//     `variableBySymbol.get(refSym)` misses and the type param leaks to
//     `through`. Repro requires a multi-file program — single-file
//     interfaces don't trigger merging.
{
	const fA = '/a.d.ts';
	const fB = '/b.d.ts';
	const codeA = `interface Container<T> { value: T; }\n`;
	const codeB = `interface Container<T> { extra: T; map(fn: (v: T) => T): T; }\n`;
	const sfA = ts.createSourceFile(fA, codeA, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
	const sfB = ts.createSourceFile(fB, codeB, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
	const realLibPath = ts.getDefaultLibFilePath({ target: ts.ScriptTarget.Latest });
	const realLibName = realLibPath.split(/[\\/]/).pop()!;
	const realLibContent = ts.sys.readFile(realLibPath) ?? '';
	const realLib = ts.createSourceFile(realLibPath, realLibContent, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
	const host: ts.CompilerHost = {
		getSourceFile: n => n === fA ? sfA : (n === fB ? sfB : (n === realLibPath ? realLib : undefined)),
		getDefaultLibFileName: () => realLibName,
		getDefaultLibLocation: () => realLibPath.replace('/' + realLibName, ''),
		writeFile: () => {},
		getCurrentDirectory: () => '/',
		getDirectories: () => [],
		fileExists: n => n === fA || n === fB || n === realLibPath,
		readFile: n => n === fA ? codeA : (n === fB ? codeB : (n === realLibPath ? realLibContent : undefined)),
		getCanonicalFileName: n => n,
		useCaseSensitiveFileNames: () => true,
		getNewLine: () => '\n',
	};
	const program = ts.createProgram({
		rootNames: [fA, fB],
		options: { target: ts.ScriptTarget.Latest, lib: [realLibName], strict: true, noEmit: true },
		host,
	});
	const eslintRoot = require('path').dirname(require.resolve('eslint/package.json'));
	const noUndef = require(eslintRoot + '/lib/rules/no-undef.js');
	const reports: { msg: string }[] = [];
	const tsslintRule = compat.convertRule(noUndef, [], { id: 'no-undef' });
	const reportFn: any = (msg: string) => {
		reports.push({ msg });
		const r: any = {
			at() { return r; },
			asWarning() { return r; },
			asError() { return r; },
			asSuggestion() { return r; },
			withFix() { return r; },
			withRefactor() { return r; },
			withDeprecated() { return r; },
			withUnnecessary() { return r; },
			withoutCache() { return r; },
		};
		return r;
	};
	// Lint /b.d.ts — the references to T inside Container<T> should
	// resolve to the merged Container symbol's type parameter, not leak.
	tsslintRule({ file: program.getSourceFile(fB), report: reportFn, program } as any);
	check(
		'no-undef: type parameters in cross-file-merged ambient interfaces resolve',
		reports.length === 0,
		`expected 0 reports; got ${reports.length}: ${reports.map(r => r.msg).join(' | ')}`,
	);
}

// 3w. `var.references` for a lib-utility-type global (Pick / Record / …)
//     must include every type-position usage. Bug: when `addGlobals`
//     pre-registered a fake var and the lib-detection path reuses it,
//     the FIRST hit was keyed under the real ts.Symbol while subsequent
//     hits (which take the `variableBySymbol.has(sym)` branch with
//     `sym=realSym, v=fakeVar`) keyed under `v.symbol` (the fake
//     symbol). `getReferencesFor(fakeSym)` then returned only the
//     subsequent refs — the first one was orphaned in a separate
//     `refs.get(realSym)` bucket. Off-by-one on every lib-utility-type
//     variable's reference list.
//
//     The bug only surfaces when the lib-detection path actually fires
//     — `getSymbolAtLocation(Pick)` returns the real lib symbol. Repro
//     needs every `lib.*.d.ts` pre-cached so cross-lib resolution sees
//     them; the standard `buildProgram` only loads the default lib.
{
	const code = `
type A1 = Pick<{ a: 1 }, 'a'>;
type A2 = Pick<{ b: 2 }, 'b'>;
type A3 = Pick<{ c: 3 }, 'c'>;
type B1 = Omit<{ a: 1 }, 'a'>;
type B2 = Omit<{ b: 2 }, 'b'>;
type C = Record<string, number>;
type D = Awaited<Promise<number>>;
`;
	const fileName = '/test.ts';
	const sf = ts.createSourceFile(fileName, code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
	const realLibPath = ts.getDefaultLibFilePath({ target: ts.ScriptTarget.Latest });
	const libDir = realLibPath.replace(/[/\\][^/\\]+$/, '');
	const fs = require('fs') as typeof import('fs');
	const pathMod = require('path') as typeof import('path');
	const libFiles = new Map<string, ts.SourceFile>();
	for (const f of fs.readdirSync(libDir)) {
		if (f.startsWith('lib.') && f.endsWith('.d.ts')) {
			const p = pathMod.join(libDir, f);
			libFiles.set(
				p,
				ts.createSourceFile(p, fs.readFileSync(p, 'utf-8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS),
			);
		}
	}
	const realLibName = realLibPath.split(/[\\/]/).pop()!;
	const host: ts.CompilerHost = {
		getSourceFile: n => n === fileName ? sf : libFiles.get(n),
		getDefaultLibFileName: () => realLibName,
		getDefaultLibLocation: () => libDir,
		writeFile: () => {},
		getCurrentDirectory: () => '/',
		getDirectories: () => [],
		fileExists: n => n === fileName || libFiles.has(n),
		readFile: n => n === fileName ? code : libFiles.get(n)?.text,
		getCanonicalFileName: n => n,
		useCaseSensitiveFileNames: () => true,
		getNewLine: () => '\n',
	};
	const program = ts.createProgram({
		rootNames: [fileName, realLibPath],
		options: { target: ts.ScriptTarget.Latest, strict: true, noEmit: true, noLib: false },
		host,
	});
	const file = program.getSourceFile(fileName)!;
	const refCounts = new Map<string, number>();
	const inspectRule: ESLint.Rule.RuleModule = {
		meta: { type: 'problem', schema: [], messages: { x: 'x' } } as any,
		create(ctx) {
			return {
				'Program:exit'(node: any) {
					// Walk up to globalScope — lib-utility-type fakes
					// (`Pick` / `Omit` / `Record` / `Awaited`) are
					// registered there via `addGlobals`, not in module scope.
					let scope: any = ctx.sourceCode.getScope(node);
					while (scope?.upper) scope = scope.upper;
					for (const v of scope.variables) {
						if (['Pick', 'Omit', 'Record', 'Awaited'].includes(v.name)) {
							refCounts.set(v.name, v.references.length);
						}
					}
				},
			};
		},
	};
	const tsslintRule = compat.convertRule(inspectRule, [], { id: 'inspect-refs' });
	tsslintRule({
		file,
		program,
		report: () => ({
			at: () => ({} as any),
			asWarning: () => ({} as any),
			asError: () => ({} as any),
			asSuggestion: () => ({} as any),
			withFix: () => ({} as any),
			withRefactor: () => ({} as any),
			withDeprecated: () => ({} as any),
			withUnnecessary: () => ({} as any),
			withoutCache: () => ({} as any),
		} as any),
	} as any);
	check(
		`var.references: Pick has 3 refs (got ${refCounts.get('Pick') ?? 0})`,
		refCounts.get('Pick') === 3,
	);
	check(
		`var.references: Omit has 2 refs (got ${refCounts.get('Omit') ?? 0})`,
		refCounts.get('Omit') === 2,
	);
	check(
		`var.references: Record has 1 ref (got ${refCounts.get('Record') ?? 0})`,
		refCounts.get('Record') === 1,
	);
	check(
		`var.references: Awaited has 1 ref (got ${refCounts.get('Awaited') ?? 0})`,
		refCounts.get('Awaited') === 1,
	);
}

// 3x. Multi-level child chain with field-walk fast path — when a
//     selector has the shape `A > B.f1 > C.f2`, dispatch should
//     trigger on the OUTERMOST type (`A`, smallest visit set), walk
//     the field chain step-by-step (`target[f1][f2]`), type-check
//     intermediates inline, and pass the final extracted node to the
//     listener. Repro: a real-world `CallExpression > MemberExpression
//     .callee > Identifier[name="join"].property` selector.
{
	const code = `
		const arr = [1, 2, 3];
		arr.join(',');
		arr.concat([4]);
		arr.join();
		arr.toString();
	`;
	const fired: { type: string; name: string }[] = [];
	const rule: ESLint.Rule.RuleModule = {
		meta: { type: 'problem', schema: [], messages: { x: 'x' } } as any,
		create() {
			return {
				'CallExpression > MemberExpression.callee > Identifier[name="join"].property'(node: any) {
					fired.push({ type: node.type, name: node.name });
				},
			};
		},
	};
	const { program, file } = buildProgram(code);
	const tsslintRule = compat.convertRule(rule, [], { id: 'chain-fast-path' });
	tsslintRule({ file, program, report: () => ({} as any) } as any);
	check(
		'chain fast-path: listener fired exactly twice (on the two arr.join calls)',
		fired.length === 2,
		`got ${fired.length} fires`,
	);
	check(
		'chain fast-path: listener received the property Identifier (not CallExpression)',
		fired.every(f => f.type === 'Identifier' && f.name === 'join'),
		`got: ${JSON.stringify(fired)}`,
	);
}

// 3y. Catch clause's parameter must NOT dispatch as `VariableDeclarator`.
//     TS models `catch (e) { … }` as `CatchClause.variableDeclaration`
//     (a `ts.VariableDeclaration`), but ESTree exposes the param
//     directly as `CatchClause.param` (an Identifier). Without
//     excluding catch's variableDeclaration from the
//     `VariableDeclarator` predicate (and from the walker's structural-
//     skip list in CPA-allKinds mode), every `catch (e)` triggered a
//     phantom VariableDeclarator enter. Rules listening on it (e.g.
//     `no-unassigned-vars`, which checks for `let`/`var` declared
//     without assignment) fired false-positives on every catch param.
{
	const code = `
		try { throw new Error('x'); }
		catch (e) {
			console.log(e);
		}
		try { throw new Error('y'); }
		catch (err) {
			console.log(err);
		}
	`;
	const fired: { type: string; name?: string }[] = [];
	const rule: ESLint.Rule.RuleModule = {
		meta: { type: 'problem', schema: [], messages: { x: 'x' } } as any,
		create() {
			return {
				VariableDeclarator(n: any) {
					fired.push({ type: n.type, name: n.id?.name });
				},
				// Force CPA mode (predicateAllKinds) so the walker visits
				// every TS node, exercising the structural-skip list path.
				onCodePathStart() {},
			};
		},
	};
	const { program, file } = buildProgram(code);
	const tsslintRule = compat.convertRule(rule, [], { id: 'no-phantom-decl' });
	tsslintRule({ file, program, report: () => ({} as any) } as any);
	check(
		'catch param: no phantom VariableDeclarator dispatch in CPA mode',
		fired.length === 0,
		`fired: ${JSON.stringify(fired)}`,
	);
}

// 4. Mixed simple + complex selectors — descendant combinator selectors
//    decompose into a (Right type, ancestor-walk filter) tuple via
//    `decomposeSimple`, so fast dispatch handles them alongside the
//    plain identifier selectors.
{
	const code = `
		function outer() {
			function inner() {
				const x = 1;
			}
		}
	`;
	const { calls } = runMock(code, {
		'FunctionDeclaration': true,
		'FunctionDeclaration > BlockStatement > VariableDeclaration': true,
	});

	// Both listeners must fire even though one is complex (descendant).
	check(
		'mixed: simple FunctionDeclaration listener fires',
		calls.filter(c => c.selector === 'FunctionDeclaration').length === 2,
	);
	check(
		'mixed: complex `FunctionDeclaration > BlockStatement > VariableDeclaration` fires',
		calls.filter(c => c.selector.includes('VariableDeclaration')).length === 1,
	);
}

// 5. Rule-level error isolation — when one rule's listener throws, the
//    OTHER rule's listeners still fire on subsequent events.
//
// Both rules MUST be registered before either runs. `sharedCache` only
// triggers traversal once per (process, file) pair; if we registered the
// good rule after the first traversal, its listeners would never run on
// the cached eventQueue.
{
	const code = `let a = 1; let b = 2;`;
	const { program, file } = buildProgram(code);

	const goodCalls: any[] = [];
	const badRule: ESLint.Rule.RuleModule = {
		meta: { type: 'problem', schema: [], messages: { x: 'x' } } as any,
		create() {
			return {
				VariableDeclaration() {
					throw new Error('intentional');
				},
			};
		},
	};
	const goodRule: ESLint.Rule.RuleModule = {
		meta: { type: 'problem', schema: [], messages: { x: 'x' } } as any,
		create() {
			return {
				VariableDeclaration(n: any) {
					goodCalls.push(n.type);
				},
			};
		},
	};

	const badTsslintRule = compat.convertRule(badRule, [], { id: 'bad' });
	const goodTsslintRule = compat.convertRule(goodRule, [], { id: 'good' });

	const reportFn: any = () => ({
		at: () => ({ asWarning() {}, asError() {}, asSuggestion() {}, withFix() {}, withRefactor() {} }),
	});
	let badThrew: unknown;
	try {
		badTsslintRule({ file, report: reportFn, program } as any);
	}
	catch (e) {
		badThrew = e;
	}
	let goodThrew: unknown;
	try {
		goodTsslintRule({ file, report: reportFn, program } as any);
	}
	catch (e) {
		goodThrew = e;
	}

	check(
		'error isolation: bad rule re-throws on its own dispatch',
		badThrew instanceof Error && badThrew.message === 'intentional',
	);
	check(
		'error isolation: good rule still fires both VariableDeclarations',
		goodCalls.length === 2 && goodThrew === undefined,
		`goodCalls=${goodCalls.length}, threw=${String(goodThrew)}`,
	);
}

// 6. Bottom-up materialise after TS-scan dispatch — listener for an
//    ESTree type that the TS scan only entered at the wrapper level
//    (ImportDeclaration) reads `.specifiers[0]` and walks `.parent`
//    back to the import.
{
	const code = `import { a, b } from 'x';`;
	const captured: { type: string; specifierType?: string; specifierParentType?: string }[] = [];
	const { program, file } = buildProgram(code);
	const rule: ESLint.Rule.RuleModule = {
		meta: { type: 'problem', schema: [], messages: { x: 'x' } } as any,
		create() {
			return {
				ImportDeclaration(n: any) {
					const spec = n.specifiers?.[0];
					captured.push({
						type: n.type,
						specifierType: spec?.type,
						specifierParentType: spec?.parent?.type,
					});
				},
			};
		},
	};
	runRule(rule, program, file);

	check('post-dispatch: ImportDeclaration target shape correct', captured[0]?.type === 'ImportDeclaration');
	check('post-dispatch: .specifiers[0] resolves to ImportSpecifier', captured[0]?.specifierType === 'ImportSpecifier');
	check(
		'post-dispatch: specifier.parent points back to ImportDeclaration',
		captured[0]?.specifierParentType === 'ImportDeclaration',
		`got: ${captured[0]?.specifierParentType}`,
	);
}

// 7. TS-scan covers type-only triggers — for a rule with ONLY TS-typed
//    selectors (no JS-side types), confirm the trigger types fire
//    correctly even when the surrounding code is JS-heavy.
{
	const code = `
		function f() {
			const x = 1;
			function g() { return x + 1; }
			return g();
		}
		let y: number = (1 as number);
	`;
	const { calls } = runMock(code, {
		'TSAsExpression': true,
		'TSNumberKeyword': true,
	});

	check(
		'TS-scan narrow trigger: TSAsExpression fires once',
		calls.filter(c => c.selector === 'TSAsExpression').length === 1,
	);
	check(
		'TS-scan narrow trigger: TSNumberKeyword fires twice (annotation + as)',
		calls.filter(c => c.selector === 'TSNumberKeyword').length === 2,
		`got count: ${calls.filter(c => c.selector === 'TSNumberKeyword').length}`,
	);
	// JS-side things are NOT in trigger set. They must NOT fire.
	check(
		'TS-scan narrow trigger: no FunctionDeclaration/CallExpression noise',
		!calls.some(c => c.selector === 'FunctionDeclaration' || c.selector === 'CallExpression'),
	);
}

// 8. JSX dispatch — TSX file parsed via ScriptKind.TSX. Listeners on
//    JSX node types fire on the right shapes; .parent walks via
//    bottom-up materialise reach JSXElement / JSXFragment correctly.
{
	const code = `
		function App({ count }: { count: number }) {
			return <div id="root" {...rest}>
				<span>hello</span>
				{count && <em>x</em>}
				<></>
			</div>;
		}
	`;
	const { calls, threw } = runMock(code, {
		'JSXElement': true,
		'JSXFragment': true,
		'JSXOpeningElement': true,
		'JSXClosingElement': true,
		'JSXAttribute': true,
		'JSXSpreadAttribute': true,
		'JSXExpressionContainer': true,
		'JSXIdentifier': true,
		'JSXText': true,
	}, ts.ScriptKind.TSX);

	check('JSX: dispatch does not throw', threw === undefined, threw ? String((threw as Error).message ?? threw) : '');
	check(
		'JSX: JSXElement listener fires on each element',
		calls.filter(c => c.selector === 'JSXElement').length === 3, // div, span, em
		`got: ${calls.filter(c => c.selector === 'JSXElement').length}`,
	);
	check(
		'JSX: JSXFragment listener fires once',
		calls.filter(c => c.selector === 'JSXFragment').length === 1,
	);
	check(
		'JSX: JSXOpeningElement listener fires once per element',
		calls.filter(c => c.selector === 'JSXOpeningElement').length === 3,
	);
	check(
		'JSX: JSXClosingElement listener fires for non-self-closing',
		// div, span, em — em is the inner of `count && <em>x</em>`, all closed.
		calls.filter(c => c.selector === 'JSXClosingElement').length === 3,
	);
	check(
		'JSX: JSXAttribute listener fires on `id="root"`',
		calls.some(c => c.selector === 'JSXAttribute'),
	);
	check(
		'JSX: JSXSpreadAttribute listener fires on `{...rest}`',
		calls.filter(c => c.selector === 'JSXSpreadAttribute').length === 1,
	);
	check(
		'JSX: JSXExpressionContainer listener fires on `{count && ...}`',
		calls.some(c => c.selector === 'JSXExpressionContainer'),
	);
	const jsxIds = calls.filter(c => c.selector === 'JSXIdentifier');
	check('JSX: JSXIdentifier listener fires on tag/attribute names', jsxIds.length > 0);
	check(
		'JSX: JSXIdentifier "div" reaches JSXOpeningElement→JSXElement via .parent',
		jsxIds.some(c => c.name === 'div' && c.parents.includes('JSXOpeningElement') && c.parents.includes('JSXElement')),
		`first id parents: [${jsxIds[0]?.parents.join(' → ')}]`,
	);
}

// 8b. JSXEmptyExpression listener fires through unwrapChain — `{}` and
//     `{/* comment */}` produce a JSXExpressionContainer whose synthetic
//     `expression` is JSXEmptyExpression. Walker visits the JsxExpression
//     once; unwrapChain expands the chain so both listeners enter.
{
	const code = `
		let _ = <div>{}</div>;
		let __ = <div>{/* hi */}</div>;
		let ___ = <div>{x}</div>;
	`;
	const { calls } = runMock(code, {
		'JSXEmptyExpression': true,
		'JSXExpressionContainer': true,
	}, ts.ScriptKind.TSX);
	check(
		'JSX-empty: JSXExpressionContainer fires for all 3 ({}, {/*…*/}, {x})',
		calls.filter(c => c.selector === 'JSXExpressionContainer').length === 3,
		`got ${calls.filter(c => c.selector === 'JSXExpressionContainer').length}`,
	);
	check(
		'JSX-empty: JSXEmptyExpression fires for the 2 empty containers',
		calls.filter(c => c.selector === 'JSXEmptyExpression').length === 2,
		`got ${calls.filter(c => c.selector === 'JSXEmptyExpression').length}`,
	);
}

// 8c. JSX in CPA mode — when a rule registers `onCodePath*` listeners,
//     dispatch goes through the CPA event-queue path (predicateAllKinds).
//     Verify JSX listeners still fire alongside CPA events on a TSX file.
{
	const code = `
		function App({ count }: { count: number }) {
			return <div id="x">{count && <span />}</div>;
		}
	`;
	const { program, file } = buildProgram(code, ts.ScriptKind.TSX);
	const events: string[] = [];
	const rule: ESLint.Rule.RuleModule = {
		meta: { type: 'problem', schema: [], messages: { x: 'x' } } as any,
		create() {
			return {
				onCodePathStart() { events.push('cpa-start'); },
				onCodePathEnd() { events.push('cpa-end'); },
				JSXElement() { events.push('JSXElement'); },
				JSXOpeningElement(n: any) { events.push(`open:${n.name?.name ?? '?'}`); },
				JSXAttribute(n: any) { events.push(`attr:${n.name?.name ?? '?'}`); },
			};
		},
	};
	const r = runRule(rule, program, file);
	check('JSX+CPA: dispatch did not throw', r.threw === undefined, r.threw ? String((r.threw as Error).message) : '');
	check('JSX+CPA: onCodePathStart fires', events.includes('cpa-start'));
	check('JSX+CPA: onCodePathEnd fires', events.includes('cpa-end'));
	check(
		'JSX+CPA: JSXElement fires for div + span',
		events.filter(e => e === 'JSXElement').length === 2,
		`got ${events.filter(e => e === 'JSXElement').length}`,
	);
	check(
		'JSX+CPA: JSXOpeningElement fires for both div and self-closing span',
		events.includes('open:div') && events.includes('open:span'),
		`events: ${events.filter(e => e.startsWith('open:')).join(',')}`,
	);
	check('JSX+CPA: JSXAttribute fires on `id="x"`', events.includes('attr:id'));
}

// 9. JSX rule with real esquery selector + report mechanism — mirrors
//    a typical plugin rule (selector + attribute name filter + node
//    descriptor for `context.report`). Verifies the full path: selector
//    decomposition → JSX dispatch → report-with-node → location resolution.
{
	const code = `
		let _ = <img src="x" />;
		let __ = <img src="y" alt="ok" />;
	`;
	const { program, file } = buildProgram(code, ts.ScriptKind.TSX);
	const reports: { line: number; column: number; message: string }[] = [];
	const rule: ESLint.Rule.RuleModule = {
		meta: { type: 'problem', schema: [], messages: { missing: 'img missing alt' } } as any,
		create(ctx) {
			return {
				'JSXOpeningElement[name.name="img"]'(node: any) {
					const attrs = node.attributes ?? [];
					const hasAlt = attrs.some((a: any) =>
						a.type === 'JSXAttribute' && a.name?.type === 'JSXIdentifier' && a.name.name === 'alt'
					);
					if (!hasAlt) {
						ctx.report({ messageId: 'missing', node });
					}
				},
			};
		},
	};
	const tsslintRule = compat.convertRule(rule, [], { id: 'jsx-img-alt' });
	const reportFn: any = (msg: string, start: number) => {
		const lc = file.getLineAndCharacterOfPosition(start);
		reports.push({ line: lc.line + 1, column: lc.character + 1, message: msg });
		const r: any = {
			at() {return r}, asWarning(){return r}, asError(){return r}, asSuggestion(){return r},
			withFix(){return r}, withRefactor(){return r}, withDeprecated(){return r},
			withUnnecessary(){return r}, withoutCache(){return r},
		};
		return r;
	};
	let threw: unknown;
	try {
		tsslintRule({ file, report: reportFn, program } as any);
	}
	catch (e) {
		threw = e;
	}

	check('JSX rule: dispatch did not throw', threw === undefined, threw ? String((threw as Error).message ?? threw) : '');
	check('JSX rule: exactly one report (the img without alt)', reports.length === 1, `got ${reports.length}`);
	check('JSX rule: report message is the missing-alt message', reports[0]?.message === 'img missing alt');
	check('JSX rule: report points at the first <img />', reports[0]?.line === 2);
}

console.log();
if (failures.length) {
	console.log('FAILURES:');
	for (const f of failures) console.log('  ' + f);
	process.exit(1);
}
console.log('All compat-pipeline tests passed');
