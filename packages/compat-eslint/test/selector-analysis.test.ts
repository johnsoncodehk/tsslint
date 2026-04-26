// Trigger-set extraction tests for lib/selector-analysis.ts.
// Run via: node --experimental-strip-types --no-warnings packages/compat-eslint/test/selector-analysis.test.ts

const { buildTriggerSet, isCodePathListener, decomposeSimple } = require('../lib/selector-analysis.js') as typeof import('../lib/selector-analysis.js');

const failures: string[] = [];
function check(name: string, cond: boolean, detail?: string) {
	if (cond) {
		process.stdout.write('.');
	} else {
		failures.push(name + (detail ? ' — ' + detail : ''));
		process.stdout.write('F');
	}
}

// --- Single selectors -------------------------------------------------

{
	const t = buildTriggerSet(['Identifier']);
	check('Identifier matches Identifier', t.matches('Identifier'));
	check('Identifier does not match Literal', !t.matches('Literal'));
	check('Identifier is not isAll', !t.isAll());
}

{
	const t = buildTriggerSet(['*']);
	check('* is isAll', t.isAll());
	check('* matches anything', t.matches('Identifier') && t.matches('TSAnyKeyword'));
}

{
	const t = buildTriggerSet(['Identifier[name="foo"]']);
	check('Identifier[name="foo"] matches Identifier', t.matches('Identifier'));
	check('Identifier[name="foo"] does not match Literal', !t.matches('Literal'));
}

{
	const t = buildTriggerSet(['[name="foo"]']);
	check('standalone attribute is isAll', t.isAll());
}

// --- Combinators (matched node is right-hand side) --------------------

{
	const t = buildTriggerSet(['MemberExpression > Identifier']);
	check('child: matches Identifier', t.matches('Identifier'));
	check('child: does NOT match MemberExpression (it is context)', !t.matches('MemberExpression'));
}

{
	const t = buildTriggerSet(['CallExpression Identifier']);
	check('descendant: matches Identifier', t.matches('Identifier'));
	check('descendant: does NOT match CallExpression', !t.matches('CallExpression'));
}

{
	const t = buildTriggerSet(['A ~ B']);
	check('sibling: matches B', t.matches('B'));
	check('sibling: does NOT match A', !t.matches('A'));
}

{
	const t = buildTriggerSet(['A + B']);
	check('adjacent: matches B', t.matches('B'));
	check('adjacent: does NOT match A', !t.matches('A'));
}

// --- :matches() unions ------------------------------------------------

{
	const t = buildTriggerSet([':matches(A, B, C)']);
	check(':matches: matches A', t.matches('A'));
	check(':matches: matches B', t.matches('B'));
	check(':matches: matches C', t.matches('C'));
	check(':matches: does not match D', !t.matches('D'));
}

{
	const t = buildTriggerSet(['Identifier:matches([name="x"], [name="y"])']);
	check('compound[Identifier, :matches(filters)] matches Identifier', t.matches('Identifier'));
	check('compound: does not match Literal', !t.matches('Literal'));
}

// --- :not / :has — over-approximate to all ----------------------------

{
	const t = buildTriggerSet([':not(BinaryExpression)']);
	check(':not is over-approximated to all', t.isAll());
}

{
	const t = buildTriggerSet(['Identifier:not([name="x"])']);
	check('compound[Identifier, :not(...)] still constrains to Identifier', t.matches('Identifier') && !t.matches('Literal'));
	check('compound[Identifier, :not(...)] is not isAll', !t.isAll());
}

{
	const t = buildTriggerSet([':has(Literal)']);
	check(':has at top level is over-approximated to all', t.isAll());
}

{
	const t = buildTriggerSet(['CallExpression:has(Literal)']);
	check('compound[CallExpression, :has(...)] constrains to CallExpression', t.matches('CallExpression') && !t.matches('Literal'));
}

// --- :class() macros --------------------------------------------------

{
	const t = buildTriggerSet([':function']);
	check(':function matches FunctionDeclaration', t.matches('FunctionDeclaration'));
	check(':function matches FunctionExpression', t.matches('FunctionExpression'));
	check(':function matches ArrowFunctionExpression', t.matches('ArrowFunctionExpression'));
	check(':function does not match Identifier', !t.matches('Identifier'));
}

