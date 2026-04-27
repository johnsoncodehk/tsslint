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

import * as ts from 'typescript';
import type * as ESLint from 'eslint';

const compat = require('../index.js') as typeof import('../index.js');

const failures: string[] = [];
function check(name: string, cond: boolean, detail?: string) {
	if (cond) {
		process.stdout.write('.');
	} else {
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
				out[sel] = (n) => {
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
function buildProgram(code: string): { program: ts.Program; file: ts.SourceFile } {
	const fileName = '/test.ts';
	const sf = ts.createSourceFile(fileName, code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
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
		options: { target: ts.ScriptTarget.Latest, lib: [realLibName], noEmit: true },
		host,
	});
	return { program, file: sf };
}

// Drive the rule through the TSSLint pipeline. Returns the reports the
// rule produced (mock rules don't report; we capture listener calls
// instead, which exercises the same path before the report-replay step).
function runRule(rule: ESLint.Rule.RuleModule, program: ts.Program, file: ts.SourceFile): { reports: any[]; threw?: unknown } {
	const reports: any[] = [];
	let threw: unknown;
	const tsslintRule = compat.convertRule(rule, [], { id: 'mock' } as any);
	const reportFn: any = (msg: string, start: number, end: number) => {
		const r: any = { msg, start, end };
		reports.push(r);
		// Mimic the .at(...) and chained .asXxx() / .withFix() the real
		// reporter exposes — tests don't exercise these but the pipeline
		// calls them.
		const chain = {
			at() { return chain; },
			asWarning() { return chain; },
			asError() { return chain; },
			asSuggestion() { return chain; },
			withFix() { return chain; },
			withRefactor() { return chain; },
		};
		return chain;
	};
	try {
		tsslintRule({ file, report: reportFn, program } as any);
	} catch (e) {
		threw = e;
	}
	return { reports, threw };
}

function runMock(code: string, listeners: Record<string, true>): { calls: Recorded[]; threw?: unknown } {
	const { program, file } = buildProgram(code);
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
	check('integration: TSNumberKeyword.parent.parent reaches FunctionDeclaration via .parent walk',
		parents.includes('FunctionDeclaration'),
		`parent chain: [${parents.join(' → ')}]`);
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
	check('integration: 2 ImportDeclaration enter events',
		calls.filter(c => c.selector === 'ImportDeclaration').length === 2);
	check('integration: 1 Program:exit event',
		calls.filter(c => c.selector === 'Program:exit').length === 1);
	const lastSel = calls[calls.length - 1]?.selector;
	check('integration: Program:exit fires LAST',
		lastSel === 'Program:exit',
		`last call: ${lastSel}`);
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
			} as any;
		},
	};
	runRule(rule, program, file);

	check('CPA fallback: onCodePathStart fires (slow path)',
		cpaCalls.some(c => c.event === 'onCodePathStart'));
	check('CPA fallback: onCodePathEnd fires',
		cpaCalls.some(c => c.event === 'onCodePathEnd'));
	check('CPA fallback: FunctionDeclaration also fires alongside CPA events',
		cpaCalls.some(c => c.event === 'FunctionDeclaration'));
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
	const tsslintRule = compat.convertRule(noUnreachable, [], { id: 'no-unreachable' } as any);
	const reportFn: any = (_msg: string, start: number, end: number) => {
		reports.push({ start, end });
		const r: any = { at() { return r; }, asWarning() { return r; }, asError() { return r; }, asSuggestion() { return r; }, withFix() { return r; }, withRefactor() { return r; }, withDeprecated() { return r; }, withUnnecessary() { return r; }, withoutCache() { return r; } };
		return r;
	};
	tsslintRule({ file, report: reportFn, program } as any);
	check('no-unreachable: method shorthand return does not poison outer scope reachability',
		reports.length === 0,
		`got ${reports.length} reports, first at [${reports[0]?.start}, ${reports[0]?.end}]`);
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
	check('mixed: simple FunctionDeclaration listener fires',
		calls.filter(c => c.selector === 'FunctionDeclaration').length === 2);
	check('mixed: complex `FunctionDeclaration > BlockStatement > VariableDeclaration` fires',
		calls.filter(c => c.selector.includes('VariableDeclaration')).length === 1);
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
				VariableDeclaration() { throw new Error('intentional'); },
			} as any;
		},
	};
	const goodRule: ESLint.Rule.RuleModule = {
		meta: { type: 'problem', schema: [], messages: { x: 'x' } } as any,
		create() {
			return {
				VariableDeclaration(n: any) { goodCalls.push(n.type); },
			} as any;
		},
	};

	const badTsslintRule = compat.convertRule(badRule, [], { id: 'bad' } as any);
	const goodTsslintRule = compat.convertRule(goodRule, [], { id: 'good' } as any);

	const reportFn: any = () => ({
		at: () => ({ asWarning() {}, asError() {}, asSuggestion() {}, withFix() {}, withRefactor() {} }),
	});
	let badThrew: unknown;
	try { badTsslintRule({ file, report: reportFn, program } as any); }
	catch (e) { badThrew = e; }
	let goodThrew: unknown;
	try { goodTsslintRule({ file, report: reportFn, program } as any); }
	catch (e) { goodThrew = e; }

	check('error isolation: bad rule re-throws on its own dispatch',
		badThrew instanceof Error && (badThrew as Error).message === 'intentional');
	check('error isolation: good rule still fires both VariableDeclarations',
		goodCalls.length === 2 && goodThrew === undefined,
		`goodCalls=${goodCalls.length}, threw=${String(goodThrew)}`);
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
			} as any;
		},
	};
	runRule(rule, program, file);

	check('post-dispatch: ImportDeclaration target shape correct',
		captured[0]?.type === 'ImportDeclaration');
	check('post-dispatch: .specifiers[0] resolves to ImportSpecifier',
		captured[0]?.specifierType === 'ImportSpecifier');
	check('post-dispatch: specifier.parent points back to ImportDeclaration',
		captured[0]?.specifierParentType === 'ImportDeclaration',
		`got: ${captured[0]?.specifierParentType}`);
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

	check('TS-scan narrow trigger: TSAsExpression fires once',
		calls.filter(c => c.selector === 'TSAsExpression').length === 1);
	check('TS-scan narrow trigger: TSNumberKeyword fires twice (annotation + as)',
		calls.filter(c => c.selector === 'TSNumberKeyword').length === 2,
		`got count: ${calls.filter(c => c.selector === 'TSNumberKeyword').length}`);
	// JS-side things are NOT in trigger set. They must NOT fire.
	check('TS-scan narrow trigger: no FunctionDeclaration/CallExpression noise',
		!calls.some(c => c.selector === 'FunctionDeclaration' || c.selector === 'CallExpression'));
}

console.log();
if (failures.length) {
	console.log('FAILURES:');
	for (const f of failures) console.log('  ' + f);
	process.exit(1);
}
console.log('All compat-pipeline tests passed');
