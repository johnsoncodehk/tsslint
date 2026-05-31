// Consistency meta-test: predicate ↔ materializer.
//
// ts-ast-scan's PREDICATES decide WHICH ts.Nodes get visited+materialized for a
// given rule-listener type — but that's only a PRE-FILTER. The real dispatch
// gate (`dispatchTarget`) keys off the MATERIALIZED `target.type`, so a
// predicate is allowed to over-match: it may trigger a visit for type T, and if
// `materialize` then yields a different type, the T-listener simply doesn't
// fire. That over-match is correct ONLY when nothing actually produces T there
// — i.e. eager (typescript-estree) also doesn't produce T, so no rule would
// fire under eager either. Example: `type X = null` — the predicate fires
// `TSLiteralType` on the LiteralType node, but BOTH lazy and eager flatten it
// to a bare `TSNullKeyword`, so a TSLiteralType listener correctly never fires.
//
// The DRIFT BUG is the asymmetric case: the predicate fires T, EAGER produces T
// (so a rule on T fires under upstream), but lazy's materializer does NOT — the
// listener silently dies under TSSLint. `@dec export class` was exactly this:
// predicate matched the export (`.some(ExportKeyword)`), eager wraps it in
// ExportNamedDeclaration, but the materializer indexed `modifiers[0]` (the
// decorator) and produced a bare ClassDeclaration → an ExportNamedDeclaration
// rule never fired on decorated exports.
//
// Invariant (per source file), using eager as the arbiter:
//   FLAG T  ⟺  predicated(T) ∧ eagerProduces(T) ∧ ¬lazyProduces(T)
// "predicate would route a visit for T, upstream produces T, but we don't."
// Safe over-matches (predicated, neither produces) are accepted automatically.
// Per-node byte-parity is already covered by lazy-estree.test.js; this test
// covers the distinct predicate↔produce relationship at file granularity.
//
// Run: tsc --build && node packages/compat-eslint/test/predicate-materializer-consistency.test.js

import * as fs from 'fs';
import * as path from 'path';
import * as ts from 'typescript';

const lazy = require('../lib/lazy-estree.js') as typeof import('../lib/lazy-estree.js');
const scan = require('../lib/ts-ast-scan.js') as typeof import('../lib/ts-ast-scan.js');
const { visitorKeys } = require('../lib/visitor-keys.js') as typeof import('../lib/visitor-keys.js');
const { astConverter } = require('@typescript-eslint/typescript-estree/use-at-your-own-risk');

// Curated snippets covering divergence-prone constructs (where the two
// descriptions are most likely to drift). The walk hits every ts.Node, so one
// snippet exercises many kinds.
const SNIPPETS: Array<{ name: string; code: string; tsx?: boolean }> = [
	{ name: 'decorated-export', code: '@dec export class C {}' },
	{ name: 'decorated-export-default', code: '@dec export default class C {}' },
	{ name: 'export-after-decorator', code: 'export @dec class C {}' },
	{
		name: 'plain-exports',
		code: 'export class C {}\nexport default function f() {}\nexport const x = 1;\nexport { x };\nexport * from "m";\nexport = x;',
	},
	{ name: 'optional-chains', code: 'a?.b.c; a?.b(); (a?.b).c; a?.b!; a?.b!.c; a?.b?.c; fn?.(); a?.[k];' },
	{
		name: 'class-members',
		code:
			'abstract class C extends B implements I { @d x = 1; static s = 2; private p() {} get g() { return 1 } set v(x) {} constructor(public r: number) {} accessor a = 1; abstract m(): void; static { x; } #priv = 1; }',
	},
	{ name: 'object-methods', code: 'const o = { m() {}, get g() { return 1 }, set s(x) {}, p: 1, [c]: 2, ...rest };' },
	{
		name: 'patterns',
		code:
			'[a, b] = x; ({ a, b } = x); [a = 1] = x; ({ a = 1 } = x); [...r] = x; ({ ...r } = x); const [c, ...d] = y; const { e, ...f } = z; for ([g] of h) {}',
	},
	{ name: 'new-expr', code: 'new Foo; new Foo(); new Foo(1); new Foo<T>(); new Foo<T>;' },
	{ name: 'sequence', code: 'x = (a, b, c); for (a, b; ; c, d) {}' },
	{ name: 'catch', code: 'try {} catch (e) {} try {} catch ({ a, b }) {}' },
	{
		name: 'types',
		code:
			'type A = string | number; type B<T> = T extends U ? X : Y; type M = { [K in keyof T]: T[K] }; type T2 = `a${X}b`; let q: typeof import("m"); type Q = import("m").Z; type Tup = [a: number, ...b: string[]];',
	},
	{
		name: 'imports',
		code: 'import d from "m"; import * as ns from "m"; import { a, b as c } from "m"; import type { T } from "m"; import x = require("m");',
	},
	{
		name: 'decls',
		code:
			'enum E { A, B } const enum CE { X } namespace N { export const y = 1; } declare global { interface W {} } interface I extends J { m(): void; p: number; }',
	},
	{ name: 'templates', code: 'const a = `x${y}z`; const b = tag`p${q}r`; const c = `nosub`;' },
	{ name: 'operators', code: 'void x; typeof x; delete x.y; -x; !x; ~x; ++x; x--; x ||= 1; x &&= 2; x ??= 3; a ** b;' },
	{ name: 'jsx', tsx: true, code: 'const e = <Foo.Bar a="1" {...p}>{x}{}<svg:rect /></Foo.Bar>; const f = <></>; const g = <Foo />;' },
];

