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
	const steps = tsScanTraverse(sf, pred, context);
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
check('hasPredicate: ObjectExpression', hasPredicate('ObjectExpression'));
check('hasPredicate: ArrayPattern', hasPredicate('ArrayPattern'));
check('hasPredicate: AccessorProperty', hasPredicate('AccessorProperty'));
check('hasPredicate: Decorator', hasPredicate('Decorator'));

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
	const steps = tsScanTraverse(sf, pred, context);
	check('materialised: 1 enter step', (steps as any[]).filter(s => s.phase === 1).length === 1);
	const target = (steps as any[])[0].target;
	check('materialised: target.type === TSAsExpression', target.type === 'TSAsExpression');
	check('materialised: target.expression accessible', !!target.expression);
	check('materialised: target.typeAnnotation accessible', !!target.typeAnnotation);
}

// --- Soundness: export wrappers must dispatch BOTH wrapper and inner --
// `export function foo() {}` materialises as ExportNamedWrappingNode whose
// `.declaration` is the FunctionDeclarationNode. ESLint's full walk fires
// enter for both nodes; rules that only listen for FunctionDeclaration
// (the most common case) MUST still receive the event for an exported one.

{
	const types = scan(`export function foo() {}`, ['FunctionDeclaration']).entered;
	check('export wrapper: FunctionDeclaration listener fires for `export function`',
		types.includes('FunctionDeclaration'),
		`got: [${types.join(', ')}]`);
}
{
	const types = scan(`export const x = 1;`, ['VariableDeclaration']).entered;
	check('export wrapper: VariableDeclaration listener fires for `export const`',
		types.includes('VariableDeclaration'),
		`got: [${types.join(', ')}]`);
}
{
	const types = scan(`export class C {}`, ['ClassDeclaration']).entered;
	check('export wrapper: ClassDeclaration listener fires for `export class`',
		types.includes('ClassDeclaration'),
		`got: [${types.join(', ')}]`);
}
{
	const types = scan(`export interface I {}`, ['TSInterfaceDeclaration']).entered;
	check('export wrapper: TSInterfaceDeclaration listener fires for `export interface`',
		types.includes('TSInterfaceDeclaration'),
		`got: [${types.join(', ')}]`);
}
{
	const types = scan(`export type T = number;`, ['TSTypeAliasDeclaration']).entered;
	check('export wrapper: TSTypeAliasDeclaration listener fires for `export type`',
		types.includes('TSTypeAliasDeclaration'),
		`got: [${types.join(', ')}]`);
}

// --- Soundness: ChainExpression must dispatch inner MemberExpression / CallExpression --
// `a?.b` materialises as ChainExpression{expression: MemberExpression{optional:true}}.
// Rule listening for MemberExpression should still receive the event.

{
	const types = scan(`let x = a?.b;`, ['MemberExpression']).entered;
	check('chain: MemberExpression listener fires inside `a?.b`',
		types.includes('MemberExpression'),
		`got: [${types.join(', ')}]`);
}
{
	const types = scan(`let x = a?.b();`, ['CallExpression']).entered;
	check('chain: CallExpression listener fires inside `a?.b()`',
		types.includes('CallExpression'),
		`got: [${types.join(', ')}]`);
}
{
	// Nested chain: outer ChainExpression wraps a CallExpression whose
	// callee is a MemberExpression. Both inner nodes need to dispatch.
	const types = scan(`let x = a?.b();`, ['MemberExpression', 'CallExpression']).entered;
	check('chain: nested — both MemberExpression and CallExpression fire',
		types.includes('MemberExpression') && types.includes('CallExpression'),
		`got: [${types.join(', ')}]`);
}

// --- Soundness: UnaryExpression covers typeof / delete / void --------
// In TS AST these are SK.TypeOfExpression / SK.DeleteExpression /
// SK.VoidExpression — separate kinds from PrefixUnaryExpression — but
// typescript-estree converts all four to ESTree UnaryExpression.

