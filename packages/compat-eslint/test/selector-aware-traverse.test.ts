// Selector-aware traversal tests for lib/selector-aware-traverse.ts.
// Run via:
//   node --experimental-strip-types --no-warnings packages/compat-eslint/test/selector-aware-traverse.test.ts

import * as ts from 'typescript';

const lazy = require('../lib/lazy-estree.js') as typeof import('../lib/lazy-estree.js');
const { selectorAwareTraverse, TYPE_ONLY_ROOTS, TYPE_ONLY_REACH, triggersOverlapTypeOnly } = require('../lib/selector-aware-traverse.js') as typeof import('../lib/selector-aware-traverse.js');
const { buildTriggerSet } = require('../lib/selector-analysis.js') as typeof import('../lib/selector-analysis.js');
const { visitorKeys } = require('@typescript-eslint/visitor-keys') as { visitorKeys: Record<string, readonly string[] | undefined> };

const eslintRoot = (() => {
	const path = require('path') as typeof import('path');
	return path.dirname(require.resolve('eslint/package.json'));
})();
const path = require('path') as typeof import('path');
const Traverser = require(path.join(eslintRoot, 'lib/shared/traverser.js')) as { getKeys(node: object): string[] };

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

// Steps shape: VisitNodeStep instances. Distinguish enter (phase 1) from
// leave (phase 2) and pull out the target's type for assertions.
function visitedTypes(steps: any[]): { enter: string[]; leave: string[] } {
	const enter: string[] = [];
	const leave: string[] = [];
	for (const step of steps) {
		if (step.kind !== 1) continue;
		if (step.phase === 1) enter.push(step.target.type);
		else leave.push(step.target.type);
	}
	return { enter, leave };
}

function traverse(code: string, selectors: string[]) {
	const sf = parseTs(code);
	const { estree } = lazy.convertLazy(sf);
	const triggers = buildTriggerSet(selectors);
	const steps = selectorAwareTraverse(estree, {
		visitorKeys,
		fallbackKeys: Traverser.getKeys,
		triggers,
	});
	return { triggers, steps, types: visitedTypes(steps) };
}

// --- Basic shape parity ----------------------------------------------

{
	// Simple JS — no TS, so type-only roots are absent. With a non-`*`
	// trigger set we should still visit every node.
	const code = `function foo(x) { return x + 1; }`;
	const { types } = traverse(code, ['Identifier']);
	check('simple JS: enter has Program', types.enter[0] === 'Program');
	check('simple JS: enter has FunctionDeclaration', types.enter.includes('FunctionDeclaration'));
	check('simple JS: enter has BlockStatement', types.enter.includes('BlockStatement'));
	check('simple JS: enter has ReturnStatement', types.enter.includes('ReturnStatement'));
	check('simple JS: enter has BinaryExpression', types.enter.includes('BinaryExpression'));
	check('simple JS: enter has Literal', types.enter.includes('Literal'));
	// Identifier appears multiple times
	check('simple JS: visits Identifier', types.enter.includes('Identifier'));
}

{
	// Enter and leave events come in pairs (same count).
	const code = `let x = 1; let y = 2;`;
	const { types } = traverse(code, ['Identifier']);
	check('enter/leave count matches', types.enter.length === types.leave.length);
	// First enter is Program; last leave is Program.
	check('first enter is root', types.enter[0] === 'Program');
	check('last leave is root', types.leave[types.leave.length - 1] === 'Program');
}

// --- Type-only subtree skip ------------------------------------------

{
	// Trigger set has nothing in TYPE_ONLY_REACH → type-only subtrees skipped.
	const code = `let x: number = 1;`;
	const { types } = traverse(code, ['VariableDeclaration']);
	check('skip-type: VariableDeclaration is entered', types.enter.includes('VariableDeclaration'));
	// TSTypeAnnotation is still entered (it's the root we don't recurse INTO),
	// so it appears once. But its child TSNumberKeyword should NOT be entered.
	check('skip-type: TSTypeAnnotation root is entered', types.enter.includes('TSTypeAnnotation'));
	check('skip-type: TSNumberKeyword (inside TSTypeAnnotation) skipped', !types.enter.includes('TSNumberKeyword'));
	// Literal `1` is the init — outside the type subtree, still visited.
	check('skip-type: Literal (init) still visited', types.enter.includes('Literal'));
}

