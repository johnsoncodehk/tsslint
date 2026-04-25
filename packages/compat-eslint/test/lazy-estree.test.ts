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

// --- Comparison semantics -----------------------------------------------

// Rules use `===` and Set/WeakSet membership to track "have I seen this node?"
// across enter/exit visits. Two reads of the same slot must give the same
// reference and survive WeakSet membership checks.
{
	const sf = parseTs('let x = 1;');
	const { estree } = lazy.convertLazy(sf);
	const decl = (estree.body as any)[0];
	const declarator1 = decl.declarations[0];
	const seen = new WeakSet<object>();
	seen.add(declarator1);
	// Re-access through getters — WeakSet must hit on the same instance.
	const declarator2 = (estree.body as any)[0].declarations[0];
	check('comparison: WeakSet membership stable across re-access', seen.has(declarator2));
	check('comparison: === stable across re-access', declarator1 === declarator2);
}

// Set<LazyNode> with mixed access patterns — top-down then bottom-up.
{
	const sf = parseTs('let x = 1;');
	const { estree, context } = lazy.convertLazy(sf);
	const tsId = (sf.statements[0] as ts.VariableStatement).declarationList.declarations[0].name as ts.Identifier;
	const topDown = ((estree.body as any)[0]).declarations[0].id;
	const seen = new Set<object>([topDown]);
	const bottomUp = lazy.materialize(tsId, context);
	check('comparison: Set membership across top-down/bottom-up', seen.has(bottomUp));
}

// --- null vs undefined semantics ---------------------------------------

// `let x;` — VariableDeclarator without initializer. Eager returns `null`
// (convertChild's null path), not undefined. Match it.
{
	const sf = parseTs('let x;');
	const { estree } = lazy.convertLazy(sf);
	const declarator = ((estree.body as any)[0]).declarations[0];
	const eager = eagerConvert(parseTs('let x;'));
	const eagerDeclarator = eager.body[0].declarations[0];
	check('null/undefined: lazy missing init === null', declarator.init === null);
	check('null/undefined: matches eager (both null or both undefined)', declarator.init === eagerDeclarator.init);
}

// Identifier without typeAnnotation — eager sets `typeAnnotation: undefined`
// (literal undefined, not null). Confirm parity.
{
	const sf = parseTs('let x = 1;');
	const { estree } = lazy.convertLazy(sf);
	const id = ((estree.body as any)[0]).declarations[0].id;
	check('null/undefined: untyped identifier.typeAnnotation === undefined', id.typeAnnotation === undefined);
}

// --- Multiple concurrent convertLazy() calls --------------------------

// Two convertLazy() invocations must not share state — each owns its maps.
// Equivalent nodes from the two trees are NOT === to each other.
{
	const code = 'let x = 1;';
	const sfA = parseTs(code);
	const sfB = parseTs(code);
	const a = lazy.convertLazy(sfA);
	const b = lazy.convertLazy(sfB);
	const idA = ((a.estree.body as any)[0]).declarations[0].id;
	const idB = ((b.estree.body as any)[0]).declarations[0].id;
	check('concurrent: roots are distinct instances', a.estree !== b.estree);
	check('concurrent: descendants are distinct instances', idA !== idB);
	check('concurrent: maps are distinct objects', a.astMaps !== b.astMaps);
	check('concurrent: A maps do not contain B nodes', !a.astMaps.esTreeNodeToTSNodeMap.has(idB));
	check('concurrent: B maps do not contain A nodes', !b.astMaps.esTreeNodeToTSNodeMap.has(idA));
}

// Re-converting the SAME ts.SourceFile yields a fresh Program (matches the
// eager Converter, which creates a new instance per call).
{
	const sf = parseTs('let x = 1;');
	const r1 = lazy.convertLazy(sf);
	const r2 = lazy.convertLazy(sf);
	check('reconvert: same SourceFile -> distinct Program instances', r1.estree !== r2.estree);
	check('reconvert: distinct astMaps', r1.astMaps !== r2.astMaps);
}