{
	const t = buildTriggerSet([':statement']);
	check(':statement matches IfStatement (suffix)', t.matches('IfStatement'));
	check(':statement matches BlockStatement', t.matches('BlockStatement'));
	check(':statement matches FunctionDeclaration (Declaration falls through)', t.matches('FunctionDeclaration'));
	check(':statement does not match BinaryExpression', !t.matches('BinaryExpression'));
}

{
	const t = buildTriggerSet([':declaration']);
	check(':declaration matches VariableDeclaration', t.matches('VariableDeclaration'));
	check(':declaration does NOT match IfStatement', !t.matches('IfStatement'));
}

{
	const t = buildTriggerSet([':expression']);
	check(':expression matches BinaryExpression', t.matches('BinaryExpression'));
	check(':expression matches Literal', t.matches('Literal'));
	check(':expression matches Identifier', t.matches('Identifier'));
	check(':expression does not match IfStatement', !t.matches('IfStatement'));
}

{
	const t = buildTriggerSet([':pattern']);
	check(':pattern matches ArrayPattern', t.matches('ArrayPattern'));
	check(':pattern matches ObjectPattern', t.matches('ObjectPattern'));
	check(':pattern matches Identifier (Expression falls through)', t.matches('Identifier'));
}

{
	const t = buildTriggerSet([':exit']);
	check(':exit standalone is isAll', t.isAll());
}

// --- :exit in compound is a phase marker, not a type filter -----------

{
	const t = buildTriggerSet(['FunctionDeclaration:exit']);
	check('compound[FunctionDeclaration, :exit] matches FunctionDeclaration', t.matches('FunctionDeclaration'));
	check('compound[FunctionDeclaration, :exit] is not isAll', !t.isAll());
	check('compound[FunctionDeclaration, :exit] does not match Identifier', !t.matches('Identifier'));
}

// --- Multiple selectors combine via union -----------------------------

{
	const t = buildTriggerSet(['Identifier', 'Literal', 'BinaryExpression']);
	check('multi: matches Identifier', t.matches('Identifier'));
	check('multi: matches Literal', t.matches('Literal'));
	check('multi: matches BinaryExpression', t.matches('BinaryExpression'));
	check('multi: does not match CallExpression', !t.matches('CallExpression'));
}

{
	const t = buildTriggerSet(['Identifier', '*']);
	check('multi: with wildcard becomes isAll', t.isAll());
}

// --- Code-path listener detection -------------------------------------

{
	check('isCodePathListener: onCodePathStart', isCodePathListener('onCodePathStart'));
	check('isCodePathListener: onCodePathEnd', isCodePathListener('onCodePathEnd'));
	check('isCodePathListener: onCodePathSegmentStart', isCodePathListener('onCodePathSegmentStart'));
	check('isCodePathListener: onUnreachableCodePathSegmentStart', isCodePathListener('onUnreachableCodePathSegmentStart'));
	check('isCodePathListener: rejects normal selector', !isCodePathListener('Identifier'));
	check('isCodePathListener: rejects FunctionDeclaration', !isCodePathListener('FunctionDeclaration'));
}

{
	const t = buildTriggerSet(['Identifier', 'onCodePathStart']);
	check('CPA listener forces isAll', t.isAll());
}

// --- Real-world selectors ---------------------------------------------

{
	// no-explicit-any
	const t = buildTriggerSet(['TSAnyKeyword']);
	check('no-explicit-any: matches TSAnyKeyword', t.matches('TSAnyKeyword'));
	check('no-explicit-any: does not match BinaryExpression', !t.matches('BinaryExpression'));
}

{
	// eqeqeq
	const t = buildTriggerSet(['BinaryExpression']);
	check('eqeqeq: matches BinaryExpression', t.matches('BinaryExpression'));
	check('eqeqeq: does not match TSTypeAnnotation', !t.matches('TSTypeAnnotation'));
}

{
	// prefer-const
	const t = buildTriggerSet(['VariableDeclaration', 'VariableDeclaration:exit', 'ForStatement', 'ForOfStatement', 'ForInStatement']);
	check('prefer-const: matches VariableDeclaration', t.matches('VariableDeclaration'));
	check('prefer-const: matches ForStatement', t.matches('ForStatement'));
	check('prefer-const: does not match BinaryExpression', !t.matches('BinaryExpression'));
}

