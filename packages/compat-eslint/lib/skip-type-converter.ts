// Selector-aware ESTree materialize, MVP. Most TSSLint rules don't traverse
// TS-only type subtrees (TSTypeReference, TSUnionType, etc.) — they query
// types via `parserServices.program.getTypeChecker()`. Skipping the
// conversion of those subtrees saves both convert time and ESLint traversal
// time, since `null` children stop the traverser from descending.
//
// Approach: monkey-patch typescript-estree's Converter prototype so its
// central `converter()` returns null for TS-only kinds. The ESTree tree
// then has `typeAnnotation: null` etc., which ESLint's traverser skips.
//
// Caveat: identifiers inside skipped type subtrees still appear in
// TsScopeManager's reference list (since it walks TS, not ESTree). When
// rules read `ref.identifier.parent`, they need a believable parent —
// `setSyntheticTypeParents` walks back up the TS chain, building a stub
// ESTree-shaped parent so `.parent.type` etc. don't crash.

import ts = require('typescript');
import path = require('path');

const tseRoot = path.dirname(require.resolve('@typescript-eslint/typescript-estree/package.json'));
const { astConverter } = require(tseRoot + '/dist/ast-converter.js') as typeof import('@typescript-eslint/typescript-estree/use-at-your-own-risk');
const { Converter } = require(tseRoot + '/dist/convert.js') as {
	Converter: { prototype: { converter: (...args: any[]) => any; }; };
};

// SyntaxKind ↔ ESTree TSXxx name. The forward direction (kind → name) feeds
// `buildSyntheticParent` below. The reverse direction (name → kind) lets the
// caller exempt kinds from skipping by passing AST_NODE_TYPE strings (which
// is what rules' visitors are written against).
const SK = ts.SyntaxKind;
const KIND_TO_TS_NAME: Partial<Record<ts.SyntaxKind, string>> = {
	[SK.TypeReference]: 'TSTypeReference',
	[SK.TypeLiteral]: 'TSTypeLiteral',
	[SK.ArrayType]: 'TSArrayType',
	[SK.TupleType]: 'TSTupleType',
	[SK.OptionalType]: 'TSOptionalType',
	[SK.RestType]: 'TSRestType',
	[SK.NamedTupleMember]: 'TSNamedTupleMember',
	[SK.UnionType]: 'TSUnionType',
	[SK.IntersectionType]: 'TSIntersectionType',
	[SK.ConditionalType]: 'TSConditionalType',
	[SK.InferType]: 'TSInferType',
	[SK.ParenthesizedType]: 'TSParenthesizedType',
	[SK.ThisType]: 'TSThisType',
	[SK.TypeOperator]: 'TSTypeOperator',
	[SK.IndexedAccessType]: 'TSIndexedAccessType',
	[SK.MappedType]: 'TSMappedType',
	[SK.LiteralType]: 'TSLiteralType',
	[SK.TemplateLiteralType]: 'TSTemplateLiteralType',
	[SK.TemplateLiteralTypeSpan]: 'TSTemplateLiteralType',
	[SK.TypePredicate]: 'TSTypePredicate',
	[SK.TypeQuery]: 'TSTypeQuery',
	[SK.ImportType]: 'TSImportType',
	[SK.FunctionType]: 'TSFunctionType',
	[SK.ConstructorType]: 'TSConstructorType',
	[SK.ConstructSignature]: 'TSConstructSignatureDeclaration',
	[SK.CallSignature]: 'TSCallSignatureDeclaration',
	[SK.IndexSignature]: 'TSIndexSignature',
	[SK.MethodSignature]: 'TSMethodSignature',
	[SK.PropertySignature]: 'TSPropertySignature',
	[SK.TypeAliasDeclaration]: 'TSTypeAliasDeclaration',
	[SK.AnyKeyword]: 'TSAnyKeyword',
	[SK.UnknownKeyword]: 'TSUnknownKeyword',
	[SK.NeverKeyword]: 'TSNeverKeyword',
	[SK.NumberKeyword]: 'TSNumberKeyword',
	[SK.BigIntKeyword]: 'TSBigIntKeyword',
	[SK.StringKeyword]: 'TSStringKeyword',
	[SK.BooleanKeyword]: 'TSBooleanKeyword',
	[SK.SymbolKeyword]: 'TSSymbolKeyword',
	[SK.ObjectKeyword]: 'TSObjectKeyword',
	[SK.UndefinedKeyword]: 'TSUndefinedKeyword',
	[SK.NullKeyword]: 'TSNullKeyword',
	[SK.VoidKeyword]: 'TSVoidKeyword',
	[SK.IntrinsicKeyword]: 'TSIntrinsicKeyword',
};