{
	const types = scan(`let r = typeof x;`, ['UnaryExpression']).entered;
	check('unary: typeof fires UnaryExpression',
		types.includes('UnaryExpression'),
		`got: [${types.join(', ')}]`);
}
{
	const types = scan(`delete x.y;`, ['UnaryExpression']).entered;
	check('unary: delete fires UnaryExpression',
		types.includes('UnaryExpression'),
		`got: [${types.join(', ')}]`);
}
{
	const types = scan(`void x;`, ['UnaryExpression']).entered;
	check('unary: void fires UnaryExpression',
		types.includes('UnaryExpression'),
		`got: [${types.join(', ')}]`);
}

// --- Soundness: ImportDefaultSpecifier only for default-style imports -

{
	// Default + named: should fire ImportDefaultSpecifier
	const types = scan(`import a from 'x';`, ['ImportDefaultSpecifier']).entered;
	check('import-default: `import a from "x"` fires ImportDefaultSpecifier',
		types.includes('ImportDefaultSpecifier'),
		`got: [${types.join(', ')}]`);
}
{
	// Named-only: ImportClause exists but has no `name` — must NOT fire
	// ImportDefaultSpecifier (typescript-estree wouldn't emit one).
	const types = scan(`import { a } from 'x';`, ['ImportDefaultSpecifier']).entered;
	check('import-default: `import { a } from "x"` does NOT fire ImportDefaultSpecifier',
		!types.includes('ImportDefaultSpecifier'),
		`got: [${types.join(', ')}]`);
}
{
	// Bare side-effect: same — no default specifier
	const types = scan(`import 'x';`, ['ImportDefaultSpecifier']).entered;
	check('import-default: `import "x"` does NOT fire ImportDefaultSpecifier',
		!types.includes('ImportDefaultSpecifier'),
		`got: [${types.join(', ')}]`);
}

// --- Predicate context filters (must mirror lazy-estree dispatch) ----

{
	// MethodDefinition predicate excludes methods inside object literals
	// (those materialise as Property{method:true}, not MethodDefinition).
	const types = scan(
		`class C { foo() {} } const o = { bar() {} };`,
		['MethodDefinition'],
	).entered;
	const count = types.filter(t => t === 'MethodDefinition').length;
	check('MethodDefinition: fires for class methods only (not object literal methods)',
		count === 1,
		`got count=${count}, types=[${types.join(', ')}]`);
}

{
	// PropertyDefinition predicate now excludes accessor and abstract
	// fields — they have their own ESTree types and predicates. The
	// listener on PropertyDefinition only fires on plain class fields.
	const code = `class C { accessor a = 1; abstract b: number; foo = 2; }`;
	const types = scan(code, ['PropertyDefinition']).entered;
	check('PropertyDefinition: only fires on plain class fields',
		types.length === 1 && types[0] === 'PropertyDefinition',
		`got: [${types.join(', ')}]`);
}

{
	// `declare function foo()` (no body) is TSDeclareFunction, not
	// FunctionDeclaration.
	const code = `declare function foo(): void;`;
	const sf = parseTs(code);
	const { context } = lazy.convertLazy(sf);
	const pred = predicateForTriggerSet(['FunctionDeclaration']);
	if (pred) {
		const steps = tsScanTraverse(sf, pred, context);
		check('TSDeclareFunction: predicate skips body-less function declarations',
			(steps as any[]).filter(s => s.phase === 1).length === 0);
	}
}

{
	// Unknown ESTree types still force fallback.
	const fallback = predicateForTriggerSet(['NotARealType']);
	check('predicateForTriggerSet: unknown type returns null',
		fallback === null);
}

// --- Array / Object — context-sensitive (literal vs pattern) ---------

{
	// Plain array/object literal in expression position.
	const code = `let a = [1, 2]; let b = { x: 1 };`;
	const types = scan(code, ['ArrayExpression', 'ObjectExpression']).entered;
	check('ArrayExpression: fires for literal array', types.includes('ArrayExpression'));
	check('ObjectExpression: fires for literal object', types.includes('ObjectExpression'));
}

