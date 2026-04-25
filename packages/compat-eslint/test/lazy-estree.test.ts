// Parity tests for lib/lazy-estree.ts. Strategy: parse the same TS source
// with our lazy converter and with typescript-estree's eager Converter, then
// walk both ESTree trees in lockstep asserting the same `type`, primitive
// fields, and child shapes. Run with:
//   node packages/compat-eslint/test/lazy-estree.test.js
//
// MVP only handles a few SyntaxKinds; fixtures stay narrow on purpose. As
// classes get added in lazy-estree.ts, broaden the fixtures here.

import * as ts from 'typescript';

const lazy = require('../lib/lazy-estree.js') as typeof import('../lib/lazy-estree.js');
const { astConverter } = require('@typescript-eslint/typescript-estree/use-at-your-own-risk');

const PARSE_SETTINGS = {
	allowInvalidAST: false,
	comment: true,
	errorOnUnknownASTType: false,
	loc: true,
	range: true,
	suppressDeprecatedPropertyWarnings: true,
	tokens: true,
};

function parseTs(code: string): ts.SourceFile {
	return ts.createSourceFile('/test.ts', code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}

function eagerConvert(sf: ts.SourceFile): any {
	return astConverter(sf, PARSE_SETTINGS as any, true).estree;
}

const failures: string[] = [];
function check(name: string, cond: boolean, detail?: string) {
	if (cond) {
		console.log(`  ok  - ${name}`);
	}
	else {
		console.log(`  FAIL - ${name}${detail ? ` (${detail})` : ''}`);
		failures.push(name);
	}
}

// Walk lazy and eager trees in parallel. For each pair: same `type`, same
// `range`, same primitive scalar fields (numbers, strings, bools), and recurse
// into matching child slots. Skip metadata (parent, loc — we cover loc start/end
// separately).
function compare(lazyNode: any, eagerNode: any, path: string): void {
	if (lazyNode == null && eagerNode == null) return;
	if (lazyNode == null || eagerNode == null) {
		failures.push(`${path}: one side is null (lazy=${lazyNode}, eager=${eagerNode})`);
		return;
	}
	if (Array.isArray(lazyNode) !== Array.isArray(eagerNode)) {
		failures.push(`${path}: array shape mismatch`);
		return;
	}
	if (Array.isArray(lazyNode)) {
		if (lazyNode.length !== eagerNode.length) {
			failures.push(`${path}: array length ${lazyNode.length} vs ${eagerNode.length}`);
			return;
		}
		for (let i = 0; i < lazyNode.length; i++) {
			compare(lazyNode[i], eagerNode[i], `${path}[${i}]`);
		}
		return;
	}
	if (typeof lazyNode !== 'object') {
		if (lazyNode !== eagerNode) {
			failures.push(`${path}: primitive ${JSON.stringify(lazyNode)} vs ${JSON.stringify(eagerNode)}`);
		}
		return;
	}
	if (lazyNode.type !== eagerNode.type) {
		failures.push(`${path}: type ${lazyNode.type} vs ${eagerNode.type}`);
		return;
	}
	if (lazyNode.range && eagerNode.range
		&& (lazyNode.range[0] !== eagerNode.range[0] || lazyNode.range[1] !== eagerNode.range[1])) {
		failures.push(`${path}.range: [${lazyNode.range}] vs [${eagerNode.range}]`);
	}
	// Iterate eager's keys — they're the canonical shape.
	for (const key of Object.keys(eagerNode)) {
		if (key === 'parent' || key === 'loc' || key === 'range' || key === 'type') continue;
		// `tokens` and `comments` are produced by typescript-estree's separate
		// scanner pass, not the Converter. Lazy MVP doesn't replicate them —
		// any rule that needs them gets undefined / [].
		if (key === 'tokens' || key === 'comments') continue;
		// Trigger lazy access; will materialise on first read.
		const l = lazyNode[key];
		const e = eagerNode[key];
		if (e === undefined && l === undefined) continue;
		compare(l, e, `${path}.${key}`);
	}
}

function runFixture(name: string, code: string) {
	console.log(`\n[${name}] ${code.replace(/\n/g, ' \\n ').slice(0, 60)}`);
	const sf = parseTs(code);
	const lazyResult = lazy.convertLazy(sf);
	const eagerResult = eagerConvert(parseTs(code));
	compare(lazyResult.estree, eagerResult, 'Program');
}

// --- Fixtures -----------------------------------------------------------

console.log('lazy-estree parity tests');

runFixture('numeric var', 'let x = 1;');
runFixture('string var', 'const s = "hi";');
runFixture('multi-decl', 'let a = 1, b = 2;');
runFixture('TSAsExpression', 'let x = 1 as number;');
runFixture('typeAnnotation simple', 'let x: number = 1;');
runFixture('TSTypeReference simple', 'let x: Foo = 1;');

// --- Lazy invariants ----------------------------------------------------

// Property memoisation: reading a child slot twice returns the SAME instance
// (not a fresh conversion each time). Rules store nodes between enter/exit
// in WeakSets — losing identity would silently break those.
{
	const sf = parseTs('let x = 1 as number;');
	const { estree } = lazy.convertLazy(sf);
	const decl = (estree.body as any)[0];
	const declarator = decl.declarations[0];
	const init1 = declarator.init;
	const init2 = declarator.init;
	check('lazy: child identity stable across reads', init1 === init2);
}

// `parent` chain: a child's parent is the ESTree node whose getter returned
// it (not the TS parent, not a re-wrapped instance).
{
	const sf = parseTs('let x = 1;');
	const { estree } = lazy.convertLazy(sf);
	const decl = (estree.body as any)[0];
	const declarator = decl.declarations[0];
	check('lazy: parent backref points to materialising node', declarator.parent === decl);
	check('lazy: nested parent chain', declarator.id.parent === declarator);
}

// astMaps populated only on access: before reading body, body[0]'s TS node
// shouldn't be mapped yet. After reading, it should be.
{
	const sf = parseTs('let x = 1;');
	const { estree, astMaps } = lazy.convertLazy(sf);
	const tsStatement = sf.statements[0];
	check(
		'lazy: child not in tsNodeToESTreeNodeMap before access',
		!astMaps.tsNodeToESTreeNodeMap.has(tsStatement),
	);
	void (estree.body as any)[0];
	check(
		'lazy: child in tsNodeToESTreeNodeMap after access',
		astMaps.tsNodeToESTreeNodeMap.has(tsStatement),
	);
}

// --- Bottom-up materialisation -----------------------------------------

// Materialise a TS node directly without first walking down from Program.
// The lookup must build the parent chain on the way and cache each step.
{
	const sf = parseTs('let x = 1; let y = 2; let z = 3;');
	const { estree, context } = lazy.convertLazy(sf);
	// Pick the middle statement's identifier from the TS AST.
	const tsStmt2 = sf.statements[1] as ts.VariableStatement;
	const tsDecl2 = tsStmt2.declarationList.declarations[0];
	const tsId2 = tsDecl2.name as ts.Identifier;

	// Top-down hasn't touched body yet — caches are empty for body[*].
	check(
		'bottom-up: parent statement not cached before lookup',
		!context.maps.tsNodeToESTreeNodeMap.has(tsStmt2),
	);

	// Materialise the deepest target.
	const idEstree = lazy.materialize(tsId2, context);
	check('bottom-up: returns ESTree Identifier', (idEstree as any).type === 'Identifier');
	check('bottom-up: name matches', (idEstree as any).name === 'y');

	// Walking up via `parent` should land on Program.
	const declarator = (idEstree as any).parent;
	const decl = declarator?.parent;
	const program = decl?.parent;
	check('bottom-up: parent chain Identifier→Declarator→Decl→Program', program === estree);

	// Sibling reuse: now access program.body and confirm body[1] is the SAME
	// VariableDeclaration instance the bottom-up walk built (not a fresh
	// recreate). This is the cache-on-TS-node-identity invariant.
	const body = (estree.body as any);
	check('bottom-up: body[1] is the bottom-up-materialised statement', body[1] === decl);

	// And: body[0]/body[2] are independently materialised when accessed.
	const otherDecl0 = body[0];
	const otherDecl2 = body[2];
	check('bottom-up: body[0] is fresh (different from body[1])', otherDecl0 !== decl && otherDecl0 != null);
	check('bottom-up: body[2] is fresh (different from body[1])', otherDecl2 !== decl && otherDecl2 != null);
}

// child_a / child_b share a parent. With child_a + parent already built,
// asking for child_b should reuse the existing parent (not create a new one).
{
	const sf = parseTs('let a = 1, b = 2;');
	const { estree, context } = lazy.convertLazy(sf);
	const tsStmt = sf.statements[0] as ts.VariableStatement;
	const tsDeclA = tsStmt.declarationList.declarations[0];
	const tsDeclB = tsStmt.declarationList.declarations[1];

	// Build child_a (and its parent chain) bottom-up.
	const declAEstree = lazy.materialize(tsDeclA, context);
	const parentInstance = (declAEstree as any).parent; // VariableDeclaration

	// Now build child_b. It should find parentInstance via cache and reuse.
	const declBEstree = lazy.materialize(tsDeclB, context);
	check(
		'sibling reuse: child_b.parent === parentInstance (no fresh creation)',
		(declBEstree as any).parent === parentInstance,
	);
	void estree;
}

// Idempotence: materialise(x) twice returns the same instance — second
// call is just a cache hit, no fresh construction.
{
	const sf = parseTs('let x = 1;');
	const { context } = lazy.convertLazy(sf);
	const tsId = (sf.statements[0] as ts.VariableStatement).declarationList.declarations[0].name as ts.Identifier;
	const first = lazy.materialize(tsId, context);
	const second = lazy.materialize(tsId, context);
	check('idempotent: materialize() returns same instance on repeat', first === second);
}

// Top-down before bottom-up: if a child has already been built via parent
// getter, materialise() should return that exact instance.
{
	const sf = parseTs('let x = 1;');
	const { estree, context } = lazy.convertLazy(sf);
	const tsId = (sf.statements[0] as ts.VariableStatement).declarationList.declarations[0].name as ts.Identifier;
	// Force top-down build:
	const topDownId = ((estree.body as any)[0]).declarations[0].id;
	// Now bottom-up:
	const bottomUpId = lazy.materialize(tsId, context);
	check('top-down then bottom-up: same instance', topDownId === bottomUpId);
}

// SourceFile materialise: should return the Program instance built by
// convertLazy(), not create a new one.
{
	const sf = parseTs('let x = 1;');
	const { estree, context } = lazy.convertLazy(sf);
	const programViaMaterialize = lazy.materialize(sf, context);
	check('SourceFile materialise: returns existing Program', programViaMaterialize === estree);
}

// TS-only ancestor: VariableDeclarationList sits between VariableDeclaration
// (TS) and VariableStatement (TS) but has no ESTree counterpart. Walking up
// must skip past it.
{
	const sf = parseTs('let x = 1;');
	const { estree, context } = lazy.convertLazy(sf);
	const tsDecl = (sf.statements[0] as ts.VariableStatement).declarationList.declarations[0];
	// tsDecl.parent.kind === VariableDeclarationList
	check('TS-only ancestor exists', (tsDecl.parent as any).kind === ts.SyntaxKind.VariableDeclarationList);
	const declarator = lazy.materialize(tsDecl, context);
	// Walking the ESTree parent chain should skip the TS-only kind:
	// VariableDeclarator → VariableDeclaration → Program (no list-shaped node).
	const declStmt = (declarator as any).parent;
	check('walks past VariableDeclarationList', declStmt?.type === 'VariableDeclaration');
	check('reaches Program two levels up', declStmt?.parent === estree);
}

// Deep nesting: material a node 4+ levels down. The walk-up must build
// every intermediate level once.
{
	const sf = parseTs('let x = 1, y = 2; let z = 3;');
	const { estree, context } = lazy.convertLazy(sf);
	const tsId = ((sf.statements[1] as ts.VariableStatement).declarationList.declarations[0].name) as ts.Identifier;
	const idEstree = lazy.materialize(tsId, context);
	let walker: any = idEstree;
	let depth = 0;
	while (walker && walker !== estree && depth < 10) {
		walker = walker.parent;
		depth++;
	}
	check(`deep nesting: walked up to Program in ${depth} hops`, walker === estree && depth >= 3);
}

// KNOWN LIMITATION: bottom-up materialise of a type node inside a
// typeAnnotation slot — the synthetic TSTypeAnnotation wrapper isn't on
// the TS parent chain, so the walk-up lands on VariableDeclarator instead
// of going through the wrapper. The inner type's `parent` reference
// will be wrong (points at the wrong ESTree node).
//
// Documented here so the assumption is explicit. Fix: detect when the
// TS node sits in a `type` slot of its TS parent, route bottom-up through
// the wrapper-creating getter on the parent instead.
{
	const sf = parseTs('let x: number = 1;');
	const { estree } = lazy.convertLazy(sf);
	// Top-down path goes through the synthetic wrapper:
	const idTopDown = ((estree.body as any)[0]).declarations[0].id;
	const wrapperTopDown = idTopDown.typeAnnotation;
	const innerTopDown = wrapperTopDown.typeAnnotation;
	check(
		'top-down inner type parent === TSTypeAnnotation wrapper',
		innerTopDown.parent?.type === 'TSTypeAnnotation',
	);
	// Bottom-up path: not yet supported correctly. We'd need wrapper
	// detection at materialise time. For now, just confirm the limitation
	// to make the deferred work explicit.
}

// --- Done ---------------------------------------------------------------

console.log(`\n${failures.length === 0 ? 'all pass' : `${failures.length} FAILED`}`);
if (failures.length) {
	for (const f of failures) console.log(`  - ${f}`);
}
process.exit(failures.length === 0 ? 0 : 1);
