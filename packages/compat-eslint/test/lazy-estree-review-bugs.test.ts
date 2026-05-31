// Regression suite for the lazy-estree review findings.
//
// Two kinds of check:
//   fixed(...)  — a divergence we FIXED. Asserts the correct
//                 (typescript-estree-parity) behavior. Must stay green;
//                 a failure is a regression of the fix.
//   gap(...)    — an ACCEPTED gap we chose NOT to fix (niche / type-aware /
//                 known). Asserts the CURRENT (divergent) behavior plus the
//                 documented reason. Green today; if the behavior ever changes
//                 (e.g. someone fixes it, or it drifts further) the assertion
//                 of the status-quo flips and the run goes red as an
//                 "unexpected pass" signal — the gap list must then be updated.
//                 Same discipline as upstream-runner.ts's KNOWN_DIVERGENCES.
//
// Channel mirrors lazy-estree.test.ts: plain script, requires the COMPILED
// `.js`, oracle = typescript-estree's eager `astConverter`.
// Run: tsc --build && node packages/compat-eslint/test/lazy-estree-review-bugs.test.js

import * as ts from 'typescript';

const lazy = require('../lib/lazy-estree.js') as typeof import('../lib/lazy-estree.js');
const scan = require('../lib/ts-ast-scan.js') as typeof import('../lib/ts-ast-scan.js');
const { visitorKeys } = require('../lib/visitor-keys.js') as typeof import('../lib/visitor-keys.js');
const { astConverter } = require('@typescript-eslint/typescript-estree/use-at-your-own-risk');