{
	// Array/object NOT in pattern position must NOT trip pattern listeners.
	const code = `let a = [1, 2]; let b = { x: 1 };`;
	const types = scan(code, ['ArrayPattern', 'ObjectPattern']).entered;
	check('ArrayPattern: NOT fired for literal in expression position',
		!types.includes('ArrayPattern'));
	check('ObjectPattern: NOT fired for literal in expression position',
		!types.includes('ObjectPattern'));
}

{
	// BindingPattern always fires pattern listener.
	const code = `function f([a, b]: number[], { x }: { x: number }) {}`;
	const types = scan(code, ['ArrayPattern', 'ObjectPattern']).entered;
	check('ArrayPattern: fires for ArrayBindingPattern in param',
		types.includes('ArrayPattern'));
	check('ObjectPattern: fires for ObjectBindingPattern in param',
		types.includes('ObjectPattern'));
}

{
	// Array/object literal in destructuring assignment LHS → pattern.
	const code = `let r; [r] = [1]; ({ r } = { r: 1 });`;
	const types = scan(code, ['ArrayPattern', 'ObjectPattern']).entered;
	check('ArrayPattern: fires for ArrayLiteral on assignment LHS',
		types.includes('ArrayPattern'));
	check('ObjectPattern: fires for ObjectLiteral on assignment LHS',
		types.includes('ObjectPattern'));
}

{
	// for-of LHS → pattern.
	const code = `for ([a, b] of items) {}`;
	const types = scan(code, ['ArrayPattern', 'ArrayExpression']).entered;
	check('for-of LHS: ArrayPattern fires', types.includes('ArrayPattern'));
	check('for-of LHS: ArrayExpression does NOT fire', !types.includes('ArrayExpression'));
}

{
	// Nested destructure: outer + inner literals are both pattern.
	const code = `[[a], [b]] = [[1], [2]];`;
	const types = scan(code, ['ArrayPattern', 'ArrayExpression']).entered;
	const patterns = types.filter(t => t === 'ArrayPattern').length;
	const exprs = types.filter(t => t === 'ArrayExpression').length;
	// LHS: 1 outer + 2 inner ArrayPattern. RHS: 1 outer + 2 inner ArrayExpression.
	check('Nested: 3 ArrayPattern (LHS) + 3 ArrayExpression (RHS)',
		patterns === 3 && exprs === 3,
		`got patterns=${patterns}, exprs=${exprs}`);
}

// --- Property predicate (5 sources) ----------------------------------

{
	// Object literal: PropertyAssignment + ShorthandPropertyAssignment + method.
	const code = `let r = 1; let o = { a: 1, r, foo() {}, get g() { return 1; } };`;
	const types = scan(code, ['Property']).entered;
	const count = types.filter(t => t === 'Property').length;
	// 4 properties: a:1 (PropertyAssignment), r (Shorthand), foo() (method), g (getter).
	check('Property: fires for all 4 object-literal property forms',
		count === 4, `got count=${count}, types=[${types.join(', ')}]`);
}

{
	// Object binding pattern: BindingElement → Property{shorthand:true}.
	const code = `function f({ a, b }) {}`;
	const types = scan(code, ['Property']).entered;
	const count = types.filter(t => t === 'Property').length;
	check('Property: fires for object-binding-pattern elements',
		count === 2, `got count=${count}`);
}

{
	// MethodDefinition for class method, NOT for object-literal method.
	const code = `class C { foo() {} } let o = { bar() {} };`;
	const types = scan(code, ['MethodDefinition', 'Property']).entered;
	const m = types.filter(t => t === 'MethodDefinition').length;
	const p = types.filter(t => t === 'Property').length;
	check('MethodDefinition vs Property: split correctly',
		m === 1 && p === 1, `got M=${m}, P=${p}`);
}

// --- AssignmentPattern (parameter default + array binding default) ---

{
	// Parameter with default value.
	const code = `function f(x = 1, y: string = 'a') {}`;
	const types = scan(code, ['AssignmentPattern']).entered;
	const count = types.filter(t => t === 'AssignmentPattern').length;
	check('AssignmentPattern: fires for parameter defaults',
		count === 2, `got count=${count}`);
}