{
	// Trigger Identifier → Identifier is in TYPE_ONLY_REACH → don't skip.
	const code = `let x: number = 1;`;
	const { types } = traverse(code, ['Identifier']);
	check('no-skip: Identifier trigger keeps TSNumberKeyword visited', types.enter.includes('TSNumberKeyword'));
}

{
	// Trigger TSAnyKeyword (a TS-prefixed leaf type in TYPE_ONLY_REACH)
	// → don't skip type-only subtrees.
	const code = `let x: any = 1;`;
	const { types } = traverse(code, ['TSAnyKeyword']);
	check('no-skip: TSAnyKeyword trigger reaches into TSTypeAnnotation', types.enter.includes('TSAnyKeyword'));
}

{
	// Self-lint trigger set: Program, ImportDeclaration, TSAsExpression,
	// TSTypeAssertion, TSNonNullExpression. None overlap TYPE_ONLY_REACH.
	// (Excluded TSAsExpression from this fixture — its typeAnnotation slot
	// contains a TS type but TSAsExpression itself is not a root, so the
	// nested type wouldn't be skipped. Slot-level skip is a future-Phase-B
	// item.)
	const code = `
		import { foo } from './bar';
		let x: number = 1;
		interface I { name: string; }
		type T = number | string;
		function f(x: number): number { return x; }
	`;
	const { triggers, types } = traverse(code, [
		'Program:exit',
		'ImportDeclaration',
		'TSAsExpression, TSTypeAssertion',
		'TSNonNullExpression',
	]);
	check('self-lint shape: triggers not isAll', !triggers.isAll());
	check('self-lint shape: ImportDeclaration visited', types.enter.includes('ImportDeclaration'));
	// TSInterfaceDeclaration is a TYPE_ONLY_ROOT — its body should be skipped.
	check('self-lint shape: TSInterfaceDeclaration root visited', types.enter.includes('TSInterfaceDeclaration'));
	check('self-lint shape: TSInterfaceBody skipped', !types.enter.includes('TSInterfaceBody'));
	// TSTypeAliasDeclaration is a TYPE_ONLY_ROOT — its body skipped.
	check('self-lint shape: TSTypeAliasDeclaration root visited', types.enter.includes('TSTypeAliasDeclaration'));
	check('self-lint shape: TSUnionType (inside type alias) skipped', !types.enter.includes('TSUnionType'));
	// Function param: Identifier `x`. Identifier's typeAnnotation slot
	// holds a TSTypeAnnotation → that root is entered, body skipped.
	check('self-lint shape: TSTypeAnnotation root visited', types.enter.includes('TSTypeAnnotation'));
	check('self-lint shape: TSNumberKeyword (all instances inside type-only roots) skipped', !types.enter.includes('TSNumberKeyword'));
}

{
	// Hybrid type roots (TSAsExpression, etc.) are NOT skipped — slot-level
	// skip is a future enhancement. Document the current behaviour with a
	// regression test so changes here are intentional.
	const code = `let v = (x as number);`;
	const { types } = traverse(code, ['VariableDeclaration']);
	check('hybrid root: TSAsExpression entered', types.enter.includes('TSAsExpression'));
	check('hybrid root limitation: TSNumberKeyword inside TSAsExpression IS visited (slot-level skip not implemented)',
		types.enter.includes('TSNumberKeyword'));
}

// --- Wildcard / isAll forces no skip ---------------------------------

{
	const triggers = buildTriggerSet(['*']);
	check('wildcard triggers isAll', triggers.isAll());
	check('wildcard triggers triggersOverlapTypeOnly true', triggersOverlapTypeOnly(triggers));
}

{
	// Empty selector set defaults to isAll: caller should fall back to ESLint
	// traverse, but our selectorAwareTraverse with isAll still runs without
	// throwing. Subtree skip should be disabled.
	const code = `let x: number = 1;`;
	const { types } = traverse(code, ['*']);
	check('isAll: TSNumberKeyword still visited', types.enter.includes('TSNumberKeyword'));
}

// --- triggersOverlapTypeOnly correctness -----------------------------