// Default skip set — TS SyntaxKinds whose ESTree counterpart is type-only and
// not meaningful to most rules. NOT skipped: TypeAliasDeclaration /
// InterfaceDeclaration themselves (their `export` modifier matters to
// no-unused-vars), even though they appear in KIND_TO_TS_NAME above.
const DEFAULT_SKIP_KINDS: ReadonlySet<ts.SyntaxKind> = new Set([
	SK.TypeReference, SK.TypeLiteral, SK.ArrayType, SK.TupleType, SK.OptionalType,
	SK.RestType, SK.NamedTupleMember, SK.UnionType, SK.IntersectionType,
	SK.ConditionalType, SK.InferType, SK.ParenthesizedType, SK.ThisType,
	SK.TypeOperator, SK.IndexedAccessType, SK.MappedType, SK.LiteralType,
	SK.TemplateLiteralType, SK.TemplateLiteralTypeSpan, SK.TypePredicate,
	SK.TypeQuery, SK.ImportType, SK.FunctionType, SK.ConstructorType,
	SK.ConstructSignature, SK.CallSignature, SK.IndexSignature, SK.MethodSignature,
	SK.PropertySignature, SK.AnyKeyword, SK.UnknownKeyword, SK.NeverKeyword,
	SK.NumberKeyword, SK.BigIntKeyword, SK.StringKeyword, SK.BooleanKeyword,
	SK.SymbolKeyword, SK.ObjectKeyword, SK.UndefinedKeyword, SK.NullKeyword,
	SK.VoidKeyword, SK.IntrinsicKeyword,
]);

// Active skip set — mutated by `configureSkipKindsForVisitors` based on which
// AST_NODE_TYPEs registered rules listen on. Starts as the default; callers
// who don't probe rules retain the original behaviour.
let skipKinds: ReadonlySet<ts.SyntaxKind> = DEFAULT_SKIP_KINDS;

// Every AST_NODE_TYPE that the default skip would drop. Callers use this as
// a conservative "exempt everything" set when rule probing fails — passing
// it to `configureSkipKindsForVisitors` disables skipping entirely.
export const ALL_SKIPPABLE_AST_NODE_TYPES: readonly string[] = (() => {
	const out: string[] = [];
	for (const kind of DEFAULT_SKIP_KINDS) {
		const name = KIND_TO_TS_NAME[kind];
		if (name) out.push(name);
	}
	return out;
})();

export function isSkippedKind(kind: ts.SyntaxKind): boolean {
	return skipKinds.has(kind);
}

// Parse a selector with esquery and walk the resulting AST to pull out
// every node-type identifier — i.e. selectors like `TSAnyKeyword`,
// `TSTypeReference > Identifier`, `:matches(A, B)`. Attribute filters,
// regex literals, string literals, and other esquery node types are
// ignored, so we don't pick up false-positive PascalCase tokens that
// happen to live inside `[name="Foo"]` or `[name=/^[A-Z]/]`.
//
// Returns true if the selector contains a wildcard (`*`) — caller uses
// that to short-circuit to "exempt all skippable kinds".
//
// Throws on invalid selectors. ESLint's runtime would fail the same
// rule when it tried to apply the selector, so failing here gives
// clearer attribution (this rule, this selector) than silently
// degrading by exempting everything.
const esquery = require('esquery') as { parse(s: string): any; };
function extractAstNodeTypes(selector: string, into: Set<string>): boolean {
	const parsed = esquery.parse(selector);
	let hasWildcard = false;
	const walk = (n: any): void => {
		if (!n || typeof n !== 'object') return;
		if (n.type === 'identifier') into.add(n.value);
		else if (n.type === 'wildcard') hasWildcard = true;
		// Recurse into every container shape esquery emits: matches/not/has
		// hold `selectors`, combinators hold `left`/`right`, etc. We just
		// walk every object-typed property — `parent`/`loc` aren't present
		// in esquery's AST so the no-cycle assumption holds.
		for (const k in n) {
			const v = n[k];
			if (Array.isArray(v)) for (const c of v) walk(c);
			else if (v && typeof v === 'object') walk(v);
		}
	};
	walk(parsed);
	return hasWildcard;
}