{
	// Array binding pattern with default: `[a = 1] = expr` (BindingElement
	// path) — not the same as `function f([a = 1])` because that's also
	// BindingElement.
	const code = `function f([a = 1, b = 2]) {}`;
	const types = scan(code, ['AssignmentPattern']).entered;
	const count = types.filter(t => t === 'AssignmentPattern').length;
	check('AssignmentPattern: fires for array-binding defaults',
		count === 2, `got count=${count}`);
}

// --- RestElement (4 sources) -----------------------------------------

{
	// Rest parameter.
	const code = `function f(...args: number[]) {}`;
	const types = scan(code, ['RestElement']).entered;
	check('RestElement: fires for rest parameter', types.includes('RestElement'));
}

{
	// Array binding rest.
	const code = `function f([a, ...rest]: number[]) {}`;
	const types = scan(code, ['RestElement']).entered;
	check('RestElement: fires for array-binding rest', types.includes('RestElement'));
}

{
	// Object binding rest.
	const code = `function f({ a, ...rest }: { a: number; b: number }) {}`;
	const types = scan(code, ['RestElement']).entered;
	check('RestElement: fires for object-binding rest', types.includes('RestElement'));
}

{
	// Spread in pattern position (destructuring assignment with rest).
	const code = `let r; [r, ...rest] = [1, 2, 3];`;
	const types = scan(code, ['RestElement']).entered;
	check('RestElement: fires for ...rest in array destructure',
		types.includes('RestElement'));
}

{
	// SpreadElement (NOT pattern): function call args, array literal spread.
	const code = `f(...args); let a = [...items];`;
	const types = scan(code, ['SpreadElement', 'RestElement']).entered;
	const s = types.filter(t => t === 'SpreadElement').length;
	const r = types.filter(t => t === 'RestElement').length;
	check('SpreadElement vs RestElement: split correctly',
		s === 2 && r === 0, `got S=${s}, R=${r}`);
}

// --- AssignmentExpression — `=` outside pattern position only -------

{
	const code = `let r; r = 1; r += 2;`;
	const types = scan(code, ['AssignmentExpression']).entered;
	const count = types.filter(t => t === 'AssignmentExpression').length;
	check('AssignmentExpression: fires for plain `=` and `+=`',
		count === 2, `got count=${count}`);
}

{
	// `[a] = expr` — AssignmentExpression at the top, ArrayPattern as LHS.
	// The outer `=` is still AssignmentExpression (not AssignmentPattern).
	const code = `let a; [a] = [1];`;
	const types = scan(code, ['AssignmentExpression', 'AssignmentPattern']).entered;
	check('AssignmentExpression: outer destructure `=` is still AssignmentExpression',
		types.includes('AssignmentExpression'));
}

// --- AccessorProperty / TSAbstractPropertyDefinition / TSAbstractAccessorProperty -

{
	const code = `abstract class C {
		foo = 1;
		accessor bar = 2;
		abstract baz: number;
		abstract accessor qux: number;
	}`;
	const types = scan(code, [
		'PropertyDefinition',
		'AccessorProperty',
		'TSAbstractPropertyDefinition',
		'TSAbstractAccessorProperty',
	]).entered;
	check('PropertyDefinition: fires for plain field only',
		types.filter(t => t === 'PropertyDefinition').length === 1,
		`PropertyDefinition count: ${types.filter(t => t === 'PropertyDefinition').length}`);
	check('AccessorProperty: fires for accessor field',
		types.includes('AccessorProperty'));
	check('TSAbstractPropertyDefinition: fires for abstract field',
		types.includes('TSAbstractPropertyDefinition'));
	check('TSAbstractAccessorProperty: fires for abstract accessor',
		types.includes('TSAbstractAccessorProperty'));
}

// --- Decorator -------------------------------------------------------

{
	const code = `
		function dec(t: any) {}
		@dec class C {
			@dec foo: number = 1;
			@dec bar() {}
			method(@dec p: number) {}
		}
	`;
	const types = scan(code, ['Decorator']).entered;
	const count = types.filter(t => t === 'Decorator').length;
	check('Decorator: fires for class / property / method / parameter decorators',
		count === 4, `got count=${count}`);
}