{
	check('overlap: Identifier triggers overlap', triggersOverlapTypeOnly(buildTriggerSet(['Identifier'])));
	check('overlap: TSAnyKeyword triggers overlap', triggersOverlapTypeOnly(buildTriggerSet(['TSAnyKeyword'])));
	check('overlap: TSTypeReference triggers overlap', triggersOverlapTypeOnly(buildTriggerSet(['TSTypeReference'])));
	check('overlap: BinaryExpression triggers DO NOT overlap', !triggersOverlapTypeOnly(buildTriggerSet(['BinaryExpression'])));
	check('overlap: ImportDeclaration DO NOT overlap', !triggersOverlapTypeOnly(buildTriggerSet(['ImportDeclaration'])));
	check('overlap: TSAsExpression DO NOT overlap', !triggersOverlapTypeOnly(buildTriggerSet(['TSAsExpression'])));
	check('overlap: VariableDeclaration DO NOT overlap', !triggersOverlapTypeOnly(buildTriggerSet(['VariableDeclaration'])));
}

// --- Constants are sane ----------------------------------------------

{
	check('TYPE_ONLY_ROOTS: includes TSTypeAnnotation', TYPE_ONLY_ROOTS.has('TSTypeAnnotation'));
	check('TYPE_ONLY_ROOTS: includes TSTypeAliasDeclaration', TYPE_ONLY_ROOTS.has('TSTypeAliasDeclaration'));
	check('TYPE_ONLY_ROOTS: includes TSInterfaceDeclaration', TYPE_ONLY_ROOTS.has('TSInterfaceDeclaration'));
	check('TYPE_ONLY_ROOTS: excludes TSEnumDeclaration (has JS expr)', !TYPE_ONLY_ROOTS.has('TSEnumDeclaration'));
	check('TYPE_ONLY_ROOTS: excludes TSAsExpression (hybrid)', !TYPE_ONLY_ROOTS.has('TSAsExpression'));
	check('TYPE_ONLY_REACH: includes Identifier', TYPE_ONLY_REACH.has('Identifier'));
	check('TYPE_ONLY_REACH: includes Literal', TYPE_ONLY_REACH.has('Literal'));
	check('TYPE_ONLY_REACH: includes UnaryExpression', TYPE_ONLY_REACH.has('UnaryExpression'));
	check('TYPE_ONLY_REACH: includes TSAnyKeyword', TYPE_ONLY_REACH.has('TSAnyKeyword'));
	check('TYPE_ONLY_REACH: excludes TSAsExpression', !TYPE_ONLY_REACH.has('TSAsExpression'));
	check('TYPE_ONLY_REACH: excludes BinaryExpression', !TYPE_ONLY_REACH.has('BinaryExpression'));
}

// --- Parent linking is preserved -------------------------------------

{
	// SelectorAwareTraverse mirrors ESLint's traverse by setting node.parent.
	const code = `let x = 1;`;
	const sf = parseTs(code);
	const { estree } = lazy.convertLazy(sf);
	const triggers = buildTriggerSet(['Identifier']);
	selectorAwareTraverse(estree as object, {
		visitorKeys,
		fallbackKeys: Traverser.getKeys,
		triggers,
	});
	const decl = (estree.body as any[])[0];
	const declarator = decl.declarations[0];
	check('parent linking: VariableDeclaration.parent is Program', decl.parent === estree);
	check('parent linking: VariableDeclarator.parent is VariableDeclaration', declarator.parent === decl);
	check('parent linking: Identifier.parent is VariableDeclarator', declarator.id.parent === declarator);
}

// --- Skipped subtree still has correct enter/leave for the root -----

{
	const code = `let x: number = 1;`;
	const { steps } = traverse(code, ['VariableDeclaration']);
	// Find TSTypeAnnotation enter and leave indices.
	let enterIdx = -1, leaveIdx = -1;
	for (let i = 0; i < steps.length; i++) {
		const s = steps[i] as any;
		if (s.kind !== 1) continue;
		if (s.target.type === 'TSTypeAnnotation') {
			if (s.phase === 1 && enterIdx === -1) enterIdx = i;
			if (s.phase === 2) leaveIdx = i;
		}
	}
	check('skip: TSTypeAnnotation has both enter and leave', enterIdx !== -1 && leaveIdx !== -1);
	// Between enter and leave of TSTypeAnnotation, nothing else should appear.
	let hasInner = false;
	for (let i = enterIdx + 1; i < leaveIdx; i++) {
		hasInner = true;
		break;
	}
	check('skip: TSTypeAnnotation enter/leave are adjacent (no children)', !hasInner);
}

console.log();
if (failures.length) {
	console.log('FAILURES:');
	for (const f of failures) console.log('  ' + f);
	process.exit(1);
}
console.log('All selector-aware-traverse tests passed');
