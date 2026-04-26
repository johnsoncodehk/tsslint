// Selector-aware traversal — Phase B.
//
// ESLint's built-in traverser walks every visitor key on every node. Each
// `node[key]` access on a LazyNode materialises the child. So the lazy
// shim's biggest potential win — not paying for subtrees no rule cares
// about — is currently nullified.
//
// Strategy: hardcode the set of "type-only" root types (TSTypeAnnotation,
// TSTypeAliasDeclaration, TSInterfaceDeclaration) and the closed reach of
// types that can appear inside those subtrees. When the rules' aggregated
// trigger set has no overlap with the type-only reach, we don't recurse
// into type-only subtrees at all — we still emit enter/leave for the root
// (so selectors that name the root itself fire), but the body is
// invisible.
//
// We DO NOT skip CodePathAnalyzer-required traversal: any rule registering
// `onCodePath*` listeners forces a full walk via the original ESLint
// traverser (caller decides via TriggerSet.isAll).
//
// The eventQueue we produce is the same shape ESLint's SourceCode.traverse
// returns — array of VisitNodeStep / CallMethodStep — so the existing
// runSharedTraversal replay loop is unchanged.

import type { TriggerSet } from './selector-analysis';

// VisitNodeStep is in @eslint/plugin-kit, which ESLint depends on.
// Resolve through ESLint to match its version exactly (the step
// constructor must produce instances ESLint's downstream code accepts).
const pluginKitPath = require.resolve('@eslint/plugin-kit', {
	paths: [require.resolve('eslint/package.json')],
});
const { VisitNodeStep } = require(pluginKitPath) as {
	VisitNodeStep: new (init: { target: unknown; phase: 1 | 2; args: unknown[] }) => unknown;
};

// Subtrees rooted at these types contain ONLY:
//   - TS-prefixed types listed in TYPE_ONLY_REACH below
//   - Identifier (type names: T, Foo)
//   - Literal (TSLiteralType.literal)
//   - UnaryExpression (TSLiteralType: `-1`)
//   - TemplateLiteral / TemplateElement (TSTemplateLiteralType, TSLiteralType)
//
// Conservative — only the most common type-context roots. TSEnumDeclaration
// and TSModuleDeclaration are excluded because they contain JS Expressions
// (TSEnumMember.initializer, TSModuleBlock.body Statements).
export const TYPE_ONLY_ROOTS: ReadonlySet<string> = new Set([
	'TSTypeAnnotation',
	'TSTypeAliasDeclaration',
	'TSInterfaceDeclaration',
]);

// All types that can appear inside a TYPE_ONLY_ROOTS subtree. Soundness
// requirement: every type that COULD appear in such a subtree MUST be in
// this set, otherwise rules listening for that type would silently miss
// matches.
//
// Excluded TS types (they appear outside type-only contexts):
//   TSAsExpression, TSSatisfiesExpression, TSTypeAssertion,
//   TSNonNullExpression, TSInstantiationExpression  (expression flavors)
//   TSEnumDeclaration, TSEnumBody, TSEnumMember     (have Expression
//                                                     initializers)
//   TSModuleDeclaration, TSModuleBlock              (statements)
//   TSImportEqualsDeclaration, TSExternalModuleReference, TSExportAssignment,
//   TSNamespaceExportDeclaration                    (top-level decls)
//   TSDeclareFunction, TSEmptyBodyFunctionExpression (function-shaped)
//   TSAbstractMethodDefinition, TSAbstractPropertyDefinition,
//   TSAbstractAccessorProperty, TSParameterProperty (class-member-flavored)
export const TYPE_ONLY_REACH: ReadonlySet<string> = new Set([
	// All TS leaf-keyword types
	'TSAbstractKeyword', 'TSAnyKeyword', 'TSAsyncKeyword', 'TSBigIntKeyword',
	'TSBooleanKeyword', 'TSDeclareKeyword', 'TSExportKeyword',
	'TSIntrinsicKeyword', 'TSNeverKeyword', 'TSNullKeyword',
	'TSNumberKeyword', 'TSObjectKeyword', 'TSPrivateKeyword',
	'TSProtectedKeyword', 'TSPublicKeyword', 'TSReadonlyKeyword',
	'TSStaticKeyword', 'TSStringKeyword', 'TSSymbolKeyword',
	'TSThisType', 'TSUndefinedKeyword', 'TSUnknownKeyword', 'TSVoidKeyword',
	// Composite TS types found inside type-only subtrees
	'TSArrayType', 'TSCallSignatureDeclaration', 'TSClassImplements',
	'TSConditionalType', 'TSConstructSignatureDeclaration',
	'TSConstructorType', 'TSFunctionType', 'TSImportType',
	'TSIndexSignature', 'TSIndexedAccessType', 'TSInferType',
	'TSInterfaceBody', 'TSInterfaceDeclaration', 'TSInterfaceHeritage',
	'TSIntersectionType', 'TSLiteralType', 'TSMappedType',
	'TSMethodSignature', 'TSNamedTupleMember', 'TSOptionalType',
	'TSPropertySignature', 'TSQualifiedName', 'TSRestType',
	'TSTemplateLiteralType', 'TSTupleType', 'TSTypeAliasDeclaration',
	'TSTypeAnnotation', 'TSTypeLiteral', 'TSTypeOperator',
	'TSTypeParameter', 'TSTypeParameterDeclaration',
	'TSTypeParameterInstantiation', 'TSTypePredicate', 'TSTypeQuery',
	'TSTypeReference', 'TSUnionType',
	// Non-TS types that can appear inside type contexts
	'Identifier',          // type names: T, Foo
	'Literal',             // TSLiteralType
	'UnaryExpression',     // TSLiteralType: -1
	'TemplateLiteral',     // TSLiteralType, TSTemplateLiteralType
	'TemplateElement',
]);