// --- TSParameterProperty + wrapper unwrap ----------------------------

{
	// `constructor(public x: number)` wraps the parameter in
	// TSParameterProperty. The wrapper's `.parameter` is the inner
	// Identifier — listeners on TSParameterProperty AND the inner type
	// must both fire (covered by unwrapChain).
	const code = `class C { constructor(public x: number, private y = 1) {} }`;
	const types = scan(code, ['TSParameterProperty', 'AssignmentPattern']).entered;
	check('TSParameterProperty: fires for `public x`',
		types.includes('TSParameterProperty'));
	// `private y = 1` materialises as TSParameterProperty wrapping
	// AssignmentPattern. unwrapChain dispatches both.
	check('TSParameterProperty wrapper: inner AssignmentPattern fires too',
		types.includes('AssignmentPattern'));
}

// --- ExportNamedDeclaration / ExportDefaultDeclaration / ExportAllDeclaration -

{
	// `export { a }` — SK.ExportDeclaration with NamedExports clause.
	const code = `const a = 1; export { a };`;
	const types = scan(code, ['ExportNamedDeclaration']).entered;
	check('ExportNamedDeclaration: fires for `export { a }`',
		types.includes('ExportNamedDeclaration'));
}

{
	// `export function foo() {}` — fixExports wrapper.
	const code = `export function foo() {}`;
	const types = scan(code, ['ExportNamedDeclaration']).entered;
	check('ExportNamedDeclaration: fires for `export function`',
		types.includes('ExportNamedDeclaration'));
}

{
	// `export * from 'x'` — ExportAllDeclaration.
	const code = `export * from 'x';`;
	const types = scan(code, ['ExportAllDeclaration', 'ExportNamedDeclaration']).entered;
	check('ExportAllDeclaration: fires for `export * from`',
		types.includes('ExportAllDeclaration'));
	check('ExportNamedDeclaration: does NOT fire for `export *`',
		!types.includes('ExportNamedDeclaration'));
}

{
	// `export * as ns from 'x'` — also ExportAllDeclaration.
	const code = `export * as ns from 'x';`;
	const types = scan(code, ['ExportAllDeclaration']).entered;
	check('ExportAllDeclaration: fires for `export * as ns`',
		types.includes('ExportAllDeclaration'));
}

{
	// `export default <expr>` — ExportDefaultDeclaration.
	const code = `export default 42;`;
	const types = scan(code, ['ExportDefaultDeclaration']).entered;
	check('ExportDefaultDeclaration: fires for `export default <expr>`',
		types.includes('ExportDefaultDeclaration'));
}

{
	// `export default function foo() {}` — fixExports wrapper as default.
	const code = `export default function foo() {}`;
	const types = scan(code, ['ExportDefaultDeclaration', 'FunctionDeclaration']).entered;
	check('ExportDefaultDeclaration: fires for `export default function`',
		types.includes('ExportDefaultDeclaration'));
	check('FunctionDeclaration: inner still fires under unwrapChain',
		types.includes('FunctionDeclaration'));
}

{
	// `export = expr` — TSExportAssignment, NOT ExportDefaultDeclaration.
	const code = `export = { a: 1 };`;
	const types = scan(code, ['ExportDefaultDeclaration', 'TSExportAssignment']).entered;
	check('ExportDefaultDeclaration: does NOT fire for `export =`',
		!types.includes('ExportDefaultDeclaration'));
	check('TSExportAssignment: fires for `export =`',
		types.includes('TSExportAssignment'));
}

// --- TSTypeQuery / TSImportType — `typeof import('x')` wrapper ------

{
	// Regular `typeof X` — TSTypeQuery.
	const code = `let x: typeof Date;`;
	const types = scan(code, ['TSTypeQuery', 'TSImportType']).entered;
	check('TSTypeQuery: fires for `typeof X`', types.includes('TSTypeQuery'));
	check('TSImportType: does NOT fire for `typeof X`', !types.includes('TSImportType'));
}

