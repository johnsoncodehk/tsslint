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

// TS SyntaxKinds that are 100% in type position. Their conversion produces
// TSXxx ESTree nodes that ESLint core rules and TSSLint rules don't read.
const SKIP_KINDS = new Set<ts.SyntaxKind>([
	ts.SyntaxKind.TypeReference,
	ts.SyntaxKind.TypeLiteral,
	ts.SyntaxKind.ArrayType,
	ts.SyntaxKind.TupleType,
	ts.SyntaxKind.OptionalType,
	ts.SyntaxKind.RestType,
	ts.SyntaxKind.NamedTupleMember,
	ts.SyntaxKind.UnionType,
	ts.SyntaxKind.IntersectionType,
	ts.SyntaxKind.ConditionalType,
	ts.SyntaxKind.InferType,
	ts.SyntaxKind.ParenthesizedType,
	ts.SyntaxKind.ThisType,
	ts.SyntaxKind.TypeOperator,
	ts.SyntaxKind.IndexedAccessType,
	ts.SyntaxKind.MappedType,
	ts.SyntaxKind.LiteralType,
	ts.SyntaxKind.TemplateLiteralType,
	ts.SyntaxKind.TemplateLiteralTypeSpan,
	ts.SyntaxKind.TypePredicate,
	ts.SyntaxKind.TypeQuery,
	ts.SyntaxKind.ImportType,
	ts.SyntaxKind.FunctionType,
	ts.SyntaxKind.ConstructorType,
	ts.SyntaxKind.ConstructSignature,
	ts.SyntaxKind.CallSignature,
	ts.SyntaxKind.IndexSignature,
	ts.SyntaxKind.MethodSignature,
	ts.SyntaxKind.PropertySignature,
	// NOT skipped: TypeAliasDeclaration / InterfaceDeclaration. Their names are
	// statement-level bindings that ESLint rules (no-unused-vars) check via
	// the export modifier on the declaration node. Skipping the whole
	// declaration would hide that modifier and produce false positives.
	// Keyword type nodes
	ts.SyntaxKind.AnyKeyword,
	ts.SyntaxKind.UnknownKeyword,
	ts.SyntaxKind.NeverKeyword,
	ts.SyntaxKind.NumberKeyword,
	ts.SyntaxKind.BigIntKeyword,
	ts.SyntaxKind.StringKeyword,
	ts.SyntaxKind.BooleanKeyword,
	ts.SyntaxKind.SymbolKeyword,
	ts.SyntaxKind.ObjectKeyword,
	ts.SyntaxKind.UndefinedKeyword,
	ts.SyntaxKind.NullKeyword,
	ts.SyntaxKind.VoidKeyword,
	ts.SyntaxKind.IntrinsicKeyword,
]);

export function isSkippedKind(kind: ts.SyntaxKind): boolean {
	return SKIP_KINDS.has(kind);
}

// Patch Converter.prototype.converter once on first call. The patched method
// short-circuits TS-only kinds before they enter `convertNode`.
let patched = false;
function ensurePatched() {
	if (patched) return;
	patched = true;
	const orig = Converter.prototype.converter;
	Converter.prototype.converter = function(node: ts.Node | undefined, parent: ts.Node | undefined, allowPattern: boolean) {
		if (node && SKIP_KINDS.has(node.kind)) return null;
		return orig.call(this, node, parent, allowPattern);
	};
}

export const astConvertSkipTypes: typeof astConverter = (ast, parseSettings, shouldPreserveNodeMaps) => {
	ensurePatched();
	return astConverter(ast, parseSettings, shouldPreserveNodeMaps);
};

// --- Synthetic parent chain for identifiers in skipped subtrees -----------

// Map a few common TS SyntaxKinds to their ESTree TSXxx node `type` name —
// just enough for `parent.type === '...'` checks to evaluate. Anything not
// listed falls back to a generic 'TSStubNode'.
const TS_TYPE_NAMES: Partial<Record<ts.SyntaxKind, string>> = {
	[ts.SyntaxKind.TypeReference]: 'TSTypeReference',
	[ts.SyntaxKind.TypeLiteral]: 'TSTypeLiteral',
	[ts.SyntaxKind.ArrayType]: 'TSArrayType',
	[ts.SyntaxKind.TupleType]: 'TSTupleType',
	[ts.SyntaxKind.UnionType]: 'TSUnionType',
	[ts.SyntaxKind.IntersectionType]: 'TSIntersectionType',
	[ts.SyntaxKind.ConditionalType]: 'TSConditionalType',
	[ts.SyntaxKind.InferType]: 'TSInferType',
	[ts.SyntaxKind.ParenthesizedType]: 'TSParenthesizedType',
	[ts.SyntaxKind.TypeOperator]: 'TSTypeOperator',
	[ts.SyntaxKind.IndexedAccessType]: 'TSIndexedAccessType',
	[ts.SyntaxKind.MappedType]: 'TSMappedType',
	[ts.SyntaxKind.LiteralType]: 'TSLiteralType',
	[ts.SyntaxKind.TypeQuery]: 'TSTypeQuery',
	[ts.SyntaxKind.TypePredicate]: 'TSTypePredicate',
	[ts.SyntaxKind.ImportType]: 'TSImportType',
	[ts.SyntaxKind.FunctionType]: 'TSFunctionType',
	[ts.SyntaxKind.ConstructorType]: 'TSConstructorType',
	[ts.SyntaxKind.TypeAliasDeclaration]: 'TSTypeAliasDeclaration',
	[ts.SyntaxKind.PropertySignature]: 'TSPropertySignature',
	[ts.SyntaxKind.MethodSignature]: 'TSMethodSignature',
	[ts.SyntaxKind.CallSignature]: 'TSCallSignatureDeclaration',
	[ts.SyntaxKind.ConstructSignature]: 'TSConstructSignatureDeclaration',
	[ts.SyntaxKind.IndexSignature]: 'TSIndexSignature',
	[ts.SyntaxKind.NamedTupleMember]: 'TSNamedTupleMember',
	[ts.SyntaxKind.OptionalType]: 'TSOptionalType',
	[ts.SyntaxKind.RestType]: 'TSRestType',
	[ts.SyntaxKind.ThisType]: 'TSThisType',
};

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
	const typeName = TS_TYPE_NAMES[tsNode.kind] ?? 'TSStubNode';
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