// --- Iteration semantics on child arrays --------------------------------

// `body` must behave like a real array — indexing, .length, spread, for-of,
// .find, .map all work. Materialised eagerly on first read but cached.
{
	const sf = parseTs('let a = 1; let b = 2; let c = 3;');
	const { estree } = lazy.convertLazy(sf);
	const body = (estree.body as any);
	check('iteration: Array.isArray(body)', Array.isArray(body));
	check('iteration: body.length === 3', body.length === 3);
	check('iteration: indexed access', body[0] != null && body[1] != null && body[2] != null);
	const spread = [...body];
	check('iteration: spread length matches', spread.length === 3);
	let count = 0;
	for (const _ of body) count++;
	check('iteration: for-of count', count === 3);
	const mapped = body.map((n: any) => n.type);
	check('iteration: .map preserves length', mapped.length === 3);
	check('iteration: .find returns identity', body.find((n: any) => n.type === 'VariableDeclaration') === body[0]);
}

// Two reads of body return the SAME array (memoised), so list-based
// dedupe (Set on body itself) works as expected.
{
	const sf = parseTs('let x = 1;');
	const { estree } = lazy.convertLazy(sf);
	const b1 = estree.body;
	const b2 = estree.body;
	check('iteration: body array identity stable', b1 === b2);
}

// --- Mutation -----------------------------------------------------------

// typescript-estree's convertBodyExpressions attaches `directive` to the
// child node post-construction. Our shim must permit ad-hoc property writes.
{
	const sf = parseTs('"use strict";');
	const { estree } = lazy.convertLazy(sf);
	// "use strict"; doesn't actually parse cleanly without an ExpressionStatement
	// (which we don't yet support) — but we can still test mutation on a
	// supported node. Use Identifier instead.
	void estree;
}
{
	const sf = parseTs('let x = 1;');
	const { estree } = lazy.convertLazy(sf);
	const id = ((estree.body as any)[0]).declarations[0].id;
	let mutationOK = true;
	try { (id as any).extraProp = 'hello'; } catch { mutationOK = false; }
	check('mutation: ad-hoc property write succeeds', mutationOK && (id as any).extraProp === 'hello');
}

// --- Object.keys / for-in -----------------------------------------------

// Class-prototype getters do NOT show in Object.keys (own-enumerable only).
// Some real rules iterate Object.keys to discover children; document the
// behaviour even if we don't fix it.
{
	const sf = parseTs('let x = 1;');
	const { estree } = lazy.convertLazy(sf);
	const decl = (estree.body as any)[0];
	const keys = Object.keys(decl);
	// Trigger the getter materialisation:
	void decl.declarations;
	const keysAfter = Object.keys(decl);
	// Documented: getter `declarations` won't show up in keys whether or not
	// it's been read, because it's defined on the prototype. The getter's
	// memo field `_declarations` IS an own field set in the getter body, so
	// IT shows up after access.
	check('object-keys: prototype getters not in Object.keys (before)', !keys.includes('declarations'));
	check('object-keys: prototype getters not in Object.keys (after)', !keysAfter.includes('declarations'));
	check('object-keys: memo backing field appears after access', keysAfter.includes('_declarations'));
}

// --- TSTypeAnnotation wrapper subtleties ------------------------------