{
	// no-unused-vars uses Program:exit and onCodePath* via scope manager
	const t = buildTriggerSet(['Program:exit']);
	check('Program:exit matches Program', t.matches('Program'));
	check('Program:exit does not match Identifier', !t.matches('Identifier'));
}

// --- Failure cases ----------------------------------------------------

{
	// "(" is a hard parse error in esquery; bare identifiers are accepted
	// (esquery is a permissive grammar — a chain of words parses as
	// descendant combinators). Use an unmistakably invalid token.
	const t = buildTriggerSet(['(']);
	check('invalid selector → over-approximate to isAll', t.isAll());
}

// =====================================================================
// decomposeSimple — fast-dispatch decomposition tests
// =====================================================================
//
// Each test parses a selector with `decomposeSimple` and asserts both
// the structural decomposition (trigger types, fieldFire, isExit) AND
// the runtime filter behavior on a hand-built ESTree-shaped node graph.
// The graphs are deliberately tiny — just enough properties for the
// matcher / visitor-keys lookup to find what it needs.
//
// Filter shorthands:
//   `decompose(selector)` returns `infos | null`. We expect a single
//   info on most cases — `take(infos)` asserts that and unwraps.
//   `apply(info, target)` runs the dispatch sequence (typeFilter +
//   fieldFire + filter) the way `dispatchFast` would; returns whether
//   the listener would fire.

function take(infos: ReturnType<typeof decomposeSimple>): NonNullable<ReturnType<typeof decomposeSimple>>[number] {
	if (!infos || infos.length !== 1) {
		throw new Error(`expected single decomposition, got ${infos === null ? 'null' : infos.length}`);
	}
	return infos[0];
}

function apply(info: NonNullable<ReturnType<typeof decomposeSimple>>[number], target: any): boolean {
	// Mirrors dispatchFast: type-gate happens FIRST on the dispatched
	// node (target), THEN fieldFire / typeFilter / filter resolve.
	if (info.types !== 'all' && !info.types.has(target.type)) return false;
	let actual = target;
	if (info.fieldFire !== undefined) {
		actual = target[info.fieldFire];
		if (actual == null || Array.isArray(actual)) return false;
	}
	if (info.typeFilter !== undefined && actual.type !== info.typeFilter) return false;
	if (info.filter && !info.filter(actual)) return false;
	return true;
}

// Helper to wire .parent links so descendant / sibling / has filters work.
function wire(node: any): any {
	const stack = [node];
	while (stack.length) {
		const cur = stack.pop();
		for (const k of Object.keys(cur)) {
			if (k === 'parent' || k === 'type') continue;
			const v = cur[k];
			if (Array.isArray(v)) {
				for (const c of v) {
					if (c && typeof c === 'object' && typeof c.type === 'string') {
						c.parent = cur;
						stack.push(c);
					}
				}
			} else if (v && typeof v === 'object' && typeof v.type === 'string') {
				v.parent = cur;
				stack.push(v);
			}
		}
	}
	return node;
}

// --- Simple type / compound / matches ---------------------------------

{
	const info = take(decomposeSimple('Identifier'));
	check('decomp: Identifier types {Identifier}', info.types !== 'all' && info.types.has('Identifier') && info.types.size === 1);
	check('decomp: Identifier not isExit', !info.isExit);
}

{
	const info = take(decomposeSimple('Identifier:exit'));
	check('decomp: Identifier:exit isExit', info.isExit);
}

{
	const infos = decomposeSimple('A, B, C');
	check('decomp: matches list yields 3 entries', infos !== null && infos.length === 3);
	check('decomp: matches list types', infos !== null
		&& infos[0].types !== 'all' && infos[0].types.has('A')
		&& infos[1].types !== 'all' && infos[1].types.has('B')
		&& infos[2].types !== 'all' && infos[2].types.has('C'));
}

{
	// Top-level `:matches(A, B)` expands into per-branch entries (same as
	// `A, B`) — branch-specific filters can stay scoped that way.
	const infos = decomposeSimple(':matches(A, B)');
	check('decomp: top-level :matches expands to per-branch entries', infos !== null && infos.length === 2);
}

{
	// Nested inside compound, `:matches(...)` collapses into the type set.
	const info = take(decomposeSimple('Identifier:matches([name="x"], [name="y"])'));
	check('decomp: compound + matches(attr-only) yields {Identifier}',
		info.types !== 'all' && info.types.has('Identifier') && info.types.size === 1);
	check('compound + matches filter accepts name=x',
		info.filter!({ type: 'Identifier', name: 'x' }));
	check('compound + matches filter accepts name=y',
		info.filter!({ type: 'Identifier', name: 'y' }));
	check('compound + matches filter rejects name=z',
		!info.filter!({ type: 'Identifier', name: 'z' }));
}

