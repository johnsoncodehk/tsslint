// Trigger-set extraction tests for lib/selector-analysis.ts.
// Run via: node --experimental-strip-types --no-warnings packages/compat-eslint/test/selector-analysis.test.ts

const { buildTriggerSet, isCodePathListener } = require('../lib/selector-analysis.js') as typeof import('../lib/selector-analysis.js');

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

console.log();
if (failures.length) {
	console.log('FAILURES:');
	for (const f of failures) console.log('  ' + f);
	process.exit(1);
}
console.log('All selector-analysis tests passed');
