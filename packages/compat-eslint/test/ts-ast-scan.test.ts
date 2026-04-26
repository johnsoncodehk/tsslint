// TS-AST scan tests for lib/ts-ast-scan.ts.
// Run via:
//   node --experimental-strip-types --no-warnings packages/compat-eslint/test/ts-ast-scan.test.ts

import * as ts from 'typescript';

const lazy = require('../lib/lazy-estree.js') as typeof import('../lib/lazy-estree.js');
const { predicateForTriggerSet, hasPredicate, tsScanTraverse } = require('../lib/ts-ast-scan.js') as typeof import('../lib/ts-ast-scan.js');

const failures: string[] = [];
function check(name: string, cond: boolean, detail?: string) {
	if (cond) {
		process.stdout.write('.');
	} else {
		failures.push(name + (detail ? ' — ' + detail : ''));
		process.stdout.write('F');
	}
}

function parseTs(code: string): ts.SourceFile {
	return ts.createSourceFile('/test.ts', code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}

function scan(code: string, types: string[]): { entered: string[]; left: string[] } {
	const sf = parseTs(code);
	const { context } = lazy.convertLazy(sf);
	const pred = predicateForTriggerSet(types);
	if (!pred) throw new Error('no predicate for ' + types.join(','));
	const steps = tsScanTraverse(sf, pred, n => lazy.materialize(n, context as any));
	const entered: string[] = [];
	const left: string[] = [];
	for (const step of steps as any[]) {
		if (step.phase === 1) entered.push(step.target.type);
		else left.push(step.target.type);
	}
	return { entered, left };
}

// --- Predicate availability ------------------------------------------

check('hasPredicate: TSAsExpression', hasPredicate('TSAsExpression'));
check('hasPredicate: ImportDeclaration', hasPredicate('ImportDeclaration'));
check('hasPredicate: BinaryExpression', hasPredicate('BinaryExpression'));
check('hasPredicate: Identifier', hasPredicate('Identifier'));
check('hasPredicate: not real type returns false', !hasPredicate('NotARealType'));
// Object/Array literals/patterns intentionally not in v1 — they need
// ancestor context to distinguish literal vs pattern.
check('hasPredicate: ObjectExpression skipped in v1', !hasPredicate('ObjectExpression'));

// --- predicateForTriggerSet ------------------------------------------

{
	const p = predicateForTriggerSet(['TSAsExpression']);
	check('predicateForTriggerSet: returns predicate', p !== null);
}
{
	const p = predicateForTriggerSet(['TSAsExpression', 'NotARealType']);
	check('predicateForTriggerSet: null when missing', p === null);
}

// --- Self-lint trigger set ------------------------------------------

{
	const { entered } = scan(
		`
			import { foo } from './bar';
			let x: number = 1;
			interface I { name: string; }
			function f(x: number): number { return x as number; }
			const y = z!;
			const z = <T>x;
		`,
		['Program', 'ImportDeclaration', 'TSAsExpression', 'TSTypeAssertion', 'TSNonNullExpression'],
	);
	check('self-lint: visits Program', entered.includes('Program'));
	check('self-lint: visits ImportDeclaration', entered.includes('ImportDeclaration'));
	check('self-lint: visits TSAsExpression', entered.includes('TSAsExpression'));
	check('self-lint: visits TSNonNullExpression', entered.includes('TSNonNullExpression'));
	check('self-lint: does NOT visit Identifier', !entered.includes('Identifier'));
	check('self-lint: does NOT visit BlockStatement', !entered.includes('BlockStatement'));
	check('self-lint: does NOT visit TSNumberKeyword', !entered.includes('TSNumberKeyword'));
}

// --- Pre-order ordering --------------------------------------------

{
	// Two consecutive imports should appear in source order.
	const { entered } = scan(
		`import a from 'a'; import b from 'b'; import c from 'c';`,
		['ImportDeclaration'],
	);
	check('order: 3 imports captured', entered.filter(t => t === 'ImportDeclaration').length === 3);
	check('order: only ImportDeclarations entered (no Program in trigger set)',
		entered.every(t => t === 'ImportDeclaration'));
}

{
	// With Program in trigger set, Program is FIRST (root visit) and LAST
	// (its leave step).
	const { entered, left } = scan(
		`import a from 'a';`,
		['Program', 'ImportDeclaration'],
	);
	check('order: Program is first enter', entered[0] === 'Program');
	check('order: ImportDeclaration after Program', entered[1] === 'ImportDeclaration');
	check('order: Program is last leave', left[left.length - 1] === 'Program');
	check('order: ImportDeclaration leaves before Program', left[0] === 'ImportDeclaration');
}

// --- Operator-aware predicates -------------------------------------

{
	// `a + b` is BinaryExpression. `a && b` is LogicalExpression. `a = b` is AssignmentExpression.
	const code = `function f() { let r; r = a + b; r = a && b; }`;

	const bin = scan(code, ['BinaryExpression']);
	check('binary +: visited BinaryExpression', bin.entered.includes('BinaryExpression'));
	// Logical && shouldn't appear under BinaryExpression predicate.
	check('binary +: BinaryExpression count = 1', bin.entered.filter(t => t === 'BinaryExpression').length === 1);

	const log = scan(code, ['LogicalExpression']);
	check('logical &&: visited LogicalExpression', log.entered.includes('LogicalExpression'));

	const assign = scan(code, ['AssignmentExpression']);
	check('assign: visited AssignmentExpression', assign.entered.includes('AssignmentExpression'));
}

// --- Function decl vs declare function ----------------------------

{
	// FunctionDeclaration predicate requires a body — declare function (no body)
	// should NOT match. (It would materialise as TSDeclareFunction.)
	const code = `declare function foo(): void; function bar() {}`;
	const { entered } = scan(code, ['FunctionDeclaration']);
	check('FunctionDeclaration: visits bar (has body)', entered.includes('FunctionDeclaration'));
	check('FunctionDeclaration: visits exactly 1 (skips declare)',
		entered.filter(t => t === 'FunctionDeclaration').length === 1);
}

// --- Materialised ESTree nodes have correct .type ------------------

{
	const code = `let v = (x as Foo);`;
	const sf = parseTs(code);
	const { context } = lazy.convertLazy(sf);
	const pred = predicateForTriggerSet(['TSAsExpression'])!;
	const steps = tsScanTraverse(sf, pred, n => lazy.materialize(n, context as any));
	check('materialised: 1 enter step', (steps as any[]).filter(s => s.phase === 1).length === 1);
	const target = (steps as any[])[0].target;
	check('materialised: target.type === TSAsExpression', target.type === 'TSAsExpression');
	check('materialised: target.expression accessible', !!target.expression);
	check('materialised: target.typeAnnotation accessible', !!target.typeAnnotation);
}

console.log();
if (failures.length) {
	console.log('FAILURES:');
	for (const f of failures) console.log('  ' + f);
	process.exit(1);
}
console.log('All ts-ast-scan tests passed');