{
	// `typeof import('x')` — TSTypeQuery wrapping TSImportType. Both
	// listeners must fire (unwrapChain handles the wrap).
	const code = `let x: typeof import('x');`;
	const types = scan(code, ['TSTypeQuery', 'TSImportType']).entered;
	check('TSTypeQuery: fires for `typeof import(...)` (wrapper)',
		types.includes('TSTypeQuery'));
	check('TSImportType: inner fires too via unwrapChain',
		types.includes('TSImportType'));
}

{
	// `import('x')` (in type position, no typeof) — just TSImportType.
	const code = `let x: import('x');`;
	const types = scan(code, ['TSTypeQuery', 'TSImportType']).entered;
	check('TSImportType: fires for `import(...)` without typeof',
		types.includes('TSImportType'));
	check('TSTypeQuery: does NOT fire for plain `import(...)`',
		!types.includes('TSTypeQuery'));
}

// --- ImportExpression (dynamic `import()` as expression) -------------

{
	const types = scan(`async function f() { return await import('x'); }`, ['ImportExpression']).entered;
	check('ImportExpression: fires for dynamic import() as expression',
		types.includes('ImportExpression'));
}

{
	// CallExpression listener should NOT fire on dynamic import.
	const types = scan(`f(); import('x');`, ['CallExpression', 'ImportExpression']).entered;
	const calls = types.filter(t => t === 'CallExpression').length;
	const imports = types.filter(t => t === 'ImportExpression').length;
	check('CallExpression vs ImportExpression: split correctly',
		calls === 1 && imports === 1, `got CE=${calls}, IE=${imports}`);
}

// --- TSDeclareFunction (body-less function declaration) -------------

{
	const code = `declare function foo(): void; function bar() {}`;
	const types = scan(code, ['TSDeclareFunction', 'FunctionDeclaration']).entered;
	check('TSDeclareFunction: fires for `declare function`',
		types.includes('TSDeclareFunction'));
	check('FunctionDeclaration: fires for body-having declaration',
		types.includes('FunctionDeclaration'));
}

// --- ChainExpression — outermost only --------------------------------

{
	// Single-level optional chain: `a?.b` — ChainExpression on the only
	// access.
	const types = scan(`let r = a?.b;`, ['ChainExpression']).entered;
	const count = types.filter(t => t === 'ChainExpression').length;
	check('ChainExpression: fires once for `a?.b`',
		count === 1, `got count=${count}`);
}

{
	// Multi-level chain: `a?.b.c` — ChainExpression fires ONLY on outermost.
	const types = scan(`let r = a?.b.c;`, ['ChainExpression']).entered;
	const count = types.filter(t => t === 'ChainExpression').length;
	check('ChainExpression: fires exactly once for `a?.b.c` (outermost only)',
		count === 1, `got count=${count}`);
}

{
	// Optional call: `a?.b()` — ChainExpression on the outermost
	// (CallExpression).
	const types = scan(`let r = a?.b();`, ['ChainExpression']).entered;
	const count = types.filter(t => t === 'ChainExpression').length;
	check('ChainExpression: fires once for `a?.b()` (outermost call)',
		count === 1, `got count=${count}`);
}

{
	// Two SEPARATE chains in one expression — each fires its own ChainExpression.
	const types = scan(`let r = a?.b + c?.d;`, ['ChainExpression']).entered;
	const count = types.filter(t => t === 'ChainExpression').length;
	check('ChainExpression: fires twice for two separate chains',
		count === 2, `got count=${count}`);
}

{
	// Chain with non-null assertion: `a!.b?.c` — non-null assertion
	// extends the chain.
	const types = scan(`let r = a!.b?.c;`, ['ChainExpression']).entered;
	const count = types.filter(t => t === 'ChainExpression').length;
	check('ChainExpression: fires once for `a!.b?.c`',
		count === 1, `got count=${count}`);
}

{
	// No chain — non-optional access shouldn't fire ChainExpression.
	const types = scan(`let r = a.b.c;`, ['ChainExpression']).entered;
	check('ChainExpression: does NOT fire for non-optional access',
		!types.includes('ChainExpression'));
}