// Maps invariants for the synthetic wrapper:
// - tsNodeToESTreeNodeMap[tsType] points at the INNER (TSNumberKeyword)
//   so that materialise(tsType) returns the inner, not the wrapper.
// - esTreeNodeToTSNodeMap[wrapper] is undefined (wrapper is not registered).
{
	const sf = parseTs('let x: number = 1;');
	const { estree, astMaps } = lazy.convertLazy(sf);
	const id = ((estree.body as any)[0]).declarations[0].id;
	const wrapper = id.typeAnnotation;
	const inner = wrapper.typeAnnotation;
	const tsType = (sf.statements[0] as ts.VariableStatement).declarationList.declarations[0].type!;
	check('wrapper: tsNodeToESTreeNodeMap[tsType] points at inner (not wrapper)',
		astMaps.tsNodeToESTreeNodeMap.get(tsType) === inner);
	check('wrapper: esTreeNodeToTSNodeMap[wrapper] is undefined (not registered)',
		astMaps.esTreeNodeToTSNodeMap.get(wrapper) === undefined);
	check('wrapper: esTreeNodeToTSNodeMap[inner] is the TS type node',
		astMaps.esTreeNodeToTSNodeMap.get(inner) === tsType);
	// Range: wrapper covers the leading colon (one char before tsType.start),
	// so wrapper.range[0] < inner.range[0].
	check('wrapper: range starts before inner range (covers leading colon)',
		wrapper.range[0] < inner.range[0]);
	check('wrapper: range ends at inner range end',
		wrapper.range[1] === inner.range[1]);
}

// --- Range correctness for AsExpression ------------------------------

// `(x) as Foo` — the parens are not part of the AsExpression range in
// typescript-estree (eager treats them as a ParenthesizedExpression which
// our MVP doesn't yet support). Just verify simple `x as Foo` parity, which
// is already covered by the parity walker — but check range numerics
// directly so a regression is loud.
{
	const code = 'let x = 1 as number;';
	const sf = parseTs(code);
	const { estree } = lazy.convertLazy(sf);
	const eager = eagerConvert(parseTs(code));
	const lazyAs = ((estree.body as any)[0]).declarations[0].init;
	const eagerAs = eager.body[0].declarations[0].init;
	check('AsExpression range: lazy [0]', lazyAs.range[0] === eagerAs.range[0]);
	check('AsExpression range: lazy [1]', lazyAs.range[1] === eagerAs.range[1]);
	check('AsExpression: type matches', lazyAs.type === 'TSAsExpression');
}

// --- Stale parent references -------------------------------------------

// If a node's `parent` was set during top-down construction, a later
// bottom-up materialise (cache hit) must NOT clobber it.
{
	const sf = parseTs('let x = 1;');
	const { estree, context } = lazy.convertLazy(sf);
	const tsId = (sf.statements[0] as ts.VariableStatement).declarationList.declarations[0].name as ts.Identifier;
	const topDownId = ((estree.body as any)[0]).declarations[0].id;
	const originalParent = topDownId.parent;
	// Materialise again via bottom-up — should be a cache hit.
	const bottomUpId = lazy.materialize(tsId, context);
	check('parent: not clobbered by subsequent materialise', bottomUpId.parent === originalParent);
	check('parent: same instance returned', bottomUpId === topDownId);
}

// --- Range/loc edge cases ----------------------------------------------

// loc is 1-indexed for line, 0-indexed for column. Sanity-check the very
// first identifier in single-line source.
{
	const sf = parseTs('let abc = 1;');
	const { estree } = lazy.convertLazy(sf);
	const id = ((estree.body as any)[0]).declarations[0].id;
	check('loc: line is 1-indexed', id.loc.start.line === 1);
	check('loc: column is 0-indexed', id.loc.start.column === 4);
	check('loc: end column matches identifier length', id.loc.end.column === 7);
}

// CRLF newlines: line counters must increment on \r\n once, not twice.
{
	const code = 'let a = 1;\r\nlet b = 2;\r\n';
	const sf = parseTs(code);
	const { estree } = lazy.convertLazy(sf);
	const eager = eagerConvert(parseTs(code));
	const lazyB = ((estree.body as any)[1]).declarations[0].id;
	const eagerB = eager.body[1].declarations[0].id;
	check('CRLF: line numbers match eager', lazyB.loc.start.line === eagerB.loc.start.line);
	check('CRLF: ranges match eager', lazyB.range[0] === eagerB.range[0] && lazyB.range[1] === eagerB.range[1]);
}

