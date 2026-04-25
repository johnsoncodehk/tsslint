// Tests for the selector-aware skip-type-converter. Run with:
//   node packages/compat-eslint/test/skip-type-converter.test.js
//
// The optimisation skips TS-only AST subtrees so ESLint's traverser doesn't
// visit them. Selector-aware: `configureSkipKindsForVisitors(selectors)`
// takes raw rule-listener-key strings (with esquery combinators, attribute
// filters, `:exit` pseudo-class etc.), extracts the AST node type names,
// and exempts those kinds from skipping. The contract: any node type
// referenced by any selector must survive the converter.

import * as ts from 'typescript';

const skip = require('../lib/skip-type-converter.js') as typeof import('../lib/skip-type-converter.js');

const PARSE_SETTINGS = {
	allowInvalidAST: false,
	comment: true,
	errorOnUnknownASTType: false,
	loc: true,
	range: true,
	suppressDeprecatedPropertyWarnings: true,
	tokens: true,
};

function parseTs(code: string) {
	return ts.createSourceFile('/test.ts', code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}

function countNodes(root: any, typeName: string): number {
	let n = 0;
	const walk = (node: any) => {
		if (!node || typeof node !== 'object') return;
		if (Array.isArray(node)) {
			for (const c of node) walk(c);
			return;
		}
		if (node.type === typeName) n++;
		for (const key of Object.keys(node)) {
			if (key === 'parent' || key === 'loc' || key === 'range') continue;
			walk(node[key]);
		}
	};
	walk(root);
	return n;
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

console.log('skip-type-converter selector-aware tests');

// --- Default (no selectors) -----------------------------------------------

// Pre-condition: with no selector input, the default SKIP_KINDS is active
// and all type-only nodes get dropped from the ESTree.
{
	skip.configureSkipKindsForVisitors([]);
	const sf = parseTs('let x: any = 1; type T = string | number; let y: T;');
	const { estree } = skip.astConvertSkipTypes(sf, PARSE_SETTINGS as any, true);
	check('default: TSAnyKeyword skipped', countNodes(estree, 'TSAnyKeyword') === 0);
	check('default: TSUnionType skipped', countNodes(estree, 'TSUnionType') === 0);
	check('default: TSTypeReference skipped', countNodes(estree, 'TSTypeReference') === 0);
	check('default: TSStringKeyword skipped', countNodes(estree, 'TSStringKeyword') === 0);
}

// --- Plain selectors (the common case) ------------------------------------

// `TSAnyKeyword` listed by `no-explicit-any` — a literal AST node type as
// the entire selector string.
{
	skip.configureSkipKindsForVisitors(['TSAnyKeyword']);
	const sf = parseTs('let x: any = 1; function f(y: any): any {}');
	const { estree } = skip.astConvertSkipTypes(sf, PARSE_SETTINGS as any, true);
	check('plain selector: TSAnyKeyword preserved', countNodes(estree, 'TSAnyKeyword') === 3);
	check('plain selector: TSTypeReference still skipped', countNodes(estree, 'TSTypeReference') === 0);
}

// --- :exit pseudo-class ---------------------------------------------------

// ESLint allows `Type:exit` to fire on the leave-event for a subtree.
// `no-redundant-type-constituents` registers `'TSUnionType:exit'`. The
// extractor must still recognise the type name.
{
	skip.configureSkipKindsForVisitors(['TSUnionType:exit']);
	const sf = parseTs('let x: string | number = 1;');
	const { estree } = skip.astConvertSkipTypes(sf, PARSE_SETTINGS as any, true);
	check(':exit selector: TSUnionType preserved', countNodes(estree, 'TSUnionType') === 1);
}

// --- esquery combinators --------------------------------------------------

// `'TSTypeReference > Identifier'` is a parent>child selector. Both
// PascalCase tokens should be extracted and exempted (Identifier wasn't in
// SKIP_KINDS to begin with, so only TSTypeReference is observable).
{
	skip.configureSkipKindsForVisitors(['TSTypeReference > Identifier']);
	const sf = parseTs('type T = string; let x: T;');
	const { estree } = skip.astConvertSkipTypes(sf, PARSE_SETTINGS as any, true);
	check('combinator selector: TSTypeReference preserved', countNodes(estree, 'TSTypeReference') === 1);
}

// --- Attribute filters ----------------------------------------------------

// Selectors like `'CallExpression[callee.name="x"]'` carry attribute
// filters in brackets. The PascalCase extraction must not pick anything
// out of `"x"` (it's a string literal). Use a TS keyword so we can verify
// the right kind was exempted.
{
	skip.configureSkipKindsForVisitors(['TSAnyKeyword[fixToUnknown=false]']);
	const sf = parseTs('let x: any = 1;');
	const { estree } = skip.astConvertSkipTypes(sf, PARSE_SETTINGS as any, true);
	check('attribute selector: TSAnyKeyword preserved', countNodes(estree, 'TSAnyKeyword') === 1);
	// Sanity: we didn't accidentally exempt unrelated kinds.
	check('attribute selector: TSUnionType still skipped', countNodes(estree, 'TSUnionType') === 0);
}

// --- Multiple rules contributing different selectors ---------------------

// Realistic case: one rule listens on TSAnyKeyword, another on
// 'TSUnionType:exit'. The union of both must be preserved.
{
	skip.configureSkipKindsForVisitors(['TSAnyKeyword', 'TSUnionType:exit']);
	const sf = parseTs('let x: any = 1; let y: string | number = 2;');
	const { estree } = skip.astConvertSkipTypes(sf, PARSE_SETTINGS as any, true);
	check('multi-rule: TSAnyKeyword preserved', countNodes(estree, 'TSAnyKeyword') === 1);
	check('multi-rule: TSUnionType preserved', countNodes(estree, 'TSUnionType') === 1);
	check('multi-rule: unrelated TSTypeReference still skipped', countNodes(estree, 'TSTypeReference') === 0);
}

// --- Reconfiguration is non-cumulative ----------------------------------

// Calling configureSkipKindsForVisitors a second time must replace, not
// add to, the previous exemption set — otherwise a config reload that
// drops a rule wouldn't actually drop its exemption.
{
	skip.configureSkipKindsForVisitors(['TSAnyKeyword']);
	skip.configureSkipKindsForVisitors(['TSUnionType']);
	const sf = parseTs('let x: any = 1; let y: string | number;');
	const { estree } = skip.astConvertSkipTypes(sf, PARSE_SETTINGS as any, true);
	check('non-cumulative: TSAnyKeyword now skipped again', countNodes(estree, 'TSAnyKeyword') === 0);
	check('non-cumulative: TSUnionType preserved', countNodes(estree, 'TSUnionType') === 1);
}

// --- ALL_SKIPPABLE_AST_NODE_TYPES escape hatch --------------------------

// When rule probing fails, the caller passes this set to disable skipping
// entirely. Verify no skippable kind survives in the skip set afterwards.
{
	skip.configureSkipKindsForVisitors(skip.ALL_SKIPPABLE_AST_NODE_TYPES);
	const sf = parseTs('let x: any = 1; let y: string | number; type T = readonly string[]; let z: T;');
	const { estree } = skip.astConvertSkipTypes(sf, PARSE_SETTINGS as any, true);
	check('escape hatch: TSAnyKeyword preserved', countNodes(estree, 'TSAnyKeyword') === 1);
	check('escape hatch: TSUnionType preserved', countNodes(estree, 'TSUnionType') === 1);
	check('escape hatch: TSTypeReference preserved', countNodes(estree, 'TSTypeReference') >= 1);
	check('escape hatch: TSArrayType preserved', countNodes(estree, 'TSArrayType') === 1);
}

// --- Done ---------------------------------------------------------------

console.log(`\n${failures.length === 0 ? 'all pass' : `${failures.length} FAILED`}`);
process.exit(failures.length === 0 ? 0 : 1);
