// Coverage matrix: every `AST_NODE_TYPES` value must either have a
// TS predicate registered in `lib/ts-ast-scan.ts` `PREDICATES` (so a
// rule listening on that ESTree type can dispatch), or be in the
// IGNORED set below with an explicit reason.
//
// New ESTree types added by `@typescript-eslint/types` upgrades will
// fail this test until they're either ported to a predicate or
// added to IGNORED. That's the point.
//
// Run via: node packages/compat-eslint/test/predicate-coverage.test.js

import { AST_NODE_TYPES } from '@typescript-eslint/types';
import { hasPredicate } from '../lib/ts-ast-scan';

// ESTree types we deliberately don't support. Each entry needs a one-
// line reason a future maintainer can act on.
const IGNORED: Record<string, string> = {
	// AST_NODE_TYPES enum members that are container types, not nodes
	// rules can listen on as standalone targets.
	Program: 'visited via tsScanTraverse root, never dispatched as a child target',

	// Modifier-keyword pseudo-tokens. Modifiers appear as part of their
	// parent's `modifiers[]` array; rules don't listen on them as
	// standalone targets. They have no TS SyntaxKind that maps 1:1
	// because TS uses keyword-token nodes inline (SK.PublicKeyword etc.)
	// rather than separate ESTree-style wrappers.
	TSAbstractKeyword: 'modifier token; not dispatched as a standalone target',
	TSAsyncKeyword: 'modifier token; not dispatched as a standalone target',
	TSDeclareKeyword: 'modifier token; not dispatched as a standalone target',
	TSExportKeyword: 'modifier token; not dispatched as a standalone target',
	TSPrivateKeyword: 'modifier token; not dispatched as a standalone target',
	TSProtectedKeyword: 'modifier token; not dispatched as a standalone target',
	TSPublicKeyword: 'modifier token; not dispatched as a standalone target',
	TSReadonlyKeyword: 'modifier token; not dispatched as a standalone target',
	TSStaticKeyword: 'modifier token; not dispatched as a standalone target',

	// Synthetic wrappers with no TS counterpart. typescript-estree
	// wraps a type node in TSTypeAnnotation (the `: T` part) and
	// type-parameter lists in TSTypeParameterDeclaration /
	// TSTypeParameterInstantiation. The wrapper class exists in
	// lazy-estree (parent slot getters build it on demand), but the
	// underlying TS AST has no node to predicate on.
	TSTypeAnnotation: 'synthetic wrapper; emitted by parent slot getter, no TS source kind',
	TSTypeParameterDeclaration: 'synthetic wrapper around `<T, U>` typeParameters list',
	TSTypeParameterInstantiation: 'synthetic wrapper around `<string>` call/new typeArguments list',

	// Class method shorthand for declared (no-body) methods. We emit
	// these via MethodDefinition + nested function-like with body=null,
	// not as a dedicated TSEmptyBodyFunctionExpression slot. Rules
	// listen on MethodDefinition / FunctionExpression instead.
	TSEmptyBodyFunctionExpression: 'absorbed into MethodDefinition.value with body=null',

	// TemplateLiteral.quasis components. Rules listen on
	// TemplateLiteral; TemplateElement is its child slot, never a
	// standalone target.
	TemplateElement: 'child slot of TemplateLiteral; never a standalone target',

	// `with (obj) { ... }` block. TS strict-mode forbids it and
	// TSSLint targets TS code; predicating on it would be dead code.
	WithStatement: 'TS strict mode forbids `with`; out of TSSLint scope',
};

const failures: string[] = [];
let checked = 0;
let ignored = 0;

for (const t of Object.values(AST_NODE_TYPES)) {
	checked++;
	if (IGNORED[t]) {
		ignored++;
		continue;
	}
	if (!hasPredicate(t)) {
		failures.push(t);
	}
}

if (failures.length > 0) {
	console.error('predicate-coverage: missing predicates for ESTree types:');
	for (const t of failures) console.error('  -', t);
	console.error('');
	console.error('Either add an entry to PREDICATES in lib/ts-ast-scan.ts,');
	console.error('or add a one-line reason to IGNORED in this test.');
	process.exit(1);
}

console.log(`predicate-coverage: ${checked - ignored}/${checked - ignored} ESTree types covered (${ignored} ignored)`);
