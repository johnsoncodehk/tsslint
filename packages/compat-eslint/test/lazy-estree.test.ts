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

// --- Done ---------------------------------------------------------------

console.log(`\n${failures.length === 0 ? 'all pass' : `${failures.length} FAILED`}`);
if (failures.length) {
	for (const f of failures) console.log(`  - ${f}`);
}
process.exit(failures.length === 0 ? 0 : 1);