const seenKinds = new Set<ts.SyntaxKind>();
const failures: Array<{ where: string; type: string }> = [];

const EAGER_SETTINGS = {
	allowInvalidAST: false,
	comment: false,
	errorOnUnknownASTType: false,
	loc: true,
	range: true,
	suppressDeprecatedPropertyWarnings: true,
	tokens: false,
};

// Every ESTree `type` reachable from `node` via visitorKeys. Used for the lazy
// tree (prototype getters → must drive off visitorKeys, not Object.keys) and
// the eager tree alike.
function collectTypes(node: any, into: Set<string>, seen: Set<any>): void {
	if (!node || typeof node !== 'object' || seen.has(node)) return;
	seen.add(node);
	if (typeof node.type === 'string') into.add(node.type);
	const keys = (visitorKeys as Record<string, readonly string[]>)[node.type] ?? [];
	for (const k of keys) {
		const child = node[k];
		if (Array.isArray(child)) for (const c of child) collectTypes(c, into, seen);
		else if (child && typeof child === 'object') collectTypes(child, into, seen);
	}
}

function sweep(code: string, tsx: boolean, where: string): void {
	const fileName = tsx ? 't.tsx' : 't.ts';
	const kind = tsx ? ts.ScriptKind.TSX : ts.ScriptKind.TS;

	// lazyProduced: every ESTree type in the canonical top-down lazy tree.
	const lazyProduced = new Set<string>();
	const sf = ts.createSourceFile(fileName, code, ts.ScriptTarget.Latest, true, kind);
	collectTypes((lazy.convertLazy(sf) as any).estree, lazyProduced, new Set());

	// eagerProduced: the same for typescript-estree's eager converter (oracle).
	const eagerProduced = new Set<string>();
	const sfE = ts.createSourceFile(fileName, code, ts.ScriptTarget.Latest, true, kind);
	collectTypes(astConverter(sfE, EAGER_SETTINGS as any, false).estree, eagerProduced, new Set());

	// predicated: every ESTree type any predicate fires for, over all ts.Nodes.
	const predicated = new Set<string>();
	const walk = (n: ts.Node) => {
		seenKinds.add(n.kind);
		for (const t of scan.predicatesMatching(n)) predicated.add(t);
		ts.forEachChild(n, walk);
	};
	ts.forEachChild(sf, walk);

	for (const t of predicated) {
		// Flag only the asymmetric drift: predicate routes a visit for T,
		// upstream produces T, but lazy doesn't. (predicated ∧ ¬lazy ∧ eager).
		// Predicated-but-neither-produces is a safe over-match (the post-
		// materialize dispatch gate never fires a T listener, matching eager).
		if (lazyProduced.has(t)) continue;
		if (!eagerProduced.has(t)) continue;
		failures.push({ where, type: t });
	}
}

console.log('predicate ↔ materializer consistency\n');

for (const s of SNIPPETS) sweep(s.code, !!s.tsx, `snippet:${s.name}`);

const corpusDir = path.resolve(__dirname, 'bench/corpus');
if (fs.existsSync(corpusDir)) {
	for (const f of fs.readdirSync(corpusDir)) {
		if (!f.endsWith('.ts') && !f.endsWith('.tsx')) continue;
		sweep(fs.readFileSync(path.join(corpusDir, f), 'utf8'), f.endsWith('.tsx'), `corpus:${f}`);
	}
}

console.log(`  swept ${SNIPPETS.length} snippets + corpus across ${seenKinds.size} distinct TS SyntaxKinds`);

if (failures.length > 0) {
	console.log(`\n  ${failures.length} INCONSISTENCIES (predicate routes a visit for T, eager produces T, lazy doesn't):`);
	const seen = new Set<string>();
	for (const f of failures) {
		const key = `${f.type}|${f.where}`;
		if (seen.has(key)) continue;
		seen.add(key);
		console.log(`    - ${f.type}  (${f.where})`);
	}
	console.log('\n  A rule on that type fires under typescript-estree but is silently');
	console.log('  dropped under TSSLint — the predicate (ts-ast-scan.ts) and the');
	console.log('  shape/router (lazy-estree.ts) disagree. Fix whichever is wrong so');
	console.log('  lazy produces what eager produces for the predicated kind.');
	process.exit(1);
}

console.log('\n  all consistent — no predicated type is produced by eager yet missing from lazy');
process.exit(0);