// --- Wildcard / class macros ------------------------------------------

{
	const info = take(decomposeSimple('*'));
	check('decomp: * is all', info.types === 'all');
}

{
	const info = take(decomposeSimple(':function'));
	check('decomp: :function expands to 3 fn types',
		info.types !== 'all'
		&& info.types.has('FunctionDeclaration')
		&& info.types.has('FunctionExpression')
		&& info.types.has('ArrowFunctionExpression')
		&& info.types.size === 3);
}

{
	const info = take(decomposeSimple(':statement'));
	check('decomp: :statement is wildcard + filter', info.types === 'all' && !!info.filter);
	check(':statement matches IfStatement', info.filter!({ type: 'IfStatement' }));
	check(':statement matches VariableDeclaration', info.filter!({ type: 'VariableDeclaration' }));
	check(':statement does not match Identifier', !info.filter!({ type: 'Identifier' }));
}

{
	const info = take(decomposeSimple(':expression'));
	check(':expression matches CallExpression', !!info.filter && info.filter({ type: 'CallExpression' }));
	check(':expression matches Literal', !!info.filter && info.filter({ type: 'Literal' }));
	check(':expression matches Identifier', !!info.filter && info.filter({ type: 'Identifier' }));
	check(':expression does not match IfStatement', !info.filter!({ type: 'IfStatement' }));
}

{
	const info = take(decomposeSimple(':declaration'));
	check(':declaration matches VariableDeclaration', !!info.filter && info.filter({ type: 'VariableDeclaration' }));
	check(':declaration does not match IfStatement', !info.filter!({ type: 'IfStatement' }));
}

{
	const info = take(decomposeSimple(':pattern'));
	check(':pattern matches ArrayPattern', !!info.filter && info.filter({ type: 'ArrayPattern' }));
	check(':pattern matches Identifier', !!info.filter && info.filter({ type: 'Identifier' }));
	check(':pattern does not match IfStatement', !info.filter!({ type: 'IfStatement' }));
}

// --- Attributes -------------------------------------------------------

{
	const info = take(decomposeSimple('Identifier[name="foo"]'));
	check('decomp: attr eq filter exists', !!info.filter);
	check('attr filter matches Identifier{name:foo}', info.filter!({ type: 'Identifier', name: 'foo' }));
	check('attr filter rejects Identifier{name:bar}', !info.filter!({ type: 'Identifier', name: 'bar' }));
}

{
	const info = take(decomposeSimple('Foo[bar.baz="x"]'));
	check('attr dotted-path matches', info.filter!({ type: 'Foo', bar: { baz: 'x' } }));
	check('attr dotted-path rejects', !info.filter!({ type: 'Foo', bar: { baz: 'y' } }));
	check('attr dotted-path tolerates missing intermediate',
		!info.filter!({ type: 'Foo' }));
}

{
	// esquery's `null` is parsed as the string literal "null" (its
	// grammar doesn't distinguish JS null from the bare word). The
	// `Literal[raw=null]` selector used by `no-restricted-syntax` rules
	// works because `Literal.raw === "null"` for the JS null literal.
	const info = take(decomposeSimple('Literal[raw=null]'));
	check('attr eq raw="null" matches the JS null literal',
		info.filter!({ type: 'Literal', raw: 'null' }));
	check('attr eq raw="null" rejects other literals',
		!info.filter!({ type: 'Literal', raw: '42' }));
}

// --- :not -------------------------------------------------------------

{
	const info = take(decomposeSimple(':not(Identifier)'));
	check(':not(Identifier) wildcard + filter', info.types === 'all' && !!info.filter);
	check(':not(Identifier) rejects Identifier', !info.filter!({ type: 'Identifier' }));
	check(':not(Identifier) accepts Literal', info.filter!({ type: 'Literal' }));
}

{
	const info = take(decomposeSimple('Foo:not(Bar)'));
	check('Foo:not(Bar) types {Foo}',
		info.types !== 'all' && info.types.has('Foo') && info.types.size === 1);
	check('Foo:not(Bar) filter rejects parent.type Bar redundantly',
		!info.filter!({ type: 'Bar' }));
	check('Foo:not(Bar) filter accepts type Foo',
		info.filter!({ type: 'Foo' }));
}

