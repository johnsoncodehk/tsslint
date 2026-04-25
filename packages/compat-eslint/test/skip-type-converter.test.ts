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

// --- :matches / :not / :has containing type names ----------------------

// Real rules (e.g. consistent-type-imports) use compound selectors like
// `:matches(ClassBody, TSInterfaceBody, TSTypeLiteral)` — every PascalCase
// token inside the parens must be exempted, including TS-only ones.
{
	skip.configureSkipKindsForVisitors([':matches(ClassBody, TSInterfaceBody, TSTypeLiteral)']);
	const sf = parseTs('let x: { foo: number };');
	const { estree } = skip.astConvertSkipTypes(sf, PARSE_SETTINGS as any, true);
	check(':matches selector: TSTypeLiteral preserved', countNodes(estree, 'TSTypeLiteral') === 1);
}

// --- wildcard `*` selector -----------------------------------------------

// A rule registering `'*'` listens on every node — it CANNOT be served if
// the converter drops type-only subtrees, since the rule's listener would
// never see those nodes. The probe must treat `*` as "exempt all
// skippable kinds".
{
	skip.configureSkipKindsForVisitors(['*']);
	const sf = parseTs('let x: any = 1; let y: string | number;');
	const { estree } = skip.astConvertSkipTypes(sf, PARSE_SETTINGS as any, true);
	check('wildcard: TSAnyKeyword preserved', countNodes(estree, 'TSAnyKeyword') === 1);
	check('wildcard: TSUnionType preserved', countNodes(estree, 'TSUnionType') === 1);
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

// --- esquery-grade precision (selectors a regex would mishandle) -------

// Attribute *value* contains a string that looks like a node-type name,
// but it's not — it's a literal being matched against. The selector
// only looks at MemberExpression nodes; it does NOT introduce a TS
// type into the visited set. esquery sees this as `attribute → literal`
// and never visits its content.
{
	skip.configureSkipKindsForVisitors(['MemberExpression[property.name="TSTypeReference"]']);
	const sf = parseTs('type T = string; let x: T = "a";');
	const { estree } = skip.astConvertSkipTypes(sf, PARSE_SETTINGS as any, true);
	check(
		'attribute literal: TSTypeReference NOT preserved (was inside string)',
		countNodes(estree, 'TSTypeReference') === 0,
	);
}

// Attribute regex pattern contains uppercase letters that aren't node
// types. `[A-Z]` is a character class inside a regex literal — esquery
// drops the regex content entirely; a regex extractor would falsely
// pull `A` (or `Z`).
{
	skip.configureSkipKindsForVisitors(['Identifier[name=/^[A-Z]/]']);
	const sf = parseTs('let x: any = 1;');
	const { estree } = skip.astConvertSkipTypes(sf, PARSE_SETTINGS as any, true);
	check(
		'regex literal in attribute: TSAnyKeyword still skipped',
		countNodes(estree, 'TSAnyKeyword') === 0,
	);
}

// `:not()` has the inverse semantic — `:not(TSAnyKeyword)` listens on
// every node EXCEPT TSAnyKeyword. We treat the inner identifier as
// "exempt" anyway because the OUTER selector still narrows to a node
// type the rule may want to visit (and over-exempting is safe). The
// goal of this test isn't semantic correctness — it's that esquery
// gracefully handles nested form without us having to special-case it.
{
	skip.configureSkipKindsForVisitors(['TSTypeReference:not(TSImportType)']);
	const sf = parseTs('type T = string; let x: T;');
	const { estree } = skip.astConvertSkipTypes(sf, PARSE_SETTINGS as any, true);
	check(
		':not container: outer TSTypeReference preserved',
		countNodes(estree, 'TSTypeReference') === 1,
	);
}

// `:has()` works on subtree presence: `Foo:has(Bar)` matches Foo whose
// descendants include Bar. Both PascalCase tokens should be exempted.
{
	skip.configureSkipKindsForVisitors(['TSTypeLiteral:has(TSPropertySignature)']);
	const sf = parseTs('let x: { foo: number };');
	const { estree } = skip.astConvertSkipTypes(sf, PARSE_SETTINGS as any, true);
	check(':has container: TSTypeLiteral preserved', countNodes(estree, 'TSTypeLiteral') === 1);
	check(':has container: TSPropertySignature preserved', countNodes(estree, 'TSPropertySignature') === 1);
}

// --- validateSelector: explicit pre-flight check ----------------------

// validateSelector is the primitive index.ts uses to attribute parse
// errors to a specific rule. It must throw on bad input (so the caller
// knows to wrap with rule-id context) and stay silent on valid input.
{
	let threw = false;
	try {
		skip.validateSelector('Foo[name=');
	}
	catch {
		threw = true;
	}
	check('validateSelector throws on invalid input', threw);

	let threwOnValid = false;
	try {
		skip.validateSelector('TSAnyKeyword');
	}
	catch {
		threwOnValid = true;
	}
	check('validateSelector silent on valid input', !threwOnValid);
}

// --- Invalid selector should throw (no silent wildcard fallback) -------

// A malformed selector means a buggy rule; ESLint's runtime would fail
// the same way when applying the selector. Throwing at probe time gives
// clear attribution (the bad selector text appears in the error) instead
// of silently degrading perf.
{
	let threw = false;
	try {
		skip.configureSkipKindsForVisitors(['Foo[name=']);
	}
	catch {
		threw = true;
	}
	check('invalid selector throws (no silent fallback)', threw);
}

// --- Real rule integration: probe a typescript-eslint plugin rule -------

// The full selector-aware path: load a real rule, call its `create()`
// under a stub context, hand the listener keys straight to
// `configureSkipKindsForVisitors`. The rule's visitor selectors come
// from production code, not hand-typed strings — this catches breakage
// from rule shape evolution (e.g. switching to esquery selectors).
{
	let noExplicitAny: any;
	try {
		noExplicitAny = require('@typescript-eslint/eslint-plugin').rules['no-explicit-any']
			?? require('@typescript-eslint/eslint-plugin/dist/rules/no-explicit-any.js').default;
	}
	catch {
		console.log('  skip - real rule integration (plugin not installed)');
	}
	if (noExplicitAny) {
		const stubContext: any = {
			cwd: '/',
			getCwd: () => '/',
			filename: '/probe.ts',
			getFilename: () => '/probe.ts',
			physicalFilename: '/probe.ts',
			getPhysicalFilename: () => '/probe.ts',
			sourceCode: undefined,
			getSourceCode: () => undefined,
			settings: {},
			parserOptions: {},
			languageOptions: { parserOptions: {} },
			parserPath: undefined,
			id: 'probe',
			options: [{}],
			report: () => {},
			getAncestors: () => [],
			getDeclaredVariables: () => [],
			getScope: () => undefined,
			markVariableAsUsed: () => false,
		};
		const listeners = noExplicitAny.create(stubContext) as Record<string, unknown>;
		const selectorKeys = Object.keys(listeners);
		check(
			'real rule: no-explicit-any registers TSAnyKeyword',
			selectorKeys.some(k => /\bTSAnyKeyword\b/.test(k)),
			`keys=${selectorKeys.join(',')}`,
		);
		skip.configureSkipKindsForVisitors(selectorKeys);
		const sf = parseTs('let x: any = 1; function f(y: any): any {}');
		const { estree } = skip.astConvertSkipTypes(sf, PARSE_SETTINGS as any, true);
		check(
			'real rule: TSAnyKeyword preserved after probe',
			countNodes(estree, 'TSAnyKeyword') === 3,
		);
		// Negative: an unrelated type-only kind that no-explicit-any does NOT
		// listen on still gets skipped — we only exempt what's needed.
		check(
			'real rule: TSUnionType still skipped (rule does not listen)',
			countNodes(estree, 'TSUnionType') === 0,
		);
	}
}

// --- Full-plugin probe: every rule in @typescript-eslint/eslint-plugin --

// Sweep across the entire typescript-eslint rule set. Goal: catch any
// rule whose listener-key shape we don't handle (esquery parse failure,
// unexpected non-string keys, etc.) and confirm the aggregate exemption
// set is non-trivial — i.e. probing actually narrows what gets skipped
// vs the default. A single failing rule here is a regression risk
// for downstream users running that rule under TSSLint.
{
	let plugin: any;
	try {
		plugin = require('@typescript-eslint/eslint-plugin');
	}
	catch {
		console.log('  skip - full-plugin probe (plugin not installed)');
	}
	if (plugin?.rules) {
		// Mirror the production probe stub from index.ts. Deliberately
		// bare — rules that need real parserServices/scope state crash
		// here, which (in production) triggers the ALL_SKIPPABLE
		// fallback. That fallback is load-bearing: it also protects
		// rules whose visitor body walks INTO type subtrees from a
		// non-skipped parent (e.g. TSAsExpression listeners reading
		// node.typeAnnotation). A stronger stub would lower probe
		// failure but expose those latent crashes.
		const stubContext: any = {
			cwd: '/',
			getCwd: () => '/',
			filename: '/probe.ts',
			getFilename: () => '/probe.ts',
			physicalFilename: '/probe.ts',
			getPhysicalFilename: () => '/probe.ts',
			sourceCode: undefined,
			getSourceCode: () => undefined,
			settings: {},
			parserOptions: {},
			languageOptions: { parserOptions: {} },
			parserPath: undefined,
			id: 'probe',
			options: [{}, {}, {}],
			report: () => {},
			getAncestors: () => [],
			getDeclaredVariables: () => [],
			getScope: () => undefined,
			markVariableAsUsed: () => false,
		};
		const ruleNames = Object.keys(plugin.rules);
		const allSelectors: string[] = [];
		const failures: { rule: string; selector: string; err: string }[] = [];
		let createCrashes = 0;
		for (const name of ruleNames) {
			const rule = plugin.rules[name];
			let listeners: Record<string, unknown> | undefined;
			try {
				listeners = rule.create(stubContext) as Record<string, unknown>;
			}
			catch {
				createCrashes++;
				continue;
			}
			if (!listeners) continue;
			for (const sel of Object.keys(listeners)) {
				try {
					skip.configureSkipKindsForVisitors([sel]);
					allSelectors.push(sel);
				}
				catch (err) {
					failures.push({ rule: name, selector: sel, err: (err as Error).message.split('\n')[0] });
				}
			}
		}
		check(
			`full-plugin: every selector parses (${ruleNames.length} rules, ${allSelectors.length} selectors)`,
			failures.length === 0,
			failures.length ? `first failure: ${failures[0].rule} → ${failures[0].selector} (${failures[0].err})` : '',
		);
		// Probing is supposed to NARROW the skip set vs the default. If no
		// rule listens on any TS-only kind, our optimisation is moot.
		// `consistent-type-imports`, `no-explicit-any` etc. should at minimum
		// drag in TSAnyKeyword + TSImportType + TSTypeReference.
		skip.configureSkipKindsForVisitors(allSelectors);
		const sf = parseTs('let x: any = 1;');
		const { estree } = skip.astConvertSkipTypes(sf, PARSE_SETTINGS as any, true);
		check(
			'full-plugin: aggregate exemption preserves TSAnyKeyword',
			countNodes(estree, 'TSAnyKeyword') === 1,
		);
		// Crash count is intentionally non-zero — the bare stub forces
		// rules with real parserServices preconditions to fail probing,
		// which triggers the conservative fallback in production. We
		// only care that probing succeeds for ENOUGH rules to learn
		// non-trivial selector contributions; the count itself is just
		// info.
		console.log(`  info  - ${createCrashes}/${ruleNames.length} rules crashed under stub (probe falls back conservatively in prod)`);
	}
}

// --- Done ---------------------------------------------------------------

console.log(`\n${failures.length === 0 ? 'all pass' : `${failures.length} FAILED`}`);
process.exit(failures.length === 0 ? 0 : 1);