// Lazy child slots are PROTOTYPE getters, so Object.keys can't see them — a
// generic tree walk must drive off visitorKeys (own-keys fallback for the rare
// node with no visitor-keys entry, e.g. GenericTSNode / plain meta objects).
function childKeys(n: any): readonly string[] {
	return (visitorKeys as Record<string, readonly string[]>)[n.type] ?? Object.keys(n);
}
function sfOf(code: string, tsx = false): ts.SourceFile {
	return ts.createSourceFile(tsx ? 't.tsx' : 't.ts', code, ts.ScriptTarget.Latest, true, tsx ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
}
const lazyAst = (code: string, tsx = false) => (lazy.convertLazy(sfOf(code, tsx)) as any).estree;
function eagerAst(code: string, tsx = false, invalid = false): any {
	const settings = {
		allowInvalidAST: invalid, comment: false, errorOnUnknownASTType: false,
		loc: true, range: true, jsx: tsx, suppressDeprecatedPropertyWarnings: true, tokens: false,
	};
	return astConverter(sfOf(code, tsx), settings as any, false).estree;
}
function find(root: any, pred: (n: any) => boolean): any {
	const seen = new Set<any>(); const st = [root];
	while (st.length) {
		const n = st.pop(); if (!n || typeof n !== 'object' || seen.has(n)) continue; seen.add(n);
		if (pred(n)) return n;
		for (const k of childKeys(n)) { if (k === 'parent') continue; const c = n[k]; if (Array.isArray(c)) for (const e of c) st.push(e); else if (c && typeof c === 'object') st.push(c); }
	}
}
function count(root: any, type: string): number {
	let c = 0; const seen = new Set<any>(); const st = [root];
	while (st.length) {
		const n = st.pop(); if (!n || typeof n !== 'object' || seen.has(n)) continue; seen.add(n);
		if (n.type === type) c++;
		for (const k of childKeys(n)) { if (k === 'parent') continue; const x = n[k]; if (Array.isArray(x)) for (const e of x) st.push(e); else if (x && typeof x === 'object') st.push(x); }
	}
	return c;
}
function findTs(sf: ts.SourceFile, pred: (n: ts.Node) => boolean): ts.Node {
	let f: ts.Node | undefined; const w = (n: ts.Node) => { if (f) return; if (pred(n)) { f = n; return; } ts.forEachChild(n, w); }; w(sf); return f!;
}
const firstExpr = (e: any) => e.body.find((s: any) => s && s.type === 'ExpressionStatement').expression;

const failures: string[] = [];
// A FIXED check must hold. A GAP check asserts the status quo; `cond` true means
// "still diverges as documented" (green) — if it flips, the gap closed/changed
// and the list needs updating (red, treated as a real failure).
function fixed(name: string, cond: boolean, detail = '') {
	console.log(`  ${cond ? 'ok  ' : 'FAIL'} - [fixed] ${name}${detail ? `  (${detail})` : ''}`);
	if (!cond) failures.push(`[fixed] ${name}${detail ? `  (${detail})` : ''}`);
}
function gap(name: string, stillDiverges: boolean, reason: string, detail = '') {
	console.log(`  ${stillDiverges ? 'ok  ' : 'XPASS'} - [gap] ${name} — ${reason}${detail ? `  (${detail})` : ''}`);
	if (!stillDiverges) failures.push(`[gap CLOSED — update list] ${name}${detail ? `  (${detail})` : ''}`);
}

console.log('lazy-estree review — regression + accepted-gap suite\n');

// ── FIXED ────────────────────────────────────────────────────────────────────

// A — regex d/v (and any) flags preserved (lastIndexOf split, not [gimsuy]).
for (const [src, p, f] of [['/a/d', 'a', 'd'], ['/a/v', 'a', 'v'], ['/a/dgi', 'a', 'dgi'], ['/a/gi', 'a', 'gi']] as const) {
	const r = firstExpr(lazyAst(src + ';')).regex;
	fixed(`A regex ${src}`, r.pattern === p && r.flags === f, `got {${r.pattern},${r.flags}}`);
}

// B — `new Foo` (no parens) → arguments [], not null.
fixed('B new Foo; arguments []', JSON.stringify(firstExpr(lazyAst('new Foo;')).arguments) === '[]', `got ${JSON.stringify(firstExpr(lazyAst('new Foo;')).arguments)}`);
fixed('B new Foo(); arguments [] (control)', JSON.stringify(firstExpr(lazyAst('new Foo();')).arguments) === '[]');

// C — decorated export gets the ExportNamed/Default wrapper (getModifiers, not modifiers[0]).
for (const code of ['@dec export class C {}', '@dec export default class C {}', 'export class C {}']) {
	fixed(`C ${code}`, lazyAst(code).body[0].type === eagerAst(code).body[0].type, `got ${lazyAst(code).body[0].type} want ${eagerAst(code).body[0].type}`);
}

// D — flattened SequenceExpression operands re-parent to the outer sequence.
{ const seq = firstExpr(lazyAst('x = (a, b, c);')).right;
	fixed('D seq operand.parent === outer', seq.expressions.every((e: any) => e.parent === seq), `parent expr-counts [${seq.expressions.map((e: any) => e.parent.expressions.length)}]`); }

// Guard — bottom-up materialize of an inner optional-chain link is plain, not a phantom ChainExpression.
{ const sf = sfOf('a?.b.c;'); const ctx = (lazy.convertLazy(sf) as any).context;
	const inner = findTs(sf, n => ts.isPropertyAccessExpression(n) && !!n.questionDotToken);
	fixed('inner a?.b materializes as MemberExpression', (lazy.materialize(inner, ctx) as any).type === 'MemberExpression', `got ${(lazy.materialize(inner, ctx) as any).type}`); }
// control: the whole `a?.b.c` tree has exactly one ChainExpression (outermost only).
fixed('a?.b.c has exactly one ChainExpression', count(lazyAst('a?.b.c;'), 'ChainExpression') === 1);

// Guard — materialize(catch variableDeclaration) is the param Identifier or throws; never a phantom VariableDeclarator.
{ const sf = sfOf('try {} catch (e) {}'); const ctx = (lazy.convertLazy(sf) as any).context;
	const vd = findTs(sf, n => ts.isVariableDeclaration(n) && ts.isCatchClause(n.parent!));
	let t: string;
	try { t = (lazy.materialize(vd, ctx) as any).type; }
	catch (e) { t = `<threw ${(e as Error).name}>`; }
	fixed('materialize(catch vd) is Identifier or throws', t === 'Identifier' || t.startsWith('<threw'), `got ${t}`); }

// Guard — _extendRange assigns a fresh array, never mutates one a rule may hold.
{ const sf = sfOf('const x: Foo = 1;'); const ctx = (lazy.convertLazy(sf) as any).context;
	const idTs = findTs(sf, n => ts.isIdentifier(n) && n.text === 'x');
	const grabbed = (lazy.materialize(idTs, ctx) as any).range; const before = grabbed[1];
	const vdTs = findTs(sf, n => ts.isVariableDeclaration(n) && !ts.isCatchClause(n.parent!)); void (lazy.materialize(vdTs, ctx) as any).id;
	fixed('held range array not mutated on annotate', grabbed[1] === before, `range[1] ${before} -> ${grabbed[1]}`); }

// ── ACCEPTED GAPS (assert the status quo; XPASS = gap changed, update this list) ──

// `typeof this.foo` — Identifier shape has no isThisInTypeQuery branch, so
// `this` in a type query stays Identifier instead of upstream's ThisExpression.
gap(
	'typeof this in type query → no ThisExpression',
	count(lazyAst('type T = typeof this.foo;'), 'ThisExpression') === 0
		&& count(eagerAst('type T = typeof this.foo;'), 'ThisExpression') === 1,
	'niche type-query shape; no rule observed to depend on it',
);

// import attributes in TYPE position: TSImportType.options not built from the
// `with` clause (stays null); only affects type-level import() attribute rules.
gap(
	'TSImportType.options not built (stays null)',
	find(lazyAst('type T = import("x", { with: { type: "json" } }).Y;'), (n: any) => n.type === 'TSImportType').options === null,
	'type-position import attributes; rare, type-aware-only',
);

// import attributes in EXPRESSION position: deprecated `attributes` alias is the
// frozen EMPTY_ARRAY instead of aliasing the (correctly-built) `options`.
{ const ie = find(lazyAst('const p = import("x", { with: { type: "json" } });'), (n: any) => n.type === 'ImportExpression');
	gap(
		'ImportExpression.attributes not aliased to options',
		Array.isArray(ie.attributes) && ie.attributes.length === 0,
		'deprecated alias; `options` is correct, only the legacy `.attributes` getter diverges',
		`options=${ie.options?.type}`,
	); }

// MetaProperty.meta synthetic Identifier omits the `typeAnnotation` own-key
// (real Identifier shape has it; this hand-built object doesn't).
gap(
	'MetaProperty.meta missing typeAnnotation key',
	!('typeAnnotation' in find(lazyAst('function f(){ new.target; }'), (n: any) => n.type === 'MetaProperty').meta),
	'synthetic meta object; JSON-key parity only, no field-read rule affected',
);

// `[a = 1] = x` (assignment-form destructure default): element is
// AssignmentExpression, not AssignmentPattern. Self-consistent gap — the
// predicate agrees with the shape (ts-ast-scan AssignmentPattern comment).
gap(
	'[a=1]=x element is AssignmentExpression not AssignmentPattern',
	firstExpr(lazyAst('[a = 1] = x;')).left.elements[0].type === 'AssignmentExpression',
	'documented self-consistent gap (predicate + shape agree); binding form const [a=1] is correct',
);

// Ordering: body-wrapper chain (ClassBody / method FunctionExpression) enters
// before its preceding siblings. superClass `Sup` and a computed method key are
// dispatched INSIDE the body wrapper instead of before it → CPA attributes a
// computed-key call to the method's code path. Intrinsic to single-pass
// "enter the whole chain up front"; parent pointers stay correct.
{ const sf = sfOf('class C extends Sup { m(){} }'); const ctx = (lazy.convertLazy(sf) as any).context; const order: string[] = [];
	scan.tsScanTraverse(sf, scan.predicateAllKinds(), ctx, { enterNode(t: any) { order.push(t.type === 'Identifier' ? `Id(${t.name})` : t.type); }, leaveNode() {} });
	gap(
		'superClass dispatched after ClassBody enter',
		order.indexOf('Id(Sup)') > order.indexOf('ClassBody'),
		'single-pass body-wrapper ordering; parent pointers correct, only dispatch order differs',
		`Sup@${order.indexOf('Id(Sup)')} ClassBody@${order.indexOf('ClassBody')}`,
	); }
{ const sf = sfOf('class C { [k()]() {} }'); const ctx = (lazy.convertLazy(sf) as any).context; const order: string[] = [];
	scan.tsScanTraverse(sf, scan.predicateAllKinds(), ctx, { enterNode(t: any) { order.push(t.type); }, leaveNode() {} });
	gap(
		'computed method key dispatched inside method FunctionExpression',
		order.indexOf('CallExpression') > order.indexOf('FunctionExpression'),
		'same body-wrapper ordering; CPA attribution of computed-key call to the method scope',
		`Call@${order.indexOf('CallExpression')} Fn@${order.indexOf('FunctionExpression')}`,
	); }

console.log(`\n${failures.length === 0 ? 'all green (fixes hold, gaps unchanged)' : `${failures.length} FAILURE(S):`}`);
for (const f of failures) console.log(`  - ${f}`);
process.exit(failures.length === 0 ? 0 : 1);
