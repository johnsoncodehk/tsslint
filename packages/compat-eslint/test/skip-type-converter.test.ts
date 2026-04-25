// Tests for the selector-aware skip-type-converter. Run with:
//   node --experimental-strip-types --no-warnings packages/compat-eslint/test/skip-type-converter.test.ts
//
// The optimisation skips TS-only AST subtrees so ESLint's traverser doesn't
// visit them. The selector-aware part: if any registered rule listens on a
// TSXxx node type, that node type must NOT be skipped — otherwise the rule's
// visitor never fires (silent rule failure).

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

// --- Tests --------------------------------------------------------------

console.log('skip-type-converter selector-aware tests');

// Reset to default before each scenario.
function resetSkipKinds() {
	skip.configureSkipKindsForVisitors(new Set());
}

// Scenario 1: default (no rule listens on TSAnyKeyword) — TSAnyKeyword is
// skipped, so the converted ESTree has zero TSAnyKeyword nodes.
{
	resetSkipKinds();
	const sf = parseTs('let x: any = 1; function f(y: any): any { return y; }');
	const { estree } = skip.astConvertSkipTypes(sf, PARSE_SETTINGS as any, true);
	const anyCount = countNodes(estree, 'TSAnyKeyword');
	check('default config skips TSAnyKeyword', anyCount === 0, `count=${anyCount}`);
}

// Scenario 2: a rule registers TSAnyKeyword as a visited selector — those
// nodes must survive the conversion so the rule's visitor fires.
{
	skip.configureSkipKindsForVisitors(new Set(['TSAnyKeyword']));
	const sf = parseTs('let x: any = 1; function f(y: any): any { return y; }');
	const { estree } = skip.astConvertSkipTypes(sf, PARSE_SETTINGS as any, true);
	const anyCount = countNodes(estree, 'TSAnyKeyword');
	// Three explicit `any`s in the source.
	check('TSAnyKeyword is preserved when listened to', anyCount === 3, `count=${anyCount}`);
}

// Scenario 3: other type-only nodes still get skipped even when TSAnyKeyword
// is preserved — the carve-out is per-type, not all-or-nothing.
{
	skip.configureSkipKindsForVisitors(new Set(['TSAnyKeyword']));
	const sf = parseTs('type T = string | number; let x: T = 1;');
	const { estree } = skip.astConvertSkipTypes(sf, PARSE_SETTINGS as any, true);
	const unionCount = countNodes(estree, 'TSUnionType');
	const refCount = countNodes(estree, 'TSTypeReference');
	check('TSUnionType still skipped when not listened', unionCount === 0, `count=${unionCount}`);
	check('TSTypeReference still skipped when not listened', refCount === 0, `count=${refCount}`);
}

// Scenario 4: multiple selectors at once.
{
	skip.configureSkipKindsForVisitors(new Set(['TSAnyKeyword', 'TSUnionType']));
	const sf = parseTs('let x: any | string = 1;');
	const { estree } = skip.astConvertSkipTypes(sf, PARSE_SETTINGS as any, true);
	const anyCount = countNodes(estree, 'TSAnyKeyword');
	const unionCount = countNodes(estree, 'TSUnionType');
	check('multi-selector: TSAnyKeyword preserved', anyCount === 1, `count=${anyCount}`);
	check('multi-selector: TSUnionType preserved', unionCount === 1, `count=${unionCount}`);
}

// --- Done ---------------------------------------------------------------

console.log(`\n${failures.length === 0 ? 'all pass' : `${failures.length} FAILED`}`);
process.exit(failures.length === 0 ? 0 : 1);