{
	const info = take(decomposeSimple(':not(A, B)'));
	check(':not(A, B) wildcard', info.types === 'all');
	check(':not(A, B) rejects A', !info.filter!({ type: 'A' }));
	check(':not(A, B) rejects B', !info.filter!({ type: 'B' }));
	check(':not(A, B) accepts C', info.filter!({ type: 'C' }));
}

// --- Combinators: child / descendant ----------------------------------

{
	const info = take(decomposeSimple('Foo > Bar'));
	check('child: trigger Bar', info.types !== 'all' && info.types.has('Bar'));
	const tree = wire({ type: 'Foo', body: { type: 'Bar' } });
	const bar = tree.body;
	check('Foo > Bar fires when parent is Foo', info.filter!(bar));
	check('Foo > Bar rejects when parent is Other',
		!info.filter!(wire({ type: 'Other', body: { type: 'Bar' } }).body));
}

{
	const info = take(decomposeSimple('Foo > *.field'));
	check('Foo > *.field fieldFire is field', info.fieldFire === 'field');
	check('Foo > *.field types {Foo}', info.types !== 'all' && info.types.has('Foo'));
}

{
	const info = take(decomposeSimple('Foo > Bar.field'));
	check('typed-fieldFire fieldFire', info.fieldFire === 'field');
	check('typed-fieldFire typeFilter Bar', info.typeFilter === 'Bar');
}

{
	const info = take(decomposeSimple('Foo Bar'));
	const root = wire({ type: 'Foo', body: { type: 'Mid', body: { type: 'Bar' } } });
	const innerBar = root.body.body;
	check('descendant: matches when ancestor present', info.filter!(innerBar));
	const detached = wire({ type: 'Other', body: { type: 'Bar' } }).body;
	check('descendant: rejects when ancestor absent', !info.filter!(detached));
}

// `:not(Foo) > Bar` — left side is a `:not` matcher
{
	const info = take(decomposeSimple(':not(Foo) > Bar'));
	check(':not(Foo) > Bar types {Bar}', info.types !== 'all' && info.types.has('Bar'));
	const okTree = wire({ type: 'Other', body: { type: 'Bar' } });
	const badTree = wire({ type: 'Foo', body: { type: 'Bar' } });
	check(':not(Foo) > Bar accepts when parent is not Foo', info.filter!(okTree.body));
	check(':not(Foo) > Bar rejects when parent is Foo', !info.filter!(badTree.body));
}

// Chained: `:not(A) > B > C`
{
	const info = take(decomposeSimple(':not(A) > B > C'));
	check('chained selector types {C}', info.types !== 'all' && info.types.has('C'));
	const ok = wire({ type: 'X', body: { type: 'B', body: { type: 'C' } } });
	const bad = wire({ type: 'A', body: { type: 'B', body: { type: 'C' } } });
	check('chained selector accepts X > B > C', info.filter!(ok.body.body));
	check('chained selector rejects A > B > C', !info.filter!(bad.body.body));
}

// --- Combinators: sibling / adjacent ---------------------------------

{
	const info = take(decomposeSimple('A + B'));
	check('adjacent: types {B}', info.types !== 'all' && info.types.has('B'));
	const root = wire({
		type: 'BlockStatement',
		body: [
			{ type: 'A' },
			{ type: 'B' },
			{ type: 'C' },
			{ type: 'B' },
		],
	});
	check('A + B accepts second element after A', info.filter!(root.body[1]));
	check('A + B rejects third element (after B, not A)', !info.filter!(root.body[2]));
	check('A + B rejects fourth element (after C)', !info.filter!(root.body[3]));
}

{
	const info = take(decomposeSimple('A ~ B'));
	const root = wire({
		type: 'BlockStatement',
		body: [
			{ type: 'A' },
			{ type: 'C' },
			{ type: 'B' },
			{ type: 'B' },
		],
	});
	check('A ~ B accepts B that has A earlier', info.filter!(root.body[2]));
	check('A ~ B accepts later B too', info.filter!(root.body[3]));
	const noA = wire({
		type: 'BlockStatement',
		body: [{ type: 'C' }, { type: 'B' }],
	});
	check('A ~ B rejects when no A before', !info.filter!(noA.body[1]));
}