export interface TraverseOptions {
	visitorKeys: Record<string, readonly string[] | undefined>;
	fallbackKeys: (node: object) => string[];
	triggers: TriggerSet;
}

// Pre-compute once per (TriggerSet, file) — really once per process since
// triggers are stable. Returns true if any type that could appear in a
// type-only subtree is also a trigger. When true, we cannot skip
// type-only subtrees.
export function triggersOverlapTypeOnly(triggers: TriggerSet): boolean {
	if (triggers.isAll()) return true;
	for (const t of TYPE_ONLY_REACH) {
		if (triggers.matches(t)) return true;
	}
	return false;
}

// Drop-in replacement for ESLint's SourceCode.traverse() — produces the
// same VisitNodeStep array, except it skips recursion into TYPE_ONLY_ROOTS
// when no trigger is in TYPE_ONLY_REACH.
//
// IMPORTANT: this skips CodePathAnalyzer wiring. Callers MUST detect
// onCodePath* listeners and fall back to ESLint's traverser when present.
// We don't run CPA here at all — only AST enter/leave events.
export function selectorAwareTraverse(
	root: object,
	options: TraverseOptions,
): unknown[] {
	const steps: unknown[] = [];
	const skipTypeOnly = !triggersOverlapTypeOnly(options.triggers);

	// We can also skip selector-matching at non-trigger types — but that's
	// the NodeEventGenerator's responsibility downstream. We just emit the
	// same enter/leave events ESLint would.

	const visit = (node: object, parent: object | null): void => {
		// save parent on the node like SourceCode.traverse does
		(node as { parent?: object | null }).parent = parent;

		steps.push(new VisitNodeStep({ target: node, phase: 1 as const, args: [node] }));

		// Decide whether to recurse into this node's children.
		const type = (node as { type: string }).type;
		const skipChildren = skipTypeOnly && TYPE_ONLY_ROOTS.has(type);

		if (!skipChildren) {
			const keys = options.visitorKeys[type] ?? options.fallbackKeys(node);
			for (const key of keys) {
				const child = (node as Record<string, unknown>)[key];
				if (Array.isArray(child)) {
					for (let i = 0; i < child.length; i++) {
						const c = child[i];
						if (isNode(c)) visit(c, node);
					}
				} else if (isNode(child)) {
					visit(child, node);
				}
			}
		}

		steps.push(new VisitNodeStep({ target: node, phase: 2 as const, args: [node] }));
	};

	visit(root, null);
	return steps;
}

function isNode(x: unknown): x is { type: string } {
	return x != null && typeof x === 'object' && typeof (x as { type?: unknown }).type === 'string';
}