// Adjust the active skip set so any TS kind whose ESTree counterpart is
// referenced by one of `selectors` gets DROPPED from the skip set — i.e.
// the converter will produce real ESTree nodes for those kinds, so rule
// visitors registered on them fire normally. `selectors` are raw listener
// keys exactly as rules' `create()` returns them: plain type names like
// `'TSAnyKeyword'`, with optional `:exit`, esquery combinators, attribute
// filters, etc. Call once after rule registration, before the first
// `astConvertSkipTypes` call. Repeat calls re-derive from the default —
// not cumulative — so the active set always matches the latest rule mix.
//
// A wildcard (`*`) anywhere in any selector forces "exempt all skippable
// kinds" — `*` matches every node, so we can't serve it while skipping
// any subtree.
export function configureSkipKindsForVisitors(selectors: Iterable<string>): void {
	const visited = new Set<string>();
	let wildcard = false;
	for (const sel of selectors) {
		if (extractAstNodeTypes(sel, visited)) {
			wildcard = true;
		}
	}
	if (wildcard) {
		skipKinds = new Set();
		return;
	}
	const next = new Set(DEFAULT_SKIP_KINDS);
	for (const kindStr of Object.keys(KIND_TO_TS_NAME)) {
		const kind = Number(kindStr) as ts.SyntaxKind;
		const name = KIND_TO_TS_NAME[kind]!;
		if (visited.has(name)) next.delete(kind);
	}
	skipKinds = next;
}

// Patch Converter.prototype.converter once on first call. The patched method
// short-circuits TS-only kinds before they enter `convertNode`. The active
// skip set is read each call so reconfiguration takes effect immediately.
let patched = false;
function ensurePatched() {
	if (patched) return;
	patched = true;
	const orig = Converter.prototype.converter;
	Converter.prototype.converter = function(node: ts.Node | undefined, parent: ts.Node | undefined, allowPattern: boolean) {
		if (node && skipKinds.has(node.kind)) return null;
		return orig.call(this, node, parent, allowPattern);
	};
}

export const astConvertSkipTypes: typeof astConverter = (ast, parseSettings, shouldPreserveNodeMaps) => {
	ensurePatched();
	return astConverter(ast, parseSettings, shouldPreserveNodeMaps);
};

// --- Synthetic parent chain for identifiers in skipped subtrees -----------

interface StubNode {
	type: string;
	parent?: StubNode | object;
	range: [number, number];
}

// Build (and cache) the synthetic ESTree-shaped chain leading up from a
// skipped TS node, ending at the first ancestor whose ESTree counterpart
// was kept by the converter. The result is wired in as the `parent` of
// the lazy-stub Identifier returned by TsReference.
const stubCache = new WeakMap<ts.Node, StubNode | object>();

export function buildSyntheticParent(
	tsNode: ts.Node,
	tsNodeToESTreeNodeMap: WeakMap<ts.Node, object>,
): StubNode | object | undefined {
	const direct = tsNodeToESTreeNodeMap.get(tsNode);
	if (direct) return direct;
	const cached = stubCache.get(tsNode);
	if (cached) return cached;
	const typeName = KIND_TO_TS_NAME[tsNode.kind] ?? 'TSStubNode';
	const stub: StubNode = {
		type: typeName,
		range: [tsNode.getStart(), tsNode.getEnd()],
	};
	stubCache.set(tsNode, stub);
	if (tsNode.parent) {
		stub.parent = buildSyntheticParent(tsNode.parent, tsNodeToESTreeNodeMap);
	}
	return stub;
}