// --- :has -------------------------------------------------------------

{
	const info = take(decomposeSimple('Foo:has(Bar)'));
	check('Foo:has(Bar) types {Foo}', info.types !== 'all' && info.types.has('Foo'));
	const ok = wire({
		type: 'Foo',
		body: { type: 'X', body: { type: 'Bar' } },
	});
	check('Foo:has(Bar) finds nested Bar', info.filter!(ok));
	const direct = wire({ type: 'Foo', body: { type: 'Bar' } });
	check('Foo:has(Bar) finds direct Bar', info.filter!(direct));
	const none = wire({ type: 'Foo', body: { type: 'X' } });
	check('Foo:has(Bar) rejects when no Bar', !info.filter!(none));
}

{
	const info = take(decomposeSimple(':has(Bar)'));
	check(':has(Bar) standalone wildcard', info.types === 'all');
	const ok = wire({ type: 'Anything', body: { type: 'Bar' } });
	check(':has(Bar) standalone fires when descendant matches', info.filter!(ok));
}

// --- :nth-child / :nth-last-child / :first-child / :last-child --------

{
	const info = take(decomposeSimple(':first-child'));
	const root = wire({ type: 'BlockStatement', body: [{ type: 'A' }, { type: 'B' }] });
	check(':first-child fires on body[0]', info.filter!(root.body[0]));
	check(':first-child rejects body[1]', !info.filter!(root.body[1]));
}

{
	const info = take(decomposeSimple(':last-child'));
	const root = wire({ type: 'BlockStatement', body: [{ type: 'A' }, { type: 'B' }, { type: 'C' }] });
	check(':last-child fires on body[2]', info.filter!(root.body[2]));
	check(':last-child rejects body[0]', !info.filter!(root.body[0]));
}

{
	const info = take(decomposeSimple(':nth-child(2)'));
	const root = wire({ type: 'BlockStatement', body: [{ type: 'A' }, { type: 'B' }, { type: 'C' }] });
	check(':nth-child(2) fires on body[1]', info.filter!(root.body[1]));
	check(':nth-child(2) rejects body[0]', !info.filter!(root.body[0]));
}

{
	const info = take(decomposeSimple(':nth-last-child(2)'));
	const root = wire({ type: 'BlockStatement', body: [{ type: 'A' }, { type: 'B' }, { type: 'C' }] });
	check(':nth-last-child(2) fires on body[1]', info.filter!(root.body[1]));
	check(':nth-last-child(2) rejects body[2]', !info.filter!(root.body[2]));
}

{
	// Compound: `BlockStatement > IfStatement:first-child` — narrow trigger
	// types AND positional filter.
	const info = take(decomposeSimple('BlockStatement > IfStatement:first-child'));
	const root = wire({
		type: 'BlockStatement',
		body: [
			{ type: 'IfStatement' },
			{ type: 'IfStatement' },
		],
	});
	check('compound child + first-child fires on body[0]', info.filter!(root.body[0]));
	check('compound child + first-child rejects body[1]', !info.filter!(root.body[1]));
}

// --- :scope (no-op outside :has) --------------------------------------

{
	const info = take(decomposeSimple(':scope'));
	check(':scope standalone is wildcard', info.types === 'all');
}

// --- Mixed real-world rules ------------------------------------------

{
	const info = take(decomposeSimple('PropertyDefinition > *.value'));
	check('no-eval-style fieldFire', info.fieldFire === 'value');
}

{
	const info = take(decomposeSimple('CallExpression[optional = true] > TSNonNullExpression.callee'));
	check('typed fieldFire + parent attr', info.fieldFire === 'callee' && info.typeFilter === 'TSNonNullExpression');
	const target: any = { type: 'TSNonNullExpression' };
	const parent: any = { type: 'CallExpression', optional: true, callee: target };
	target.parent = parent;
	check('parent attr filter accepts optional CallExpression', apply(info, parent));
	const target2: any = { type: 'TSNonNullExpression' };
	const parent2: any = { type: 'CallExpression', optional: false, callee: target2 };
	target2.parent = parent2;
	check('parent attr filter rejects non-optional CallExpression', !apply(info, parent2));
}

console.log();
if (failures.length) {
	console.log('FAILURES:');
	for (const f of failures) console.log('  ' + f);
	process.exit(1);
}
console.log('All selector-analysis tests passed');
