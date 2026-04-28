// Tests for lib/selector-analysis.ts — covers `decomposeSimple` (the
// fast-dispatch decomposer) and the `isCodePathListener` predicate.
// Run via: node --experimental-strip-types --no-warnings packages/compat-eslint/test/selector-analysis.test.ts

const { isCodePathListener, decomposeSimple, UnsupportedSelectorError } = require(
	'../lib/selector-analysis.js',
) as typeof import('../lib/selector-analysis.js');

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

// --- Code-path listener detection -------------------------------------

{
	check('isCodePathListener: onCodePathStart', isCodePathListener('onCodePathStart'));
	check('isCodePathListener: onCodePathEnd', isCodePathListener('onCodePathEnd'));
	check('isCodePathListener: onCodePathSegmentStart', isCodePathListener('onCodePathSegmentStart'));
	check(
		'isCodePathListener: onUnreachableCodePathSegmentStart',
		isCodePathListener('onUnreachableCodePathSegmentStart'),
	);
	check('isCodePathListener: rejects normal selector', !isCodePathListener('Identifier'));
	check('isCodePathListener: rejects FunctionDeclaration', !isCodePathListener('FunctionDeclaration'));
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

function take(infos: ReturnType<typeof decomposeSimple>): ReturnType<typeof decomposeSimple>[number] {
	if (infos.length !== 1) {
		throw new Error(`expected single decomposition, got ${infos.length}`);
	}
	return infos[0];
}

function apply(info: ReturnType<typeof decomposeSimple>[number], target: any): boolean {
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
			}
			else if (v && typeof v === 'object' && typeof v.type === 'string') {
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
	check(
		'decomp: Identifier types {Identifier}',
		info.types !== 'all' && info.types.has('Identifier') && info.types.size === 1,
	);
	check('decomp: Identifier not isExit', !info.isExit);
}

{
	const info = take(decomposeSimple('Identifier:exit'));
	check('decomp: Identifier:exit isExit', info.isExit);
}

{
	const infos = decomposeSimple('A, B, C');
	check('decomp: matches list yields 3 entries', infos !== null && infos.length === 3);
	check(
		'decomp: matches list types',
		infos !== null
			&& infos[0].types !== 'all' && infos[0].types.has('A')
			&& infos[1].types !== 'all' && infos[1].types.has('B')
			&& infos[2].types !== 'all' && infos[2].types.has('C'),
	);
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
	check(
		'decomp: compound + matches(attr-only) yields {Identifier}',
		info.types !== 'all' && info.types.has('Identifier') && info.types.size === 1,
	);
	check('compound + matches filter accepts name=x', info.filter!({ type: 'Identifier', name: 'x' }));
	check('compound + matches filter accepts name=y', info.filter!({ type: 'Identifier', name: 'y' }));
	check('compound + matches filter rejects name=z', !info.filter!({ type: 'Identifier', name: 'z' }));
}

// --- Wildcard / class macros ------------------------------------------

{
	const info = take(decomposeSimple('*'));
	check('decomp: * is all', info.types === 'all');
}

{
	const info = take(decomposeSimple(':function'));
	check(
		'decomp: :function expands to 3 fn types',
		info.types !== 'all'
			&& info.types.has('FunctionDeclaration')
			&& info.types.has('FunctionExpression')
			&& info.types.has('ArrowFunctionExpression')
			&& info.types.size === 3,
	);
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
	check('attr dotted-path tolerates missing intermediate', !info.filter!({ type: 'Foo' }));
}

{
	// esquery's `null` is parsed as the string literal "null" (its
	// grammar doesn't distinguish JS null from the bare word). The
	// `Literal[raw=null]` selector used by `no-restricted-syntax` rules
	// works because `Literal.raw === "null"` for the JS null literal.
	const info = take(decomposeSimple('Literal[raw=null]'));
	check('attr eq raw="null" matches the JS null literal', info.filter!({ type: 'Literal', raw: 'null' }));
	check('attr eq raw="null" rejects other literals', !info.filter!({ type: 'Literal', raw: '42' }));
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
	check('Foo:not(Bar) types {Foo}', info.types !== 'all' && info.types.has('Foo') && info.types.size === 1);
	check('Foo:not(Bar) filter rejects parent.type Bar redundantly', !info.filter!({ type: 'Bar' }));
	check('Foo:not(Bar) filter accepts type Foo', info.filter!({ type: 'Foo' }));
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
	check('Foo > Bar rejects when parent is Other', !info.filter!(wire({ type: 'Other', body: { type: 'Bar' } }).body));
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

// --- Right-side combinator selectors (closes walkChild fallthroughs) --

{
	const info = take(decomposeSimple('Foo > :not(Bar)'));
	check('Foo > :not(Bar) types include {Foo}-anchored wildcard', info.types === 'all');
	const okTree = wire({ type: 'Foo', body: { type: 'Other' } });
	const badTree = wire({ type: 'Foo', body: { type: 'Bar' } });
	check('Foo > :not(Bar) accepts non-Bar child', info.filter!(okTree.body));
	check('Foo > :not(Bar) rejects Bar child', !info.filter!(badTree.body));
}

{
	const info = take(decomposeSimple('Foo > :has(Bar)'));
	const ok = wire({ type: 'Foo', body: { type: 'Wrapper', body: { type: 'Bar' } } });
	check('Foo > :has(Bar) accepts wrapper child with Bar descendant', info.filter!(ok.body));
	const bad = wire({ type: 'Foo', body: { type: 'Wrapper', body: { type: 'X' } } });
	check('Foo > :has(Bar) rejects wrapper with no Bar', !info.filter!(bad.body));
}

{
	const info = take(decomposeSimple('Foo > :function'));
	check(
		'Foo > :function types is the 3-fn set',
		info.types !== 'all'
			&& info.types.has('FunctionDeclaration')
			&& info.types.has('FunctionExpression')
			&& info.types.has('ArrowFunctionExpression'),
	);
}

{
	const info = take(decomposeSimple('BlockStatement > :first-child'));
	const root = wire({ type: 'BlockStatement', body: [{ type: 'A' }, { type: 'B' }] });
	check('BlockStatement > :first-child fires on body[0]', info.filter!(root.body[0]));
	check('BlockStatement > :first-child rejects body[1]', !info.filter!(root.body[1]));
}

// --- :scope binding inside :has -----------------------------------

{
	const info = take(decomposeSimple('Foo:has(:scope > Bar)'));
	check('Foo:has(:scope > Bar) types {Foo}', info.types !== 'all' && info.types.has('Foo'));
	// Fires when Bar is a DIRECT child of the Foo (the :scope).
	const direct = wire({ type: 'Foo', body: { type: 'Bar' } });
	check(':has(:scope > Bar) accepts direct Bar child', info.filter!(direct));
	// Does NOT fire when Bar is only a transitive descendant.
	const transitive = wire({ type: 'Foo', body: { type: 'Wrapper', body: { type: 'Bar' } } });
	check(':has(:scope > Bar) rejects deeply-nested Bar', !info.filter!(transitive));
}

{
	// `:has(:scope X)` (descendant inside :has) — Bar must be a
	// descendant of the scope (any depth).
	const info = take(decomposeSimple('Foo:has(:scope Bar)'));
	const direct = wire({ type: 'Foo', body: { type: 'Bar' } });
	const deep = wire({ type: 'Foo', body: { type: 'X', body: { type: 'Y', body: { type: 'Bar' } } } });
	check(':has(:scope Bar) accepts direct descendant', info.filter!(direct));
	check(':has(:scope Bar) accepts deep descendant', info.filter!(deep));
}

// --- Wildcard descendant / sibling -----------------------------------

{
	const info = take(decomposeSimple('Foo *'));
	check('Foo * types is all', info.types === 'all');
	const ok = wire({ type: 'Foo', body: { type: 'Bar', body: { type: 'Baz' } } });
	check('Foo * fires on any descendant', info.filter!(ok.body) && info.filter!(ok.body.body));
	const bare = wire({ type: 'Other' });
	check('Foo * rejects bare node with no Foo ancestor', !info.filter!(bare));
}

{
	const info = take(decomposeSimple('A ~ *'));
	const root = wire({
		type: 'BlockStatement',
		body: [{ type: 'A' }, { type: 'B' }, { type: 'C' }],
	});
	check('A ~ * fires on later siblings', info.filter!(root.body[1]) && info.filter!(root.body[2]));
	check('A ~ * rejects A itself (no earlier A)', !info.filter!(root.body[0]));
}

// --- Numeric attribute comparisons -----------------------------------

{
	const info = take(decomposeSimple('Foo[arity<3]'));
	check('attr <  3 matches arity 2', info.filter!({ type: 'Foo', arity: 2 }));
	check('attr <  3 rejects arity 3', !info.filter!({ type: 'Foo', arity: 3 }));
}

{
	const info = take(decomposeSimple('Foo[arity<=3]'));
	check('attr <= 3 matches arity 3', info.filter!({ type: 'Foo', arity: 3 }));
	check('attr <= 3 rejects arity 4', !info.filter!({ type: 'Foo', arity: 4 }));
}

{
	const info = take(decomposeSimple('Foo[arity>3]'));
	check('attr >  3 matches arity 4', info.filter!({ type: 'Foo', arity: 4 }));
	check('attr >  3 rejects arity 3', !info.filter!({ type: 'Foo', arity: 3 }));
}

{
	const info = take(decomposeSimple('Foo[arity>=3]'));
	check('attr >= 3 matches arity 3', info.filter!({ type: 'Foo', arity: 3 }));
	check('attr >= 3 rejects arity 2', !info.filter!({ type: 'Foo', arity: 2 }));
}

// --- typeof attribute ------------------------------------------------

{
	const info = take(decomposeSimple('Foo[bar=type(string)]'));
	check('typeof = string matches', info.filter!({ type: 'Foo', bar: 'hi' }));
	check('typeof = string rejects number', !info.filter!({ type: 'Foo', bar: 42 }));
}

{
	const info = take(decomposeSimple('Foo[bar!=type(undefined)]'));
	check('typeof != undefined matches set value', info.filter!({ type: 'Foo', bar: 1 }));
	check('typeof != undefined rejects missing value', !info.filter!({ type: 'Foo' }));
}

// --- Negated regex ---------------------------------------------------

{
	const info = take(decomposeSimple('Foo[name!=/Sync$/]'));
	check('name !~ /Sync$/ rejects "fooSync"', !info.filter!({ type: 'Foo', name: 'fooSync' }));
	check('name !~ /Sync$/ accepts "foo"', info.filter!({ type: 'Foo', name: 'foo' }));
}

// --- Field selector inside compound (B.field) ------------------------

{
	const info = take(decomposeSimple('Foo Identifier.label'));
	const root = wire({
		type: 'Foo',
		body: { type: 'Bar', label: { type: 'Identifier', name: 'lbl' }, value: { type: 'Identifier', name: 'v' } },
	});
	const labelId = root.body.label;
	const valueId = root.body.value;
	check('descendant + Identifier.label fires on label slot', info.filter!(labelId));
	check('descendant + Identifier.label rejects value slot', !info.filter!(valueId));
}

// --- Multi-level child chain with compound + field on the right ------
//
// `A > B.f1 > C[attr].f2` — left side is itself a `child` selector, not
// a leaf type matcher. The fast fieldFire path requires a finite parent
// type set (so it can trigger on Parent and extract `parent[field]`),
// which a chain doesn't give. Slow path: trigger on Right's compound
// type and add the field constraint + parent-chain match as filters.
//
// Real-world repro: rules registering selectors like
// `CallExpression > MemberExpression.callee > Identifier[name="join"].property`
// (e.g. prefer-string-replace-all-style guidance).
{
	const info = take(decomposeSimple(
		'CallExpression > MemberExpression.callee > Identifier[name="join"].property',
	));
	check('chain+field: trigger types {Identifier}', info.types !== 'all' && info.types.has('Identifier'));
	const tree = wire({
		type: 'CallExpression',
		callee: {
			type: 'MemberExpression',
			object: { type: 'Identifier', name: 'arr' },
			property: { type: 'Identifier', name: 'join' },
		},
		arguments: [],
	});
	const joinId = tree.callee.property;
	const objectId = tree.callee.object;
	check('chain+field: fires on the property Identifier(name=join)', info.filter!(joinId));
	check('chain+field: rejects the object Identifier(name=arr)', !info.filter!(objectId));
	// Wrong attribute value — same shape, different name.
	const tree2 = wire({
		type: 'CallExpression',
		callee: {
			type: 'MemberExpression',
			object: { type: 'Identifier', name: 'arr' },
			property: { type: 'Identifier', name: 'concat' },
		},
		arguments: [],
	});
	check('chain+field: rejects property name=concat', !info.filter!(tree2.callee.property));
	// Right-shaped Identifier(name=join) but parent isn't a CallExpression's MemberExpression.callee.
	const tree3 = wire({
		type: 'BinaryExpression',
		left: {
			type: 'MemberExpression',
			object: { type: 'Identifier', name: 'arr' },
			property: { type: 'Identifier', name: 'join' },
		},
		right: { type: 'Literal', value: 1 },
	});
	check('chain+field: rejects Identifier(name=join) in non-CallExpression chain', !info.filter!(tree3.left.property));
}

// --- Standalone .field / standalone [attr] ---------------------------

{
	const info = take(decomposeSimple('.label'));
	check('standalone .label is all-types', info.types === 'all');
	const root = wire({ type: 'Foo', label: { type: 'Identifier' }, value: { type: 'Other' } });
	check('.label fires on parent.label', info.filter!(root.label));
	check('.label rejects parent.value', !info.filter!(root.value));
}

{
	const info = take(decomposeSimple('[deprecated]'));
	check('standalone [attr] truthy-existence', info.filter!({ type: 'X', deprecated: true }));
	check('standalone [attr] rejects falsy', !info.filter!({ type: 'X', deprecated: false }));
}

// --- :matches with per-branch filters --------------------------------

{
	// Top-level `:matches(A[x=1], B[y=2])` expands per-branch (so each
	// branch's filter is scoped to its own type entry).
	const infos = decomposeSimple(':matches(A[x=1], B[y=2])');
	check(':matches expands to 2 entries', infos.length === 2);
	const aInfo = infos.find(i => i.types !== 'all' && i.types.has('A'))!;
	const bInfo = infos.find(i => i.types !== 'all' && i.types.has('B'))!;
	check('branch A filter accepts {A,x=1}', aInfo.filter!({ type: 'A', x: 1 }));
	check('branch A filter rejects {A,x=2}', !aInfo.filter!({ type: 'A', x: 2 }));
	check('branch B filter accepts {B,y=2}', bInfo.filter!({ type: 'B', y: 2 }));
}

{
	// Nested `Foo:matches(A.field, B.field2)` — outer compound carries
	// the trigger type {Foo}; matches inside is filter-only-ish (per
	// branch contributes types {A}/{B}, but Foo's identifier wins so
	// the matches collapses through the compound branch). Verify the
	// filter executes per-branch.
	const infos = decomposeSimple(':matches(A:not(B), C)');
	check(':matches A:not(B), C expands per-branch', infos.length === 2);
	const aInfo = infos.find(i => i.types !== 'all' && i.types.has('A'))!;
	check('A:not(B) filter rejects when type is B (impossible) — accepts type A', aInfo.filter!({ type: 'A' }));
}

// --- UnsupportedSelectorError + parse error throws -------------------

{
	let threw = false;
	let isUnsupported = false;
	try {
		decomposeSimple('(');
	}
	catch (e: any) {
		threw = true;
		isUnsupported = e instanceof UnsupportedSelectorError;
	}
	check('invalid esquery throws', threw);
	check('invalid esquery throws plain Error (not UnsupportedSelectorError)', !isUnsupported);
}

{
	// Force a structurally-impossible-to-decompose selector. Most well-
	// formed shapes now succeed; deliberately construct an unhandled
	// AST by feeding a class macro we don't recognise.
	let threw = false;
	let isUnsupported = false;
	try {
		decomposeSimple(':bogus-class-macro');
	}
	catch (e: any) {
		threw = true;
		isUnsupported = e instanceof UnsupportedSelectorError;
	}
	check('unknown class macro throws UnsupportedSelectorError', threw && isUnsupported);
}

// --- JSX selectors used by real plugin rules -------------------------
//
// Patterns lifted from eslint-plugin-react / eslint-plugin-react-x /
// eslint-plugin-jsx-a11y. These are the JSX selector shapes rule
// listeners actually register; if `decomposeSimple` can't handle them,
// fast dispatch falls over for any JSX-aware rule.

{
	const info = take(decomposeSimple('JSXElement'));
	check('JSX: JSXElement type set', info.types !== 'all' && info.types.has('JSXElement') && info.types.size === 1);
}
{
	const info = take(decomposeSimple('JSXFragment'));
	check('JSX: JSXFragment type set', info.types !== 'all' && info.types.has('JSXFragment'));
}
{
	const info = take(decomposeSimple('JSXOpeningElement'));
	check('JSX: JSXOpeningElement type set', info.types !== 'all' && info.types.has('JSXOpeningElement'));
}
{
	// react-x / react-jsx-no-leaked-conditional-rendering
	const info = take(decomposeSimple('JSXExpressionContainer'));
	check(
		'JSX: JSXExpressionContainer type set',
		info.types !== 'all' && info.types.has('JSXExpressionContainer'),
	);
}
{
	// jsx-a11y/anchor-has-content style — `JSXOpeningElement[name.name="a"]`
	const info = take(decomposeSimple('JSXOpeningElement[name.name="div"]'));
	check('JSX: opening-with-name-path attribute filter exists', !!info.filter);
	check(
		'JSX: opening-with-name-path matches name=div',
		info.filter!({ type: 'JSXOpeningElement', name: { type: 'JSXIdentifier', name: 'div' } }),
	);
	check(
		'JSX: opening-with-name-path rejects name=span',
		!info.filter!({ type: 'JSXOpeningElement', name: { type: 'JSXIdentifier', name: 'span' } }),
	);
}
{
	// react/jsx-no-target-blank — `JSXAttribute[name.name="href"]`
	const info = take(decomposeSimple('JSXAttribute[name.name="href"]'));
	check(
		'JSX: attribute-name filter matches href',
		info.filter!({ type: 'JSXAttribute', name: { type: 'JSXIdentifier', name: 'href' } }),
	);
	check(
		'JSX: attribute-name filter rejects id',
		!info.filter!({ type: 'JSXAttribute', name: { type: 'JSXIdentifier', name: 'id' } }),
	);
}
{
	// `JSXSpreadAttribute` — registered by react/jsx-props-no-spreading and
	// jsx-a11y/no-redundant-roles to detect `<Foo {...rest} />`.
	const info = take(decomposeSimple('JSXSpreadAttribute'));
	check('JSX: JSXSpreadAttribute type set', info.types !== 'all' && info.types.has('JSXSpreadAttribute'));
}
{
	// Combinator: `JSXOpeningElement > JSXAttribute` — descendant of opening.
	const info = take(decomposeSimple('JSXOpeningElement > JSXAttribute'));
	check('JSX: combinator trigger is JSXAttribute', info.types !== 'all' && info.types.has('JSXAttribute'));
	const tree = wire({
		type: 'JSXOpeningElement',
		name: { type: 'JSXIdentifier', name: 'div' },
		attributes: [{ type: 'JSXAttribute', name: { type: 'JSXIdentifier', name: 'id' } }],
	});
	const attr = tree.attributes[0];
	check('JSX: combinator fires when parent is JSXOpeningElement', info.filter!(attr));
	const attrUnderOther = wire({
		type: 'JSXClosingElement',
		attributes: [{ type: 'JSXAttribute', name: { type: 'JSXIdentifier', name: 'id' } }],
	}).attributes[0];
	check('JSX: combinator rejects under JSXClosingElement', !info.filter!(attrUnderOther));
}
{
	// Field-fire: `JSXOpeningElement > .name` — fires on the name slot.
	// Used by rules that want to inspect the opening element's name as a
	// Member/Identifier without listening on JSXIdentifier separately.
	const info = take(decomposeSimple('JSXOpeningElement > .name'));
	check('JSX: field-fire fires on JSXOpeningElement type', info.types !== 'all' && info.types.has('JSXOpeningElement'));
	check('JSX: field-fire is name', info.fieldFire === 'name');
}
{
	// :matches() expansion across JSX selector list — same pattern as the
	// non-JSX version but with JSX type names.
	const infos = decomposeSimple('JSXElement, JSXFragment');
	check('JSX: matches list yields 2 entries', infos !== null && infos.length === 2);
	check(
		'JSX: matches list types',
		infos !== null && infos[0].types !== 'all' && infos[0].types.has('JSXElement')
			&& infos[1].types !== 'all' && infos[1].types.has('JSXFragment'),
	);
}

console.log();
if (failures.length) {
	console.log('FAILURES:');
	for (const f of failures) console.log('  ' + f);
	process.exit(1);
}
console.log('All selector-analysis tests passed');