{
	// MemberExpression listener still fires inside chains.
	const types = scan(`let r = a?.b.c;`, ['MemberExpression']).entered;
	const count = types.filter(t => t === 'MemberExpression').length;
	// `a?.b.c` has 2 MemberExpressions (.b and .c — outer materialises as
	// ChainExpression wrapping outer MemberExpression; unwrapChain emits
	// MemberExpression for it. Then inner ?.b is also visited as plain
	// MemberExpression after outer's processing rewrote its cache.)
	check('MemberExpression: fires for both .b and .c in `a?.b.c`',
		count === 2, `got count=${count}`);
}

// --- TSAbstractMethodDefinition --------------------------------------

{
	const code = `abstract class C {
		foo() {}
		abstract bar(): void;
	}`;
	const types = scan(code, ['MethodDefinition', 'TSAbstractMethodDefinition']).entered;
	check('MethodDefinition: fires for non-abstract method',
		types.includes('MethodDefinition'));
	check('TSAbstractMethodDefinition: fires for abstract method',
		types.includes('TSAbstractMethodDefinition'));
	check('MethodDefinition: does NOT also fire on abstract method',
		types.filter(t => t === 'MethodDefinition').length === 1);
}

// --- ClassBody (drilled in via unwrapChain) -------------------------

{
	// ClassBody listener fires for both class declaration and expression.
	const code = `class A {} const B = class {};`;
	const types = scan(code, ['ClassBody']).entered;
	const count = types.filter(t => t === 'ClassBody').length;
	check('ClassBody: fires for ClassDeclaration AND ClassExpression',
		count === 2, `got count=${count}`);
}

{
	// Both ClassDeclaration and ClassBody listeners fire (chain order:
	// ClassDeclaration first, then ClassBody).
	const { entered } = scan(`class C { foo() {} }`, ['ClassDeclaration', 'ClassBody']);
	const cdIdx = entered.indexOf('ClassDeclaration');
	const cbIdx = entered.indexOf('ClassBody');
	check('ClassDeclaration enters before ClassBody (parent → child)',
		cdIdx >= 0 && cbIdx >= 0 && cdIdx < cbIdx,
		`order: [${entered.join(', ')}]`);
}

// --- StaticBlock -----------------------------------------------------

{
	const code = `class C { static { console.log('init'); } }`;
	const types = scan(code, ['StaticBlock']).entered;
	check('StaticBlock: fires for `class C { static {} }`',
		types.includes('StaticBlock'));
}

{
	// StaticBlock should NOT fire for non-static class methods or fields.
	const code = `class C { static foo = 1; static bar() {} }`;
	const types = scan(code, ['StaticBlock']).entered;
	check('StaticBlock: does NOT fire for `static` field/method',
		!types.includes('StaticBlock'));
}

// --- MetaProperty ----------------------------------------------------

{
	const code = `function f() { return new.target; }`;
	const types = scan(code, ['MetaProperty']).entered;
	check('MetaProperty: fires for `new.target`',
		types.includes('MetaProperty'));
}

{
	const code = `let x = import.meta.url;`;
	const types = scan(code, ['MetaProperty']).entered;
	check('MetaProperty: fires for `import.meta`',
		types.includes('MetaProperty'));
}

{
	// MetaProperty's materialised shape: meta + property.
	const code = `let x = import.meta;`;
	const sf = parseTs(code);
	const { context } = lazy.convertLazy(sf);
	const pred = predicateForTriggerSet(['MetaProperty'])!;
	const steps = tsScanTraverse(sf, pred, context);
	const target = (steps as any[])[0]?.target;
	check('MetaProperty: target.type === MetaProperty', target?.type === 'MetaProperty');
	check('MetaProperty: target.meta is Identifier "import"',
		target?.meta?.type === 'Identifier' && target.meta.name === 'import');
	check('MetaProperty: target.property is Identifier "meta"',
		target?.property?.type === 'Identifier');
}

console.log();
if (failures.length) {
	console.log('FAILURES:');
	for (const f of failures) console.log('  ' + f);
	process.exit(1);
}
console.log('All ts-ast-scan tests passed');