// Source ending without trailing newline — last identifier's end range
// must still match eager.
{
	const code = 'let xyz = 1';
	const sf = parseTs(code);
	const { estree } = lazy.convertLazy(sf);
	const eager = eagerConvert(parseTs(code));
	const lazyId = ((estree.body as any)[0]).declarations[0].id;
	const eagerId = eager.body[0].declarations[0].id;
	check('no-trailing-nl: id range matches eager',
		lazyId.range[0] === eagerId.range[0] && lazyId.range[1] === eagerId.range[1]);
	check('no-trailing-nl: Program end matches eager',
		estree.range[1] === eager.range[1]);
}

// Empty source: Program with empty body, range [0, 0].
{
	const sf = parseTs('');
	const { estree } = lazy.convertLazy(sf);
	const eager = eagerConvert(parseTs(''));
	check('empty source: lazy body length 0', (estree.body as any).length === 0);
	check('empty source: range [0,0]',
		estree.range[0] === eager.range[0] && estree.range[1] === eager.range[1]);
	check('empty source: loc shape matches',
		estree.loc.start.line === eager.loc.start.line
		&& estree.loc.end.line === eager.loc.end.line);
}

// Whitespace-only source: Program range starts at the END of leading ws
// (eager getStart skips it), but typescript-estree's Program range starts at
// 0 because SourceFile.getStart() === SourceFile.pos === 0. Verify parity.
{
	const code = '   \n  ';
	const sf = parseTs(code);
	const { estree } = lazy.convertLazy(sf);
	const eager = eagerConvert(parseTs(code));
	check('whitespace-only: range matches eager',
		estree.range[0] === eager.range[0] && estree.range[1] === eager.range[1]);
}

// --- Future / blocked --------------------------------------------------
//
// Edge cases NOT exercisable in current MVP scope. Each is annotated with
// what would unblock it.
//
// (b) Requires more SyntaxKinds:
//   - ExpressionStatement + StringLiteral with `directive` field —
//     convertBodyExpressions in eager attaches `directive`, exercising
//     post-construction mutation through a typed slot. Needs
//     SK.ExpressionStatement.
//   - PrivateIdentifier / ThisExpression / `typeof this.foo` — special
//     Identifier paths in eager (line 499).
//   - Block / BlockStatement, FunctionDeclaration, ArrayLiteralExpression,
//     ObjectLiteralExpression — broader fixture surface for parity.
//   - TSTypeParameterInstantiation wrapper for TSTypeReference.typeArguments
//     (eager wraps; we currently elide). Needs `Foo<number>` fixture and a
//     wrapper class similar to TSTypeAnnotation.
//   - FunctionType / ConstructorType (`=>` offset path in
//     convertTypeAnnotation) — only StringKeyword/NumberKeyword positions
//     are covered today; `() => number` would force the 2-char-offset branch.
//
// (c) Requires production wiring:
//   - WeakMap GC behaviour — global.gc() is unavailable without
//     `--expose-gc`, and Node's WeakRef-based heuristics make this flaky in
//     a test harness. Tracked as "trust the WeakMap, don't grow without
//     bound" in production telemetry rather than an in-test assertion.
//   - Bottom-up materialise of a node inside a TSTypeAnnotation slot —
//     known limitation (already documented above). Fix needs slot-detection
//     in `materialize()`.
//
// (d) Speculative / not worth a test:
//   - JSON.stringify on a lazy node — circular via `parent`, would throw
//     unless rules manually prune. Eager has the same problem; not a parity
//     concern.
//   - `instanceof` checks against typescript-estree's exported AST classes
//     — eager doesn't export them as classes either; rules don't use this.
//   - BOM in source — TS parser normalises before we see it; the lazy
//     layer inherits whatever the SourceFile reports.

// --- Done ---------------------------------------------------------------

console.log(`\n${failures.length === 0 ? 'all pass' : `${failures.length} FAILED`}`);
if (failures.length) {
	for (const f of failures) console.log(`  - ${f}`);
}
process.exit(failures.length === 0 ? 0 : 1);
