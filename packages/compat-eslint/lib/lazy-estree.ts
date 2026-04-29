// Lazy ESTree shim — direct translation of @typescript-eslint/typescript-estree's
// `Converter.convertNode` switch into per-SyntaxKind classes whose child slots
// are getters. The first time a rule reads a child slot, the child is converted
// recursively; otherwise it never materialises. Solves the "walk-into-skipped"
// correctness problem of the previous skip-type-converter approach: there is
// no skip — there is just deferred conversion.
//
// Reference: typescript-estree `dist/convert.js` line 480 (convertNode switch).
// Each `case SK.X: return this.createNode(node, { type, ...children });` becomes
// a class with primitive fields populated in the constructor and child slots
// exposed via getter+memo.
//
// MVP scope: only the kinds needed to lint the smoke fixtures end-to-end. Add
// more cases on demand. An unhandled kind throws a descriptive error so we
// know which to add next.
//
// Bottom-up materialise (`materialize(tsNode, ctx)`): walks up TS parent chain
// to find / build the ESTree parent, then constructs the requested node.
// TS-node identity in the cache means siblings reuse a shared parent: if
// child_a's walk-up registered tsParent → parentInstance, then child_b's
// walk-up hits the cache and links to the same parentInstance.
//
// KNOWN LIMITATION: synthetic wrapper nodes break the symmetry between the
// TS and ESTree parent chains. Today the only wrapper is TSTypeAnnotation
// (sits between an Identifier-with-type and the underlying type subtree).
// The TS parent chain skips it (`type` is just a field on VariableDeclaration);
// a top-down build threads the wrapper in via `VariableDeclarator.id`'s
// getter. A bottom-up materialise of a node inside the wrapper currently
// lands on the wrapper-less parent instead. Fix when needed: detect "this
// TS node sits in a `type`/`returnType`/etc. slot" at materialise time, and
// route through the parent's getter that builds the wrapper. Tracked by a
// test that asserts the top-down behaviour; bottom-up is unverified for
// these positions.

import * as ts from 'typescript';

const SK = ts.SyntaxKind;

export interface LazyAstMaps {
	// One direction is a real WeakMap (cache for tsNode → lazyNode lookup).
	// The other is a thin facade that just reads `lazyNode._ts` directly,
	// avoiding ~9k WeakMap.set calls per file. Profile showed WeakMap was
	// 18% of materialise time; halving the ops drops that to ~10%.
	esTreeNodeToTSNodeMap: {
		get(node: object): ts.Node | undefined;
		has(node: object): boolean;
		set(node: object, tsNode: ts.Node): unknown;
	};
	tsNodeToESTreeNodeMap: WeakMap<ts.Node, object>;
}

// Facade for esTreeNodeToTSNodeMap — every LazyNode has _ts, so we
// don't need to track this in a separate WeakMap. The set() is a no-op
// because the constructor already wired _ts; consumers calling
// astMaps.esTreeNodeToTSNodeMap.set(...) at runtime is rare and
// previously redundant.
const ESTREE_TO_TS_FACADE = {
	get(node: object): ts.Node | undefined {
		return (node as { _ts?: ts.Node })._ts;
	},
	has(node: object): boolean {
		return (node as { _ts?: ts.Node })._ts != null;
	},
	set() {
		return this;
	},
};

export interface ConvertContext {
	ast: ts.SourceFile;
	maps: LazyAstMaps;
}

// Shared empty array used as the default for readonly array-typed fields
// (Identifier.decorators, ImportDeclaration.attributes/specifiers, etc.).
// Each `[]` literal is a fresh allocation; on hot paths like Identifier
// (~120k per checker.ts lintOnce) those wasted empty arrays add up.
// Frozen so callers can't mutate the shared instance.
const EMPTY_ARRAY: never[] = Object.freeze([]) as never[];

function getLocFor(ast: ts.SourceFile, start: number, end: number) {
	const startLC = ast.getLineAndCharacterOfPosition(start);
	const endLC = ast.getLineAndCharacterOfPosition(end);
	return {
		start: { line: startLC.line + 1, column: startLC.character },
		end: { line: endLC.line + 1, column: endLC.character },
	};
}

abstract class LazyNode {
	abstract readonly type: string;
	parent: LazyNode | null;
	_ts: ts.Node;
	// Conversion context shared with descendants. Children created via getter
	// inherit this from the parent — the root sets it from `convertLazy`.
	// Public so the module-level `convertChild` can read it; underscore prefix
	// signals "internal".
	_ctx: ConvertContext;

	// `range` and `loc` are lazy — TS's `getStart` (skipTrivia +
	// getTokenPosOfNode) and `getLineAndCharacterOfPosition` are 5-7% of
	// hot-path time per the profiler. Most rules never read `.loc`; many
	// don't read `.range`. Defer until read.
	private _range?: [number, number];
	get range(): [number, number] {
		return this._range ??= [this._ts.getStart(this._ctx.ast), this._ts.getEnd()];
	}
	// Mutating range invalidates the cached loc — the lazy getter
	// recomputes from the new range on next read. Constructors should
	// only set `range`; `loc` is computed on demand.
	set range(v: [number, number]) {
		this._range = v;
		this._loc = undefined;
	}
	private _loc?: ReturnType<typeof getLocFor>;
	get loc() {
		return this._loc ??= getLocFor(this._ctx.ast, this.range[0], this.range[1]);
	}
	set loc(v: ReturnType<typeof getLocFor>) {
		this._loc = v;
	}

	constructor(tsNode: ts.Node, parent: LazyNode | null, context?: ConvertContext, registerInMaps = true) {
		this._ts = tsNode;
		this.parent = parent;
		this._ctx = context ?? parent!._ctx;
		// Synthetic wrapper nodes (TSTypeAnnotation) shouldn't claim the TS
		// node's map slot — that slot belongs to the inner converted node.
		if (registerInMaps) {
			this._ctx.maps.tsNodeToESTreeNodeMap.set(tsNode, this);
			// esTreeNodeToTSNodeMap is a facade reading _ts — no .set needed.
		}
	}

	// Extend this node's range to cover `childRange`. Used by parent nodes
	// that absorb a child's range (e.g. Identifier swallowing its
	// typeAnnotation, matching typescript-estree's `fixParentLocation`).
	// Forces range realisation, but if the child also has eager range
	// (it usually does after a getter call), this stays cheap.
	protected _extendRange(childRange: [number, number]) {
		const r = this.range;
		if (childRange[0] < r[0]) r[0] = childRange[0];
		if (childRange[1] > r[1]) r[1] = childRange[1];
		// Invalidate cached loc — will recompute next .loc read.
		this._loc = undefined;
	}
}

// If `tsNode` sits in a slot where the ESTree path goes through a synthetic
// wrapper (e.g. `VariableDeclaration.type` is exposed as
// `VariableDeclarator.id.typeAnnotation` — a TSTypeAnnotation wrapper that
// has no TS counterpart), return a route describing how to trigger the
// wrapper's construction. Bottom-up materialisation can't reach `tsNode`
// directly via the TS parent chain because the wrapper isn't on it; the
// only way to build the wrapper (and register `tsNode`'s ESTree counterpart
// in the cache) is to access the parent's slot getter that creates it.
//
// Add a case here whenever a new lazy class introduces a synthetic-wrapper
// slot. Without this, bottom-up of a node inside the wrapper produces a
// `parent` reference pointing at the wrapper-less ESTree parent — a
// silently-wrong shape.
//
// Owner unwrapping: bottom-up materialise looks up an owner ts.Node in the
// cache, but a wrapper may sit at that key:
//   - ExportNamedWrappingNode / ExportDefaultWrappingNode wrap an inner
//     declaration via `.declaration`.
//   - TSParameterPropertyNode wraps the parameter via `.parameter`.
//   - AssignmentPatternNode wraps the binding name via `.left` (when a
//     parameter has a default value).
// Each wrapper-route trigger walks past these to reach the slot it needs.
function unwrapInner(node: LazyNode): LazyNode {
	const inner = (node as unknown as { declaration?: LazyNode }).declaration;
	return inner ?? node;
}

// True when `tsNode` is a destructuring-target literal — `[…]` / `{…}` on
// the LHS of an `=` BinaryExpression, the init of for-of/for-in, or
// nested inside another pattern-position container. Used by
// findWrapperRoute to route pattern-position literals through the
// parent's pattern getter so `materialize()` returns the ArrayPattern /
// ObjectPattern variant rather than the expression variant.
function isPatternLiteralTarget(tsNode: ts.Node): boolean {
	if (tsNode.kind !== SK.ArrayLiteralExpression && tsNode.kind !== SK.ObjectLiteralExpression) {
		return false;
	}
	let cur: ts.Node = tsNode;
	while (cur.parent) {
		const p = cur.parent;
		if (
			p.kind === SK.ArrayLiteralExpression
			|| p.kind === SK.ObjectLiteralExpression
			|| p.kind === SK.SpreadElement
			|| p.kind === SK.SpreadAssignment
			|| p.kind === SK.PropertyAssignment
			|| p.kind === SK.ShorthandPropertyAssignment
			|| p.kind === SK.ParenthesizedExpression
		) {
			cur = p;
			continue;
		}
		if (p.kind === SK.BinaryExpression) {
			const be = p as ts.BinaryExpression;
			return be.operatorToken.kind === SK.EqualsToken && be.left === cur;
		}
		if (p.kind === SK.ForInStatement || p.kind === SK.ForOfStatement) {
			return (p as ts.ForInStatement | ts.ForOfStatement).initializer === cur;
		}
		return false;
	}
	return false;
}

// Class / interface / enum member kinds — used by `materialize` to
// decide when to drill from a cached wrapper (ClassDeclaration,
// TSInterfaceDeclaration, TSEnumDeclaration) into its synthetic body
// container (ClassBody, TSInterfaceBody, TSEnumBody) so members'
// `parent` resolves to the body rather than the declaration.
const CLASS_MEMBER_KINDS_SET = (() => {
	const a = new Uint8Array(400);
	for (
		const k of [
			SK.PropertyDeclaration,
			SK.MethodDeclaration,
			SK.Constructor,
			SK.GetAccessor,
			SK.SetAccessor,
			SK.IndexSignature,
			SK.SemicolonClassElement,
			SK.ClassStaticBlockDeclaration,
		]
	) a[k] = 1;
	return a;
})();
const INTERFACE_MEMBER_KINDS_SET = (() => {
	const a = new Uint8Array(400);
	for (
		const k of [
			SK.PropertySignature,
			SK.MethodSignature,
			SK.IndexSignature,
			SK.ConstructSignature,
			SK.CallSignature,
			SK.GetAccessor,
			SK.SetAccessor,
		]
	) a[k] = 1;
	return a;
})();

// Bitmap of parent kinds that can possibly trigger a wrapper-route. If
// tsParent.kind is NOT in this set, findWrapperRoute returns null without
// running the if-chain. Most tree-walks land on parents like
// SourceFile / Block / ReturnStatement / BinaryExpression-but-not-LHS — none
// of which appear here — so this catches the vast majority of calls.
const WRAPPER_ROUTE_PARENT_BITMAP = (() => {
	const a = new Uint8Array(400);
	for (
		const k of [
			SK.BinaryExpression,
			SK.ForOfStatement,
			SK.ForInStatement,
			SK.ArrayLiteralExpression,
			SK.ObjectLiteralExpression,
			SK.PropertyAssignment,
			SK.ShorthandPropertyAssignment,
			SK.SpreadElement,
			SK.SpreadAssignment,
			SK.ParenthesizedExpression,
			SK.VariableDeclaration,
			SK.Parameter,
			SK.FunctionDeclaration,
			SK.FunctionExpression,
			SK.ArrowFunction,
		]
	) a[k] = 1;
	return a;
})();

// Bitmap of child kinds that can possibly be on the wrapper-routed side:
// either a TypeNode (routed via VariableDecl/Parameter/FunctionLike `.type`)
// or a pattern-target literal/spread (routed via parent's pattern getter).
// Other kinds (statements, value expressions, declarations) cannot be
// wrapper-routed and short-circuit immediately after the parent check.
const WRAPPER_ROUTE_CHILD_BITMAP = (() => {
	const a = new Uint8Array(400);
	// TypeNode kinds — anything that can sit in a `.type` slot.
	for (
		const k of [
			// Keyword types
			SK.AnyKeyword,
			SK.BigIntKeyword,
			SK.BooleanKeyword,
			SK.IntrinsicKeyword,
			SK.NeverKeyword,
			SK.NumberKeyword,
			SK.ObjectKeyword,
			SK.StringKeyword,
			SK.SymbolKeyword,
			SK.UndefinedKeyword,
			SK.UnknownKeyword,
			SK.VoidKeyword,
			// Composite types
			SK.TypeReference,
			SK.FunctionType,
			SK.ConstructorType,
			SK.TypeQuery,
			SK.TypeLiteral,
			SK.ArrayType,
			SK.TupleType,
			SK.OptionalType,
			SK.RestType,
			SK.UnionType,
			SK.IntersectionType,
			SK.ConditionalType,
			SK.InferType,
			SK.ParenthesizedType,
			SK.ThisType,
			SK.TypeOperator,
			SK.IndexedAccessType,
			SK.MappedType,
			SK.LiteralType,
			SK.NamedTupleMember,
			SK.TemplateLiteralType,
			SK.TemplateLiteralTypeSpan,
			SK.ImportType,
			SK.TypePredicate,
		]
	) a[k] = 1;
	// Pattern-target literals / spreads (`[…] = x`, `{…} = x`, `...x`).
	for (
		const k of [
			SK.ArrayLiteralExpression,
			SK.ObjectLiteralExpression,
			SK.SpreadElement,
			SK.SpreadAssignment,
		]
	) a[k] = 1;
	return a;
})();

// JSX tag-name / attribute-name route: walk up from a ts.Identifier (or
// PropertyAccessExpression / JsxNamespacedName) looking for the JSX
// container that owns the chain. Trigger drills into the JSX-aware
// getter (`name`, `openingElement.name`, `namespace`/`name` for
// JsxNamespacedName) which builds JSXIdentifier / JSXMemberExpression /
// JSXNamespacedName and registers each inner ts.Node in the cache.
function findJSXOwnerRoute(tsNode: ts.Node):
	| { ownerTsNode: ts.Node; trigger: (owner: LazyNode) => void }
	| null
{
	const k = tsNode.kind;
	if (
		k !== SK.Identifier
		&& k !== SK.PropertyAccessExpression
		&& k !== SK.JsxNamespacedName
	) {
		return null;
	}
	let cur: ts.Node = tsNode;
	while (cur.parent) {
		const p = cur.parent;
		if (
			p.kind === SK.JsxOpeningElement
			|| p.kind === SK.JsxSelfClosingElement
			|| p.kind === SK.JsxClosingElement
		) {
			if ((p as ts.JsxOpeningElement).tagName !== cur) return null;
			return {
				ownerTsNode: p,
				trigger: owner => {
					// JsxSelfClosingElement materializes to JSXElement; the
					// JSXOpeningElement (which owns the `name` slot) lives
					// inside it.
					if (p.kind === SK.JsxSelfClosingElement) {
						const opening = (owner as unknown as { openingElement?: { name?: unknown } }).openingElement;
						if (opening) void opening.name;
					}
					else {
						void (owner as unknown as { name?: unknown }).name;
					}
				},
			};
		}
		if (p.kind === SK.JsxAttribute) {
			if ((p as ts.JsxAttribute).name !== cur) return null;
			return {
				ownerTsNode: p,
				trigger: owner => void (owner as unknown as { name?: unknown }).name,
			};
		}
		if (p.kind === SK.PropertyAccessExpression) {
			// Continue up the chain — outer link will hit the JSX owner.
			// Only the `.expression` slot is part of the chain; `.name` is
			// always a leaf (the property), so a node sitting there is
			// inside the chain too — keep walking.
			cur = p;
			continue;
		}
		if (p.kind === SK.JsxNamespacedName) {
			cur = p;
			continue;
		}
		return null;
	}
	return null;
}

function findTypeArgRoute(tsNode: ts.Node):
	| { ownerTsNode: ts.Node; trigger: (owner: LazyNode) => void }
	| null
{
	const tsParent = tsNode.parent;
	if (!tsParent) return null;
	const k = tsParent.kind;
	let typeArgs: ts.NodeArray<ts.TypeNode> | undefined;
	switch (k) {
		case SK.TypeReference:
			typeArgs = (tsParent as ts.TypeReferenceNode).typeArguments;
			break;
		case SK.ImportType:
			typeArgs = (tsParent as ts.ImportTypeNode).typeArguments;
			break;
		case SK.NewExpression:
			typeArgs = (tsParent as ts.NewExpression).typeArguments;
			break;
		case SK.TaggedTemplateExpression:
			typeArgs = (tsParent as ts.TaggedTemplateExpression).typeArguments;
			break;
		case SK.ExpressionWithTypeArguments:
			typeArgs = (tsParent as ts.ExpressionWithTypeArguments).typeArguments;
			break;
		case SK.CallExpression:
			typeArgs = (tsParent as ts.CallExpression).typeArguments;
			break;
		case SK.JsxOpeningElement:
		case SK.JsxSelfClosingElement:
			typeArgs = (tsParent as ts.JsxOpeningElement | ts.JsxSelfClosingElement).typeArguments;
			break;
		default:
			return null;
	}
	if (!typeArgs || typeArgs.indexOf(tsNode as ts.TypeNode) < 0) return null;
	return {
		ownerTsNode: tsParent,
		trigger: owner => {
			// JsxSelfClosingElement materialises to JSXElement; the
			// `typeArguments` slot lives on its inner JSXOpeningElement.
			if (k === SK.JsxSelfClosingElement) {
				const opening =
					(owner as unknown as { openingElement?: { typeArguments?: { params?: unknown } } }).openingElement;
				const ta = opening?.typeArguments;
				if (ta) void ta.params;
				return;
			}
			const ta = (owner as unknown as { typeArguments?: { params?: unknown } }).typeArguments;
			if (ta) void ta.params;
		},
	};
}

function findWrapperRoute(tsNode: ts.Node):
	| { ownerTsNode: ts.Node; trigger: (owner: LazyNode) => void }
	| null
{
	const tsParent = tsNode.parent;
	if (!tsParent) return null;

	// JSX: ts.Identifier / ts.PropertyAccessExpression / ts.JsxNamespacedName
	// sitting on a JSX tag-name path or JsxAttribute name path must
	// materialize via the parent's JSX-aware getter (which produces
	// JSXIdentifier / JSXMemberExpression / JSXNamespacedName). The
	// regular convertChildInner path produces plain Identifier /
	// MemberExpression — wrong shape.
	{
		const jsx = findJSXOwnerRoute(tsNode);
		if (jsx) return jsx;
	}

	// Type-arg wrapper: a TypeNode sitting in a `typeArguments` array on
	// CallExpression / NewExpression / TaggedTemplate / TypeReference /
	// ImportType / ExpressionWithTypeArguments / JsxOpeningElement /
	// JsxSelfClosingElement. typescript-estree wraps these in
	// TSTypeParameterInstantiation. Bottom-up materialize without this
	// route lands `inner.parent` on the typeArgs-bearing host directly,
	// missing the wrapper layer.
	{
		const typeArg = findTypeArgRoute(tsNode);
		if (typeArg) return typeArg;
	}
	// `<T>` generics — typescript-estree wraps the typeParameters array in a
	// synthetic TSTypeParameterDeclaration, so a direct bottom-up build for
	// the inner TypeParameter would set its parent to the function/class
	// instead of the wrapper. Trigger the host's `typeParameters` getter
	// (drilling past Method/Property/Export wrappers to reach the actual
	// host slot) and then `.params` so each inner TypeParameter is registered
	// in the cache. Without this, no-shadow's `isTypeParameterOfStaticMethod`
	// reads `variable.identifiers[0].parent.parent` expecting
	// TSTypeParameterDeclaration and fails (the missing wrapper layer means
	// the static-method-generic shadow filter never fires).
	if (tsNode.kind === SK.TypeParameter) {
		// Hosts whose ESTree shape exposes `<T>` via a `typeParameters`
		// TSTypeParameterDeclaration wrapper. ts.MappedType uses a singular
		// `typeParameter` on a different shape; skip the route there so the
		// regular bottom-up build runs.
		const pk = tsParent.kind;
		const isFunctionLike = pk === SK.FunctionDeclaration || pk === SK.FunctionExpression
			|| pk === SK.ArrowFunction || pk === SK.MethodDeclaration || pk === SK.Constructor
			|| pk === SK.GetAccessor || pk === SK.SetAccessor
			|| pk === SK.CallSignature || pk === SK.ConstructSignature
			|| pk === SK.MethodSignature || pk === SK.IndexSignature
			|| pk === SK.FunctionType || pk === SK.ConstructorType;
		const isDeclLike = pk === SK.ClassDeclaration || pk === SK.ClassExpression
			|| pk === SK.InterfaceDeclaration || pk === SK.TypeAliasDeclaration;
		if (isFunctionLike || isDeclLike) {
			return {
				ownerTsNode: tsParent,
				trigger: owner => {
					const inner = unwrapInner(owner);
					let host = inner as unknown as { value?: unknown; typeParameters?: { params?: unknown } };
					const innerType = (inner as { type?: string }).type;
					if (
						innerType === 'MethodDefinition'
						|| innerType === 'TSAbstractMethodDefinition'
						|| innerType === 'Property'
					) {
						const v = (inner as { value?: { typeParameters?: { params?: unknown } } }).value;
						if (v) host = v;
					}
					const tp = host.typeParameters;
					if (tp) void tp.params;
				},
			};
		}
	}
	if (WRAPPER_ROUTE_PARENT_BITMAP[tsParent.kind] !== 1) return null;
	if (WRAPPER_ROUTE_CHILD_BITMAP[tsNode.kind] !== 1) return null;

	// Pattern-position literal: route through parent's pattern getter.
	// `[…] = …` / `{…} = …`     — parent is BinaryExpression, owner.left is the pattern slot.
	// `for ([…] of …)` / for-in — parent is ForOf/ForInStatement, owner.left.
	// nested inside another literal/spread/property — parent's elements/properties getter.
	if (isPatternLiteralTarget(tsNode)) {
		if (tsParent.kind === SK.BinaryExpression) {
			return {
				ownerTsNode: tsParent,
				trigger: owner => {
					void (owner as unknown as { left?: unknown }).left;
				},
			};
		}
		if (tsParent.kind === SK.ForInStatement || tsParent.kind === SK.ForOfStatement) {
			return {
				ownerTsNode: tsParent,
				trigger: owner => {
					void (owner as unknown as { left?: unknown }).left;
				},
			};
		}
		if (tsParent.kind === SK.ArrayLiteralExpression) {
			return {
				ownerTsNode: tsParent,
				trigger: owner => {
					void (owner as unknown as { elements?: unknown }).elements;
				},
			};
		}
		if (tsParent.kind === SK.ObjectLiteralExpression) {
			return {
				ownerTsNode: tsParent,
				trigger: owner => {
					void (owner as unknown as { properties?: unknown }).properties;
				},
			};
		}
		if (tsParent.kind === SK.PropertyAssignment) {
			return {
				ownerTsNode: tsParent,
				trigger: owner => {
					void (owner as unknown as { value?: unknown }).value;
				},
			};
		}
		if (tsParent.kind === SK.ShorthandPropertyAssignment) {
			return {
				ownerTsNode: tsParent,
				trigger: owner => {
					void (owner as unknown as { value?: unknown }).value;
				},
			};
		}
		if (tsParent.kind === SK.SpreadElement || tsParent.kind === SK.SpreadAssignment) {
			return {
				ownerTsNode: tsParent,
				trigger: owner => {
					void (owner as unknown as { argument?: unknown }).argument;
				},
			};
		}
		if (tsParent.kind === SK.ParenthesizedExpression) {
			// ParenthesizedExpression is collapsed by the converter — its
			// child reuses the parent's slot. Walk up one more.
			return findWrapperRoute(tsParent);
		}
	}
	// SpreadElement / SpreadAssignment in pattern position: route through
	// the enclosing pattern-position literal (its .elements / .properties
	// getter uses convertChildAsPattern, which builds RestElementFromSpread).
	if (
		(tsNode.kind === SK.SpreadElement || tsNode.kind === SK.SpreadAssignment)
		&& (tsParent.kind === SK.ArrayLiteralExpression || tsParent.kind === SK.ObjectLiteralExpression)
		&& isPatternLiteralTarget(tsParent)
	) {
		const slot = tsParent.kind === SK.ArrayLiteralExpression ? 'elements' : 'properties';
		return {
			ownerTsNode: tsParent,
			trigger: owner => {
				void (owner as unknown as Record<string, unknown>)[slot];
			},
		};
	}
	// `let x: T = ...` — VariableDeclaration.type goes through Identifier.typeAnnotation
	if (tsParent.kind === SK.VariableDeclaration && (tsParent as ts.VariableDeclaration).type === tsNode) {
		return {
			ownerTsNode: tsParent,
			trigger: owner => {
				// Chain through `id` (builds Identifier + TSTypeAnnotation
				// wrapper) then `typeAnnotation` (the wrapper's own getter,
				// which finally calls convertChild on the inner type and
				// registers it in the cache).
				const id = (owner as unknown as { id: unknown }).id as { typeAnnotation: { typeAnnotation: unknown } } | null;
				if (id?.typeAnnotation) {
					void id.typeAnnotation.typeAnnotation;
				}
			},
		};
	}
	// `function f(x: T)` — Parameter.type goes through the Identifier
	// returned by convertParameter, which carries `typeAnnotation`. The
	// owner cache slot may hold AssignmentPatternNode (default value) or
	// TSParameterPropertyNode (`private x: T`); drill through to the
	// binding name to reach `.typeAnnotation`.
	if (tsParent.kind === SK.Parameter && (tsParent as ts.ParameterDeclaration).type === tsNode) {
		return {
			ownerTsNode: tsParent,
			trigger: owner => {
				let cur = owner as unknown as {
					parameter?: { left?: unknown; typeAnnotation?: unknown };
					left?: unknown;
					typeAnnotation?: unknown;
				};
				if (cur.parameter) cur = cur.parameter;
				if (cur.left) cur = cur.left;
				const ta = cur.typeAnnotation as { typeAnnotation: unknown } | undefined;
				if (ta) void ta.typeAnnotation;
			},
		};
	}
	// `function f(): T` / `(): T => ...` — function-like return type goes
	// through the function node's `returnType` getter (a TSTypeAnnotation
	// wrapper). Owner may be ExportNamedWrappingNode etc. when the
	// declaration is exported (`export function f(): T`); unwrap first.
	if (
		(tsParent.kind === SK.FunctionDeclaration
			|| tsParent.kind === SK.FunctionExpression
			|| tsParent.kind === SK.ArrowFunction)
		&& (tsParent as ts.SignatureDeclaration).type === tsNode
	) {
		return {
			ownerTsNode: tsParent,
			trigger: owner => {
				const inner = unwrapInner(owner);
				const rt = (inner as unknown as { returnType?: { typeAnnotation: unknown } }).returnType;
				if (rt) void rt.typeAnnotation;
			},
		};
	}
	return null;
}

// No upstream equivalent. typescript-estree converts the entire program
// eagerly (`convertProgram`); every TS node has its ESTree counterpart
// before any rule runs. Compat-eslint's lazy shim builds ESTree nodes
// on demand, in two flows that must converge:
//
//   - Top-down: a parent's children getter calls `convertChild(tsChild,
//     this)` per slot, which builds the child and registers it in
//     `tsNodeToESTreeNodeMap`.
//   - Bottom-up: scope-manager's `tsToEstreeOrStub(tsNode)` calls
//     `materialize(tsNode, ctx)` to walk UP the parent chain looking
//     for a cached ancestor, then builds DOWN to the requested node.
//
// The cache keyed on TS node identity is what makes the two flows
// converge: child_b walking up hits the same tsParent in the cache
// that child_a's walk-up (or the parent's top-down build) registered.
// Both end up with the same parent ESTree instance.
//
// The contract: every input ts.Node yields a non-undefined LazyNode.
// Unsupported kinds + null `convertChild` returns + parent-chain
// exhaustion all fall back to GenericTSNode (synthetic, with
// `type: 'TS<KindName>'` for diagnostic visibility). Without that
// contract rules reading `def.node.parent.type` would crash.
//
// Wrapper-routed slots: see `findWrapperRoute`.
export function materialize(tsNode: ts.Node, ctx: ConvertContext): LazyNode {
	const cached = ctx.maps.tsNodeToESTreeNodeMap.get(tsNode);
	if (cached) return cached as LazyNode;
	// If our TS parent reaches us through a synthetic wrapper, route via the
	// parent's slot getter rather than constructing directly. The getter
	// builds the wrapper AND registers our inner ESTree counterpart in the
	// cache as a side-effect, so we can then return it through the cache
	// path on the next line.
	const route = findWrapperRoute(tsNode);
	if (route) {
		const owner = materialize(route.ownerTsNode, ctx);
		route.trigger(owner);
		const result = ctx.maps.tsNodeToESTreeNodeMap.get(tsNode);
		if (!result) {
			throw new Error(`lazy-estree: wrapper route for ${SK[tsNode.kind]} did not register the inner node`);
		}
		return result as LazyNode;
	}
	// Walk up the TS parent chain iteratively, collecting nodes that need
	// building. Stops at the first cached ancestor (e.g. SourceFile, which
	// convertLazy always pre-registers) — or at any ancestor that itself
	// requires a wrapper route, in which case we fall back to the recursive
	// path for that one node.
	//
	// One walk + one downward build replaces N recursive `materialize()`
	// calls. Saves N-1 frame setups, N-1 redundant per-call cache lookups,
	// and the parameter-passing overhead between layers.
	const toBuild: ts.Node[] = [tsNode];
	let walker: ts.Node | undefined = tsNode.parent;
	let parent: LazyNode | null = null;
	const tsCache = ctx.maps.tsNodeToESTreeNodeMap;
	while (walker) {
		const wk = walker.kind;
		// Structural-only TS kinds with no ESTree counterpart in their
		// usual position — walker skips past so the child's parent
		// resolves to the next-level real ESTree ancestor.
		// - SyntaxList: marker only.
		// - CaseBlock: SwitchStatement.cases jumps directly to clauses
		//   in ESTree, so SwitchCase's parent is SwitchStatement.
		// - VariableDeclarationList: only structural inside a VariableStatement
		//   (folded into VariableDeclaration). When standalone (for-init in
		//   `for (var x in y)` etc.) it maps to ESTree VariableDeclaration via
		//   VariableDeclarationListAsNode — keep that mapping.
		// - NamedImports / ImportClause: ImportSpecifier / ImportDefault-
		//   Specifier / ImportNamespaceSpecifier all sit directly under
		//   ImportDeclaration in ESTree (specifiers[]), so a bottom-up
		//   walk from any specifier should land on the ImportDeclaration
		//   wrapper rather than building intermediate generic nodes.
		if (
			wk === SK.SyntaxList
			|| wk === SK.CaseBlock
			|| wk === SK.NamedImports
			|| wk === SK.ImportClause
			|| (wk === SK.VariableDeclarationList && walker.parent?.kind === SK.VariableStatement)
		) {
			walker = walker.parent;
			continue;
		}
		// `class B extends A` — typescript-estree elides the
		// HeritageClause + ExpressionWithTypeArguments wrappers and lifts
		// the inner expression directly into ClassDeclaration.superClass.
		// Without skipping these on the bottom-up walk, materialize trips
		// on HeritageClause's null convertChild result and returns a
		// GenericTSNode instead of building the inner Identifier — every
		// rule that walks `parent.type` from a superclass identifier sees
		// the wrong shape (id-length, no-shadow, etc.). `implements` clauses
		// stay wrapped in TSClassImplements (typescript-estree's
		// `convertHeritageClauses`), so we only skip when the heritage
		// token is `extends`.
		if (
			wk === SK.HeritageClause
			&& (walker as ts.HeritageClause).token === SK.ExtendsKeyword
		) {
			walker = walker.parent;
			continue;
		}
		if (
			wk === SK.ExpressionWithTypeArguments
			&& walker.parent?.kind === SK.HeritageClause
			&& (walker.parent as ts.HeritageClause).token === SK.ExtendsKeyword
		) {
			walker = walker.parent;
			continue;
		}
		const cachedAnc = tsCache.get(walker);
		if (cachedAnc) {
			parent = cachedAnc as LazyNode;
			// Wrapper drill-through: the cached ESTree may wrap the actual
			// parent because the wrapper has synthetic intermediate slots
			// without TS counterparts. The TS-up-walk lands on the wrapper;
			// drill in based on which slot the child is in.
			//
			// 1. Class members (Method/Property/Static block etc.) under
			//    ts.ClassDeclaration/Expression: ESTree puts them in
			//    `ClassBody.body`. Without drill, `node.parent` reads as
			//    ClassDeclaration, so `node.parent.parent` skips one level
			//    and rules using `parent.parent.<class-prop>` (e.g.
			//    no-useless-constructor: `parent.parent.superClass`) miss.
			// 2. Interface / Enum members: same pattern via TSInterfaceBody /
			//    TSEnumBody.
			// 3. ts.Parameter cached as TSParameterProperty: AssignmentPattern
			//    (default value) sits at `wrapper.parameter`, so a child
			//    landing on the parameter's `initializer` slot must take
			//    AssignmentPattern as its parent. Without this, CPA's
			//    `processCodePathToEnter` for AssignmentPattern checks
			//    `parent.right === node` to push a fork context, the check
			//    fails (TSParameterProperty has no `.right`), the push is
			//    skipped, and the matching pop on `AssignmentPattern:exit`
			//    crashes in `popForkContext` reading null `replaceHead`.
			//    Repro: `class A { constructor(public x: number = 0) {} }`.
			const innermostChild = toBuild.length > 0 ? toBuild[toBuild.length - 1] : tsNode;
			const wk = walker.kind;
			// Unwrap Export wrappers first — for `export class Foo {}` the
			// cache holds ExportNamedDeclaration { declaration: ClassDecl },
			// and class members live inside the inner declaration's body.
			let drillFrom: LazyNode = parent;
			let drillType = (drillFrom as { type?: string }).type;
			while (drillType === 'ExportNamedDeclaration' || drillType === 'ExportDefaultDeclaration') {
				const decl = (drillFrom as unknown as { declaration?: LazyNode }).declaration;
				if (!decl) break;
				drillFrom = decl;
				drillType = (drillFrom as { type?: string }).type;
			}
			// Default after Export-unwrap: the child's parent is the inner
			// declaration, not the Export wrapper. Without this, parameters of
			// `export function f(x)` resolve `parent` as ExportNamedDeclaration
			// instead of FunctionDeclaration — id-length, no-param-reassign,
			// and any rule reading `param.parent.type === 'FunctionDeclaration'`
			// silently miss. Specific further drills (class body, function
			// value, etc.) override below.
			if (drillFrom !== parent) parent = drillFrom;
			if (
				(wk === SK.ClassDeclaration || wk === SK.ClassExpression)
				&& CLASS_MEMBER_KINDS_SET[innermostChild.kind] === 1
			) {
				const body = (drillFrom as unknown as { body?: LazyNode }).body;
				if (body) parent = body;
			}
			else if (
				wk === SK.InterfaceDeclaration
				&& INTERFACE_MEMBER_KINDS_SET[innermostChild.kind] === 1
			) {
				const body = (drillFrom as unknown as { body?: LazyNode }).body;
				if (body) parent = body;
			}
			else if (
				wk === SK.EnumDeclaration
				&& innermostChild.kind === SK.EnumMember
			) {
				const body = (drillFrom as unknown as { body?: LazyNode }).body;
				if (body) parent = body;
			}
			else if (
				wk === SK.Parameter
				&& drillType === 'TSParameterProperty'
				&& innermostChild === (walker as ts.ParameterDeclaration).initializer
			) {
				const ap = (drillFrom as unknown as { parameter?: LazyNode }).parameter;
				if (ap && (ap as { type?: string }).type === 'AssignmentPattern') {
					parent = ap;
				}
			}
			else if (
				(drillType === 'MethodDefinition' || drillType === 'TSAbstractMethodDefinition')
				&& (wk === SK.MethodDeclaration || wk === SK.Constructor
					|| wk === SK.GetAccessor || wk === SK.SetAccessor)
			) {
				// Children of ts.MethodDeclaration/Constructor/GetAccessor/
				// SetAccessor map onto FunctionExpression slots (params, body,
				// returnType, typeParameters) EXCEPT for `name` (the method key).
				// Drill into `value` for the function-expression slots.
				const namedChild = wk !== SK.Constructor
					? (walker as ts.MethodDeclaration | ts.GetAccessorDeclaration | ts.SetAccessorDeclaration).name
					: undefined;
				if (innermostChild !== namedChild) {
					const value = (drillFrom as unknown as { value?: LazyNode }).value;
					if (value) parent = value;
				}
			}
			else if (
				drillType === 'Property'
				&& (wk === SK.MethodDeclaration || wk === SK.GetAccessor || wk === SK.SetAccessor)
			) {
				const namedChild =
					(walker as ts.MethodDeclaration | ts.GetAccessorDeclaration | ts.SetAccessorDeclaration).name;
				if (innermostChild !== namedChild) {
					const value = (drillFrom as unknown as { value?: LazyNode }).value;
					if (value) parent = value;
				}
			}
			else if (
				wk === SK.BindingElement
				&& (walker as ts.BindingElement).initializer !== undefined
				&& walker.parent?.kind === SK.ObjectBindingPattern
				&& innermostChild === (walker as ts.BindingElement).name
			) {
				// `const { x = 1 } = o` — typescript-estree wraps the
				// BindingElement's name in AssignmentPattern when the element
				// has a default. Top-down build does this via the value getter.
				// Bottom-up materialize for the inner name lands on the
				// BindingElement's Property wrapper directly without the
				// AssignmentPattern between, so id-length /
				// no-shadow-restricted-names / etc. read parent.type as
				// 'Property' instead of 'AssignmentPattern' and miss. Trigger
				// `Property.value` to force the wrapper build, then route
				// parent through it.
				const v = (drillFrom as unknown as { value?: LazyNode }).value;
				if (v && (v as { type?: string }).type === 'AssignmentPattern') {
					parent = v;
				}
			}
			break;
		}
		// Wrapper-routed ancestors need the slow recursive path so the
		// trigger fires and registers the right wrapper. Hand off there.
		if (findWrapperRoute(walker)) {
			parent = materialize(walker, ctx);
			break;
		}
		toBuild.push(walker);
		walker = walker.parent;
	}
	if (!parent) {
		// No ESTree ancestor — should only happen for the SourceFile itself,
		// which convertLazy() always pre-registers. As a last resort, hand
		// back a generic node anchored to nothing. ctx is required because
		// the null parent gives the LazyNode constructor nothing to inherit
		// _ctx from.
		return new GenericTSNode(tsNode, null, ctx);
	}
	// Build downward: innermost element of `toBuild` is the original
	// tsNode, outermost is the closest ts.Node to the cached ancestor.
	// Iterate from the outer end inward, threading `parent` through.
	//
	// Cache check between iterations: convertChildInner can collapse a
	// wrapper kind into its inner (e.g. ArrayBindingPattern's
	// `BindingElement` returns `convertChild(be.name, parent)`, which
	// registers the inner Identifier in `tsNodeToESTreeNodeMap`). The
	// next iteration's child IS that inner Identifier — without the
	// cache check, we'd build a SECOND Identifier wrapping the first,
	// breaking `ref.identifier.parent.type` (parent reads as 'Identifier'
	// instead of 'ArrayPattern' / 'ObjectPattern'). prefer-const's
	// `getDestructuringHost` walks `id.parent` looking for a Pattern
	// type; the duplicate Identifier broke that walk and silently
	// dropped every destructure-binding report.
	const tsCache2 = ctx.maps.tsNodeToESTreeNodeMap;
	for (let i = toBuild.length - 1; i >= 0; i--) {
		const child = toBuild[i];
		let node = tsCache2.get(child) as LazyNode | undefined;
		if (!node) {
			node = convertChildInner(child, parent) ?? undefined;
			if (node && EXPORTABLE_KINDS.has(child.kind)) {
				node = maybeFixExports(child, node, parent) ?? undefined;
			}
		}
		if (!node) {
			// convertChild returns null for kinds with no ESTree counterpart
			// (HeritageClause, OmittedExpression, JsxText). Bottom-up
			// materialise wants SOMETHING rather than nothing.
			return new GenericTSNode(child, parent);
		}
		// Wrapper drill (downward variant): mirror the cache-hit drill above
		// so the next iteration's `convertChildInner(nextChild, parent)`
		// receives the synthetic body container as its parent. Hits when a
		// rule listens only on a class member kind and the enclosing
		// ts.ClassDeclaration was never materialised first — the member's
		// parent walk pushes both onto toBuild, and without this drill the
		// member's `parent` reads as ClassDeclaration, skipping ClassBody.
		// Same fix needed for TSInterfaceBody / TSEnumBody / and the
		// TSParameterProperty → AssignmentPattern case.
		let next: LazyNode = node;
		if (i > 0) {
			const nextChild = toBuild[i - 1];
			const nextChildKind = nextChild.kind;
			// Unwrap Export wrappers first — for `export class Foo {}` the
			// cache holds ExportNamedDeclaration { declaration: ClassDecl },
			// and class members live inside the inner declaration's body.
			let inner: LazyNode = node;
			let innerType = (inner as { type?: string }).type;
			while (innerType === 'ExportNamedDeclaration' || innerType === 'ExportDefaultDeclaration') {
				const decl = (inner as unknown as { declaration?: LazyNode }).declaration;
				if (!decl) break;
				inner = decl;
				innerType = (inner as { type?: string }).type;
			}
			// Default after Export-unwrap: child's parent is the inner
			// declaration, not the wrapper. Mirrors the cache-hit drill.
			if (inner !== node) next = inner;
			if (
				(innerType === 'ClassDeclaration' || innerType === 'ClassExpression')
				&& CLASS_MEMBER_KINDS_SET[nextChildKind] === 1
			) {
				const body = (inner as unknown as { body?: LazyNode }).body;
				if (body) next = body;
			}
			else if (
				innerType === 'TSInterfaceDeclaration'
				&& INTERFACE_MEMBER_KINDS_SET[nextChildKind] === 1
			) {
				const body = (inner as unknown as { body?: LazyNode }).body;
				if (body) next = body;
			}
			else if (
				innerType === 'TSEnumDeclaration'
				&& nextChildKind === SK.EnumMember
			) {
				const body = (inner as unknown as { body?: LazyNode }).body;
				if (body) next = body;
			}
			else if (
				innerType === 'TSParameterProperty'
				&& child.kind === SK.Parameter
				&& nextChild === (child as ts.ParameterDeclaration).initializer
			) {
				const ap = (inner as unknown as { parameter?: LazyNode }).parameter;
				if (ap && (ap as { type?: string }).type === 'AssignmentPattern') {
					next = ap;
				}
			}
			else if (
				(innerType === 'MethodDefinition' || innerType === 'TSAbstractMethodDefinition' || innerType === 'Property')
				&& (child.kind === SK.MethodDeclaration || child.kind === SK.Constructor
					|| child.kind === SK.GetAccessor || child.kind === SK.SetAccessor
					|| child.kind === SK.PropertyAssignment || child.kind === SK.ShorthandPropertyAssignment)
			) {
				// Children of ts method/constructor/accessor map onto
				// FunctionExpression slots EXCEPT for `name` (the key).
				const namedChild =
					(child.kind === SK.MethodDeclaration || child.kind === SK.GetAccessor || child.kind === SK.SetAccessor)
						? (child as ts.MethodDeclaration | ts.GetAccessorDeclaration | ts.SetAccessorDeclaration).name
						: child.kind === SK.PropertyAssignment
						? (child as ts.PropertyAssignment).name
						: child.kind === SK.ShorthandPropertyAssignment
						? (child as ts.ShorthandPropertyAssignment).name
						: undefined;
				if (nextChild !== namedChild) {
					const value = (inner as unknown as { value?: LazyNode }).value;
					if (value) next = value;
				}
			}
		}
		parent = next;
	}
	return parent;
}

// Kinds whose top-level form (`export function f` etc.) gets wrapped in
// ExportNamedDeclaration / ExportDefaultDeclaration via fixExports.
const EXPORTABLE_KINDS = new Set<ts.SyntaxKind>([
	SK.FunctionDeclaration,
	SK.VariableStatement,
	SK.ClassDeclaration,
	SK.InterfaceDeclaration,
	SK.TypeAliasDeclaration,
	SK.EnumDeclaration,
	SK.ModuleDeclaration,
	SK.ImportEqualsDeclaration,
]);

// typescript-estree's fixExports (line 2334): if an exportable declaration
// carries an `export` keyword, wrap the result in
// ExportNamedDeclaration / ExportDefaultDeclaration and shrink the inner
// declaration's range so it starts AFTER the keyword.
function maybeFixExports(tsNode: ts.Node, inner: LazyNode, parent: LazyNode): LazyNode {
	const modifiers = (tsNode as { modifiers?: ts.NodeArray<ts.ModifierLike> }).modifiers;
	if (!modifiers?.length || modifiers[0].kind !== SK.ExportKeyword) return inner;
	const exportKeyword = modifiers[0];
	const next = modifiers[1];
	const isDefault = next?.kind === SK.DefaultKeyword;

	// Adjust inner's range to start after `export` (or `export default`).
	const declStart = (isDefault ? next : exportKeyword).getEnd();
	let cursor = declStart;
	const text = parent._ctx.ast.text;
	while (cursor < text.length && /\s/.test(text[cursor])) cursor++;
	(inner as unknown as { range: [number, number] }).range = [cursor, inner.range[1]];

	const wrapperRange: [number, number] = [exportKeyword.getStart(parent._ctx.ast), inner.range[1]];
	if (isDefault) {
		return new ExportDefaultWrappingNode(tsNode, parent, inner, wrapperRange);
	}
	return new ExportNamedWrappingNode(tsNode, parent, inner, wrapperRange);
}

// Module-level allow-pattern stack. Mirrors typescript-estree's `allowPattern`
// instance state: assignment-style BinaryExpression / Parameter rest /
// destructuring-binding contexts set it true while converting their LHS,
// then restore. Inside that scope, ArrayLiteralExpression /
// ObjectLiteralExpression dispatch as ArrayPattern / ObjectPattern.
let allowPattern = false;

// Dispatch: TS SyntaxKind → lazy ESTree class. Returns null for null/undefined
// (matching typescript-estree's `converter()` early-exit on falsy input).
// Cached: if the same TS node has been converted before (e.g. via a parent's
// child slot then later via getDeclaredVariables), return the same instance.
function convertChild(child: ts.Node | undefined | null, parent: LazyNode): LazyNode | null {
	if (!child) return null;
	const cached = parent._ctx.maps.tsNodeToESTreeNodeMap.get(child);
	if (cached) return cached as LazyNode;
	const inner = convertChildInner(child, parent);
	if (inner && EXPORTABLE_KINDS.has(child.kind)) {
		return maybeFixExports(child, inner, parent);
	}
	return inner;
}

function convertChildAsPattern(child: ts.Node | undefined | null, parent: LazyNode): LazyNode | null {
	const prev = allowPattern;
	allowPattern = true;
	try {
		return convertChild(child, parent);
	}
	finally {
		allowPattern = prev;
	}
}

function convertChildInner(child: ts.Node, parent: LazyNode): LazyNode | null {
	switch (child.kind) {
		case SK.SourceFile:
			return new ProgramNode(child as ts.SourceFile, parent);
		case SK.Identifier:
			return new IdentifierNode(child as ts.Identifier, parent);
		case SK.VariableStatement:
			return new VariableDeclarationNode(child as ts.VariableStatement, parent);
		case SK.VariableDeclaration:
			return new VariableDeclaratorNode(child as ts.VariableDeclaration, parent);
		case SK.AsExpression:
			return new TSAsExpressionNode(child, parent);
		case SK.TypeReference:
			return new TSTypeReferenceNode(child, parent);
		case SK.NumericLiteral:
			return new LiteralNode(child as ts.NumericLiteral, parent);
		case SK.StringLiteral:
			return new LiteralNode(child as ts.StringLiteral, parent);
		case SK.ExpressionStatement:
			return new ExpressionStatementNode(child, parent);
		case SK.ReturnStatement:
			return new ReturnStatementNode(child, parent);
		case SK.Block:
			return new BlockStatementNode(child, parent);
		case SK.IfStatement:
			return new IfStatementNode(child, parent);
		case SK.BinaryExpression: {
			// Comma operator becomes ESTree SequenceExpression (matches
			// typescript-estree's `convertBinaryExpression`). All other
			// operators stay BinaryExpression / LogicalExpression /
			// AssignmentExpression via the BinaryLikeExpressionNode dispatch.
			const be = child as ts.BinaryExpression;
			if (be.operatorToken.kind === SK.CommaToken) {
				return new SequenceExpressionNode(be, parent);
			}
			return new BinaryLikeExpressionNode(be, parent);
		}
		case SK.PropertyAccessExpression:
			return wrapChainIfNeeded(
				new MemberExpressionNode(child as ts.PropertyAccessExpression, parent),
				child as ts.PropertyAccessExpression,
				parent,
			);
		case SK.ElementAccessExpression:
			return wrapChainIfNeeded(
				new MemberExpressionNode(child as ts.ElementAccessExpression, parent),
				child as ts.ElementAccessExpression,
				parent,
			);
		case SK.CallExpression: {
			const ce = child as ts.CallExpression;
			if (ce.expression.kind === SK.ImportKeyword) {
				return new ImportExpressionNode(ce, parent);
			}
			return wrapChainIfNeeded(new CallExpressionNode(ce, parent), ce, parent);
		}
		case SK.ClassStaticBlockDeclaration:
			return new StaticBlockNode(child, parent);
		case SK.MetaProperty:
			return new MetaPropertyNode(child as ts.MetaProperty, parent);
		case SK.TrueKeyword:
			return new BoolLiteralNode(child as ts.TrueLiteral, parent, true);
		case SK.FalseKeyword:
			return new BoolLiteralNode(child as ts.FalseLiteral, parent, false);
		case SK.FunctionDeclaration:
			return new FunctionDeclarationNode(child as ts.FunctionDeclaration, parent);
		case SK.FunctionExpression:
			return new FunctionExpressionNode(child as ts.FunctionExpression, parent);
		case SK.ArrowFunction:
			return new ArrowFunctionExpressionNode(child as ts.ArrowFunction, parent);
		case SK.Parameter:
			return convertParameter(child as ts.ParameterDeclaration, parent);
		case SK.ImportDeclaration:
			return new ImportDeclarationNode(child as ts.ImportDeclaration, parent);
		case SK.ImportSpecifier:
			return new ImportSpecifierNode(child as ts.ImportSpecifier, parent);
		case SK.NamespaceImport:
			return new ImportNamespaceSpecifierNode(child, parent);
		case SK.ImportClause:
			return new ImportDefaultSpecifierNode(child as ts.ImportClause, parent);
		case SK.ImportAttribute:
			return new ImportAttributeNode(child, parent);
		case SK.InterfaceDeclaration:
			return new TSInterfaceDeclarationNode(child as ts.InterfaceDeclaration, parent);
		case SK.PropertySignature:
			return new TSPropertySignatureNode(child as ts.PropertySignature, parent);
		case SK.MethodSignature:
			return new TSMethodSignatureNode(child as ts.MethodSignature, parent);
		case SK.FunctionType:
			return new TSFunctionTypeNode(child, parent);
		case SK.UnionType:
			return new TSUnionTypeNode(child, parent);
		case SK.IntersectionType:
			return new TSIntersectionTypeNode(child, parent);
		case SK.ArrayType:
			return new TSArrayTypeNode(child, parent);
		case SK.TypeLiteral:
			return new TSTypeLiteralNode(child, parent);
		case SK.TypeQuery:
			return new TSTypeQueryNode(child, parent);
		case SK.TypeOperator:
			return new TSTypeOperatorNode(child as ts.TypeOperatorNode, parent);
		case SK.IndexedAccessType:
			return new TSIndexedAccessTypeNode(child, parent);
		case SK.LiteralType:
			return convertLiteralType(child as ts.LiteralTypeNode, parent);
		case SK.ParenthesizedType:
			return convertChild((child as ts.ParenthesizedTypeNode).type, parent);
		case SK.ImportType: {
			// `typeof import('x')` — when isTypeOf, wrap in TSTypeQuery.
			const it = child as ts.ImportTypeNode;
			const inner = new TSImportTypeNode(it, parent);
			if (it.isTypeOf) {
				return new TSTypeQueryWrappingNode(it, parent, inner);
			}
			return inner;
		}
		case SK.QualifiedName:
			return new TSQualifiedNameNode(child, parent);
		case SK.CallSignature:
			return new TSCallishSignatureNode('TSCallSignatureDeclaration', child as ts.CallSignatureDeclaration, parent);
		case SK.ConstructSignature:
			return new TSCallishSignatureNode(
				'TSConstructSignatureDeclaration',
				child as ts.ConstructSignatureDeclaration,
				parent,
			);
		case SK.IndexSignature:
			return new TSIndexSignatureNode(child as ts.IndexSignatureDeclaration, parent);
		case SK.ExportDeclaration:
			return convertExportDeclaration(child as ts.ExportDeclaration, parent);
		case SK.ExportSpecifier:
			return new ExportSpecifierNode(child as ts.ExportSpecifier, parent);
		case SK.ExportAssignment:
			return convertExportAssignment(child as ts.ExportAssignment, parent);
		case SK.ImportEqualsDeclaration:
			return new TSImportEqualsDeclarationNode(child as ts.ImportEqualsDeclaration, parent);
		case SK.ExternalModuleReference:
			return new TSExternalModuleReferenceNode(child, parent);
		case SK.TypeAliasDeclaration:
			return new TSTypeAliasDeclarationNode(child as ts.TypeAliasDeclaration, parent);
		case SK.PrefixUnaryExpression:
			return new UnaryLikeExpressionNode(child as ts.PrefixUnaryExpression, parent, true);
		case SK.PostfixUnaryExpression:
			return new UnaryLikeExpressionNode(child as ts.PostfixUnaryExpression, parent, false);
		case SK.TypeOfExpression:
			return new TypeofExpressionNode(child, parent);
		case SK.NonNullExpression:
			return new TSNonNullExpressionNode(child, parent);
		case SK.TupleType:
			return new TSTupleTypeNode(child, parent);
		case SK.NamedTupleMember:
			return convertNamedTupleMember(child as ts.NamedTupleMember, parent);
		case SK.OptionalType:
			return new TSOptionalTypeNode(child, parent);
		case SK.RestType:
			return new TSRestTypeNode(child, parent);
		case SK.ConditionalExpression:
			return new ConditionalExpressionNode(child, parent);
		case SK.NewExpression:
			return new NewExpressionNode(child, parent);
		case SK.NoSubstitutionTemplateLiteral:
			return new NoSubstitutionTemplateNode(child, parent);
		case SK.TaggedTemplateExpression:
			return new TaggedTemplateExpressionNode(child, parent);
		case SK.SpreadElement:
			return allowPattern
				? new RestElementFromSpreadNode(child, parent)
				: new SpreadElementNode(child, parent);
		case SK.SpreadAssignment:
			return allowPattern
				? new RestElementFromSpreadNode(child, parent)
				: new SpreadElementNode(child, parent);
		case SK.ParenthesizedExpression:
			return convertChild((child as ts.ParenthesizedExpression).expression, parent);
		case SK.ArrayLiteralExpression:
			return allowPattern
				? new ArrayPatternFromLiteralNode(child, parent)
				: new ArrayExpressionNode(child, parent);
		case SK.ObjectLiteralExpression:
			return allowPattern
				? new ObjectPatternFromLiteralNode(child, parent)
				: new ObjectExpressionNode(child, parent);
		case SK.PropertyAssignment:
			return new PropertyAssignmentNode(child as ts.PropertyAssignment, parent);
		case SK.ShorthandPropertyAssignment:
			return new ShorthandPropertyNode(child, parent);
		case SK.ComputedPropertyName:
			return convertChild((child as ts.ComputedPropertyName).expression, parent);
		case SK.TemplateExpression:
			return new TemplateLiteralNode(child, parent);
		case SK.TemplateLiteralType:
			return new TSTemplateLiteralTypeNode(child, parent);
		case SK.RegularExpressionLiteral:
			return new RegExpLiteralNode(child as ts.RegularExpressionLiteral, parent);
		case SK.ThrowStatement:
			return new ThrowStatementNode(child, parent);
		case SK.TryStatement:
			return new TryStatementNode(child, parent);
		case SK.CatchClause:
			return new CatchClauseNode(child, parent);
		case SK.WhileStatement:
			return new WhileStatementNode(child, parent);
		case SK.DoStatement:
			return new DoWhileStatementNode(child, parent);
		case SK.ForStatement:
			return new ForStatementNode(child, parent);
		case SK.ForInStatement:
			return new ForInStatementNode(child, parent);
		case SK.ForOfStatement:
			return new ForOfStatementNode(child as ts.ForOfStatement, parent);
		case SK.SwitchStatement:
			return new SwitchStatementNode(child, parent);
		case SK.CaseClause:
			return new SwitchCaseNode(child, parent);
		case SK.DefaultClause:
			return new SwitchCaseNode(child, parent);
		case SK.BreakStatement:
			return new BreakOrContinueNode('BreakStatement', child as ts.BreakStatement, parent);
		case SK.ContinueStatement:
			return new BreakOrContinueNode('ContinueStatement', child as ts.ContinueStatement, parent);
		case SK.LabeledStatement:
			return new LabeledStatementNode(child, parent);
		case SK.EmptyStatement:
			return new EmptyStatementNode(child, parent);
		case SK.AwaitExpression:
			return new AwaitExpressionNode(child, parent);
		case SK.YieldExpression:
			return new YieldExpressionNode(child as ts.YieldExpression, parent);
		case SK.ClassDeclaration:
			return new ClassNode('ClassDeclaration', child as ts.ClassDeclaration, parent);
		case SK.ClassExpression:
			return new ClassNode('ClassExpression', child as ts.ClassExpression, parent);
		case SK.MethodDeclaration: {
			// In an ObjectLiteralExpression, a MethodDeclaration becomes a
			// Property with `method: true` and a FunctionExpression value
			// (eager line 845). In a class body, it stays a MethodDefinition.
			if (parent._ts.kind === SK.ObjectLiteralExpression) {
				return new ObjectMethodPropertyNode(child as ts.MethodDeclaration, parent);
			}
			return new MethodDefinitionNode(child as ts.MethodDeclaration, parent);
		}
		case SK.PropertyDeclaration: {
			const pd = child as ts.PropertyDeclaration;
			const isAbstract = !!pd.modifiers?.some(m => m.kind === SK.AbstractKeyword);
			const isAccessor = !!pd.modifiers?.some(m => m.kind === SK.AccessorKeyword);
			if (isAbstract && isAccessor) return new PropertyDefinitionNode(pd, parent, 'TSAbstractAccessorProperty');
			if (isAbstract) return new PropertyDefinitionNode(pd, parent, 'TSAbstractPropertyDefinition');
			if (isAccessor) return new PropertyDefinitionNode(pd, parent, 'AccessorProperty');
			return new PropertyDefinitionNode(pd, parent, 'PropertyDefinition');
		}
		case SK.Constructor:
			return new MethodDefinitionNode(child as ts.ConstructorDeclaration, parent);
		case SK.GetAccessor:
		case SK.SetAccessor: {
			// In an ObjectLiteralExpression, accessors become Property{kind:'get'/'set'}.
			if (parent._ts.kind === SK.ObjectLiteralExpression) {
				return new ObjectAccessorPropertyNode(child as ts.GetAccessorDeclaration | ts.SetAccessorDeclaration, parent);
			}
			return new MethodDefinitionNode(child as ts.GetAccessorDeclaration | ts.SetAccessorDeclaration, parent);
		}
		case SK.ArrayBindingPattern:
			return new ArrayPatternNode(child, parent);
		case SK.ObjectBindingPattern:
			return new ObjectPatternNode(child, parent);
		case SK.BindingElement: {
			// In ArrayBindingPattern, BindingElement resolves to the inner
			// name directly (or wrapped in RestElement if `...`). Only
			// inside ObjectBindingPattern does it become a Property
			// (matches eager line 992 split).
			const be = child as ts.BindingElement;
			if (parent._ts.kind === SK.ArrayBindingPattern) {
				if (be.dotDotDotToken) {
					return new RestElementNode(be, parent);
				}
				if (be.initializer) {
					// `[a = 1] = ...` — AssignmentPattern wrapping the name.
					const inner = convertChild(be.name, parent);
					if (!inner) return null;
					return new BindingAssignmentPatternNode(be, parent, inner);
				}
				return convertChild(be.name, parent);
			}
			return new BindingElementNode(be, parent);
		}
		case SK.OmittedExpression:
			return null;
		case SK.NullKeyword:
			return new NullLiteralNode(child, parent);
		case SK.SuperKeyword:
			return new SuperNode(child, parent);
		case SK.ThisKeyword:
			return new ThisExpressionNode(child, parent);
		case SK.TypeParameter:
			return new TSTypeParameterNode(child as ts.TypeParameterDeclaration, parent);
		case SK.ExpressionWithTypeArguments: {
			// Parent-aware shape (mirrors eager line 1858). The TS parent
			// chain — not our lazy parent — is what carries this signal:
			// HeritageClause never has a LazyNode (it's collapsed into the
			// owning class/interface), so `parent._ts.kind` would never be
			// HeritageClause. Read directly off the ts.Node.
			const ewta = child as ts.ExpressionWithTypeArguments;
			const tsParent = ewta.parent;
			let tag: 'TSInterfaceHeritage' | 'TSClassImplements' | 'TSInstantiationExpression';
			if (tsParent?.kind === SK.HeritageClause) {
				tag = (tsParent as ts.HeritageClause).parent?.kind === SK.InterfaceDeclaration
					? 'TSInterfaceHeritage'
					: 'TSClassImplements';
			}
			else {
				tag = 'TSInstantiationExpression';
			}
			return new ExpressionWithTypeArgumentsNode(ewta, parent, tag);
		}
		case SK.PrivateIdentifier:
			return new PrivateIdentifierNode(child as ts.PrivateIdentifier, parent);
		case SK.TypeAssertionExpression:
			return new TSTypeAssertionNode(child, parent);
		case SK.SatisfiesExpression:
			return new TSSatisfiesExpressionNode(child, parent);
		case SK.ConstructorType:
			return new TSConstructorTypeNode(child as ts.ConstructorTypeNode, parent);
		case SK.MappedType:
			return new TSMappedTypeNode(child as ts.MappedTypeNode, parent);
		case SK.ConditionalType:
			return new TSConditionalTypeNode(child, parent);
		case SK.InferType:
			return new TSInferTypeNode(child, parent);
		case SK.ThisType:
			return new TSThisTypeNode(child, parent);
		case SK.TypePredicate:
			return new TSTypePredicateNode(child as ts.TypePredicateNode, parent);
		case SK.ModuleDeclaration:
			return new TSModuleDeclarationNode(child as ts.ModuleDeclaration, parent);
		case SK.ModuleBlock:
			return new TSModuleBlockNode(child, parent);
		case SK.EnumDeclaration:
			return new TSEnumDeclarationNode(child as ts.EnumDeclaration, parent);
		case SK.EnumMember:
			return new TSEnumMemberNode(child as ts.EnumMember, parent);
		case SK.Decorator:
			return new DecoratorNode(child, parent);
		case SK.HeritageClause:
			return null; // handled inline by ClassNode
		case SK.VariableDeclarationList:
			return new VariableDeclarationListAsNode(child as ts.VariableDeclarationList, parent);
		case SK.VoidExpression:
			return new VoidExpressionNode(child, parent);
		case SK.DeleteExpression:
			return new DeleteExpressionNode(child, parent);
		case SK.JsxElement:
		case SK.JsxSelfClosingElement:
			return new JSXElementNode(child, parent);
		case SK.JsxOpeningElement:
			return new JSXOpeningElementNode(child as ts.JsxOpeningElement, parent);
		case SK.JsxClosingElement:
			return new JSXClosingElementNode(child, parent);
		case SK.JsxFragment:
			return new JSXFragmentNode(child, parent);
		case SK.JsxOpeningFragment:
			return new JSXOpeningFragmentNode(child, parent);
		case SK.JsxClosingFragment:
			return new JSXClosingFragmentNode(child, parent);
		case SK.JsxAttribute:
			return new JSXAttributeNode(child, parent);
		case SK.JsxSpreadAttribute:
			return new JSXSpreadAttributeNode(child, parent);
		case SK.JsxExpression:
			return (child as ts.JsxExpression).dotDotDotToken
				? new JSXSpreadChildNode(child, parent)
				: new JSXExpressionContainerNode(child, parent);
		case SK.JsxText:
			return new JSXTextNode(child as ts.JsxText, parent);
		case SK.AnyKeyword:
			return new TypeKeywordNode('TSAnyKeyword', child, parent);
		case SK.UnknownKeyword:
			return new TypeKeywordNode('TSUnknownKeyword', child, parent);
		case SK.NumberKeyword:
			return new TypeKeywordNode('TSNumberKeyword', child, parent);
		case SK.StringKeyword:
			return new TypeKeywordNode('TSStringKeyword', child, parent);
		case SK.BooleanKeyword:
			return new TypeKeywordNode('TSBooleanKeyword', child, parent);
		case SK.SymbolKeyword:
			return new TypeKeywordNode('TSSymbolKeyword', child, parent);
		case SK.NeverKeyword:
			return new TypeKeywordNode('TSNeverKeyword', child, parent);
		case SK.VoidKeyword:
			return new TypeKeywordNode('TSVoidKeyword', child, parent);
		case SK.UndefinedKeyword:
			return new TypeKeywordNode('TSUndefinedKeyword', child, parent);
		case SK.NullKeyword:
			return new TypeKeywordNode('TSNullKeyword', child, parent);
		case SK.BigIntKeyword:
			return new TypeKeywordNode('TSBigIntKeyword', child, parent);
		case SK.ObjectKeyword:
			return new TypeKeywordNode('TSObjectKeyword', child, parent);
		case SK.IntrinsicKeyword:
			return new TypeKeywordNode('TSIntrinsicKeyword', child, parent);
		default:
			// Unsupported SyntaxKind — fall back to a generic node mirroring
			// typescript-estree's `deeplyCopy`: type='TS<KindName>', range +
			// parent only. Lets `tsToEstreeOrStub` always return SOMETHING
			// so callers reading `.type === 'X'` etc. don't crash. Add a
			// real case if the shape matters (i.e. children should be
			// reachable via getter, not just the type tag).
			return new GenericTSNode(child, parent);
	}
}

function convertChildren(children: ReadonlyArray<ts.Node>, parent: LazyNode): (LazyNode | null)[] {
	return children.map(c => convertChild(c, parent));
}

// Generic fallback for SyntaxKinds without a dedicated class. Mirrors
// typescript-estree's `deeplyCopy`: type='TS<KindName>', range, parent.
// Used when:
//   - a kind isn't handled by `convertChildInner` (long-tail cases),
//   - bottom-up `materialize()` walks up past TS-only kinds and hits a
//     null-returning convertChild (HeritageClause, OmittedExpression,
//     JsxText).
// Children are intentionally NOT exposed via getters — the shape is
// minimal-viable so `.type === 'X'` and `.parent.type` checks work
// without us having to choose accessors arbitrarily. Add a real
// LazyNode subclass when a rule actually needs the children.
// Marker so callers (e.g. CodePathAnalyzer-driving visit walker) can
// detect a materialised node that has no real ESTree counterpart and
// skip dispatching enter/leave on it.
export const GENERIC_TS_NODE_MARKER: unique symbol = Symbol('GenericTSNode');
class GenericTSNode extends LazyNode {
	readonly type: string;
	readonly [GENERIC_TS_NODE_MARKER] = true;
	constructor(tsNode: ts.Node, parent: LazyNode | null, context?: ConvertContext) {
		// Synthetic — don't claim the TS node's slot in the maps if a
		// real subclass might be made for it later (avoid cache pollution).
		// But DO register so cache hits work for repeated lookups via
		// materialise during the same conversion. The downside: if a real
		// converter later wants this slot, we'd return the generic. For
		// now the cases that hit GenericTSNode are unsupported kinds where
		// no real subclass exists; safe.
		// `context` only needed when `parent` is null (no parent to inherit
		// _ctx from) — happens when materialize() bottom-up exhausts the TS
		// parent chain without hitting a cached ancestor.
		super(tsNode, parent, context);
		this.type = 'TS' + ts.SyntaxKind[tsNode.kind];
	}
}

// Wraps a type node in an extra TSTypeAnnotation that adds the leading colon
// (or `=>` for FunctionType / ConstructorType) to its range — matches Flow
// shape that typescript-estree replicates.
function convertTypeAnnotation(child: ts.Node, parent: LazyNode): TSTypeAnnotationNode {
	const offset = parent['_ts'].kind === SK.FunctionType || parent['_ts'].kind === SK.ConstructorType ? 2 : 1;
	const start = child.getFullStart() - offset;
	const end = child.getEnd();
	return new TSTypeAnnotationNode(child, parent, [start, end]);
}

// Optional-chain wrapping (mirrors typescript-estree's `convertChainExpression`,
// line 182). Each MemberExpression / CallExpression that's part of an
// optional chain gets handled here:
//   - If neither the current node is optional NOR its child is already a
//     ChainExpression, return as-is (most common path).
//   - If the child is a ChainExpression (and we're not parenthesized),
//     UNWRAP it: take child.expression as our new object/callee, then wrap
//     the result in a fresh ChainExpression. This collapses nested chain
//     expressions to a single outer ChainExpression covering the whole.
//   - Otherwise (we're optional, child isn't yet a chain), wrap us in a
//     fresh ChainExpression.
//
// Side effect: forces `object`/`callee` materialisation so we can see
// whether the child is a ChainExpression. The optional-chain code path
// is rare enough that this eager step is cheap.
function wrapChainIfNeeded(
	result: MemberExpressionNode | CallExpressionNode,
	tsNode: ts.PropertyAccessExpression | ts.ElementAccessExpression | ts.CallExpression,
	parent: LazyNode,
): LazyNode {
	const isMember = result.type === 'MemberExpression';
	const child = isMember
		? result.object
		: result.callee;
	const isOptional = result.optional;
	const isChildChain = (child as { type?: string } | null)?.type === 'ChainExpression'
		&& (tsNode as ts.PropertyAccessExpression).expression?.kind !== SK.ParenthesizedExpression;
	if (!isChildChain && !isOptional) return result;
	if (isChildChain) {
		// Unwrap: pull out child.expression, point us at it instead.
		const inner = (child as unknown as { expression: LazyNode }).expression;
		// Re-point our object/callee. The cache was already populated with
		// the ChainExpression for the TS child node; overwrite to inner.
		const tsChildField = isMember
			? (tsNode as ts.PropertyAccessExpression | ts.ElementAccessExpression).expression
			: (tsNode as ts.CallExpression).expression;
		parent._ctx.maps.tsNodeToESTreeNodeMap.set(tsChildField, inner);
		// Override our cached child slot.
		if (isMember) (result as unknown as { _object: LazyNode })._object = inner;
		else (result as unknown as { _callee: LazyNode })._callee = inner;
		(inner as { parent: LazyNode }).parent = result;
	}
	return new ChainExpressionWrappingNode(tsNode, parent, result);
}

// upstream: typescript-estree's `convertChainExpression` (called when
// any link in the chain has `?.`). Wraps the outermost optional
// chain in `ChainExpression { expression: <inner> }`. Like
// ExportNamedWrappingNode this wrapper claims the TS slot in the
// cache; `unwrapChain` in `ts-ast-scan.ts` re-expands the chain at
// dispatch time so listeners on the inner type still fire.
class ChainExpressionWrappingNode extends LazyNode {
	readonly type = 'ChainExpression' as const;
	readonly expression: LazyNode;
	constructor(tsNode: ts.Node, parent: LazyNode, expression: LazyNode) {
		super(tsNode, parent, undefined, false);
		// Take the wrapped node's range — eager createNode passes the same TS
		// node, so loc is identical and the lazy getter recomputes when needed.
		this.range = expression.range.slice() as [number, number];
		// Wrap the inner: its parent becomes us, and the TS-node map is
		// re-pointed to us (eager comment: "registered as the canonical
		// mapping for this TS node").
		(expression as { parent: LazyNode }).parent = this;
		this._ctx.maps.tsNodeToESTreeNodeMap.set(tsNode, this);
		this.expression = expression;
	}
}

// Wrap typeParameters declaration (`<T extends X>`) in
// TSTypeParameterDeclaration matching eager. Used by classes,
// interfaces, type aliases, and any function-like with `<T>` generics.
function convertTypeParameters(
	typeParams: ts.NodeArray<ts.TypeParameterDeclaration> | undefined,
	parent: LazyNode,
): TSTypeParameterDeclarationNode | undefined {
	if (!typeParams || typeParams.length === 0) return undefined;
	return new TSTypeParameterDeclarationNode(typeParams, parent);
}

class TSTypeParameterDeclarationNode extends LazyNode {
	readonly type = 'TSTypeParameterDeclaration' as const;
	private _params?: (LazyNode | null)[];
	private _typeParams: ts.NodeArray<ts.TypeParameterDeclaration>;
	constructor(typeParams: ts.NodeArray<ts.TypeParameterDeclaration>, parent: LazyNode) {
		const host = typeParams[0].parent;
		super(host, parent, undefined, false);
		this._typeParams = typeParams;
		const start = typeParams.pos - 1;
		const end = typeParams.end + 1;
		this.range = [start, end];
	}
	get params() {
		return this._params ??= this._typeParams.map(t => convertChild(t, this));
	}
}

// Wrap typeArguments (e.g. `<number, string>`) in TSTypeParameterInstantiation
// matching typescript-estree's `convertTypeArguments` (line 264). Range
// extends one char before the first type to cover the `<`.
function convertTypeArguments(
	typeArgs: ts.NodeArray<ts.TypeNode> | undefined,
	parent: LazyNode,
): TSTypeParameterInstantiationNode | undefined {
	if (!typeArgs || typeArgs.length === 0) return undefined;
	return new TSTypeParameterInstantiationNode(typeArgs, parent);
}

class TSTypeParameterInstantiationNode extends LazyNode {
	readonly type = 'TSTypeParameterInstantiation' as const;
	private _params?: (LazyNode | null)[];
	private _typeArgs: ts.NodeArray<ts.TypeNode>;
	constructor(typeArgs: ts.NodeArray<ts.TypeNode>, parent: LazyNode) {
		const host = typeArgs[0].parent;
		super(host, parent, undefined, false);
		this._typeArgs = typeArgs;
		// Eager finds the actual `>` token to handle nested generics
		// (`Foo<Bar<Baz>>` shares `>>`). We scan forward from the last
		// type's end, skipping whitespace, to land on the `>`.
		const text = this._ctx.ast.text;
		let endCursor = typeArgs.end;
		while (endCursor < text.length && /\s/.test(text[endCursor])) endCursor++;
		const closingGt = text.indexOf('>', endCursor);
		const end = closingGt >= 0 ? closingGt + 1 : typeArgs.end + 1;
		const start = typeArgs.pos - 1;
		this.range = [start, end];
	}
	get params() {
		return this._params ??= this._typeArgs.map(t => convertChild(t, this));
	}
}

// --- Per-kind classes ---------------------------------------------------

class ProgramNode extends LazyNode {
	readonly type = 'Program' as const;
	readonly sourceType: 'module' | 'script';
	comments: any[] = [];
	tokens: any[] = [];
	private _body?: (LazyNode | null)[];

	constructor(tsNode: ts.SourceFile, parent: LazyNode | null, context?: ConvertContext) {
		super(tsNode, parent, context);
		this.sourceType = (tsNode as { externalModuleIndicator?: unknown }).externalModuleIndicator ? 'module' : 'script';
	}

	// Program range ends at endOfFileToken.end, not source file end. Override
	// the lazy getter so we only compute the bounds when read.
	get range(): [number, number] {
		const cached = (this as unknown as { _range?: [number, number] })._range;
		if (cached) return cached;
		const ts_ = this._ts as ts.SourceFile;
		const r: [number, number] = [ts_.getStart(this._ctx.ast), ts_.endOfFileToken.end];
		(this as unknown as { _range: [number, number] })._range = r;
		return r;
	}
	set range(v: [number, number]) {
		(this as unknown as { _range?: [number, number]; _loc?: unknown })._range = v;
		(this as unknown as { _loc?: unknown })._loc = undefined;
	}

	get body() {
		return this._body ??= convertBodyWithDirectives(
			(this._ts as ts.SourceFile).statements,
			this,
		);
	}
}

// Mirrors typescript-estree's `convertBodyExpressions`: leading
// string-literal ExpressionStatements get a `directive` field. The check
// stops at the first non-string-literal statement. Calling this forces
// materialisation of the leading children (we need their `.expression.raw`
// to set the directive); subsequent siblings stay lazy via convertChildren.
function convertBodyWithDirectives(
	statements: ReadonlyArray<ts.Statement>,
	parent: LazyNode,
): (LazyNode | null)[] {
	const out: (LazyNode | null)[] = [];
	let allowDirectives = true;
	for (const stmt of statements) {
		const child = convertChild(stmt, parent);
		if (
			allowDirectives
			&& stmt.kind === SK.ExpressionStatement
			&& (stmt as ts.ExpressionStatement).expression.kind === SK.StringLiteral
			&& child
		) {
			const expr = (child as unknown as { expression: { raw?: string } | null }).expression;
			if (expr?.raw) {
				(child as unknown as { directive: string }).directive = expr.raw.slice(1, -1);
			}
			out.push(child);
			continue;
		}
		allowDirectives = false;
		out.push(child);
	}
	return out;
}

class IdentifierNode extends LazyNode {
	readonly type = 'Identifier' as const;
	readonly name: string;
	readonly decorators: never[] = EMPTY_ARRAY;
	readonly optional = false;
	readonly typeAnnotation = undefined;

	constructor(tsNode: ts.Identifier, parent: LazyNode | null) {
		super(tsNode, parent);
		this.name = tsNode.text;
	}
}

class VariableDeclarationNode extends LazyNode {
	readonly type = 'VariableDeclaration' as const;
	readonly kind: 'var' | 'let' | 'const' | 'using' | 'await using';
	readonly declare: boolean;
	private _declarations?: (LazyNode | null)[];

	constructor(tsNode: ts.VariableStatement, parent: LazyNode | null) {
		super(tsNode, parent);
		const list = tsNode.declarationList;
		const flags = list.flags;
		// AwaitUsing = Using | Const overlaps with Const — check first.
		this.kind = (flags & ts.NodeFlags.AwaitUsing) === ts.NodeFlags.AwaitUsing
			? 'await using'
			: (flags & ts.NodeFlags.Using) === ts.NodeFlags.Using
			? 'using'
			: flags & ts.NodeFlags.Const
			? 'const'
			: flags & ts.NodeFlags.Let
			? 'let'
			: 'var';
		this.declare = !!tsNode.modifiers?.some(m => m.kind === SK.DeclareKeyword);
	}

	get declarations() {
		return this._declarations ??= convertChildren(
			(this._ts as ts.VariableStatement).declarationList.declarations,
			this,
		);
	}
}

class VariableDeclaratorNode extends LazyNode {
	readonly type = 'VariableDeclarator' as const;
	readonly definite: boolean;
	private _id?: LazyNode | null;
	private _init?: LazyNode | null;

	constructor(tsNode: ts.VariableDeclaration, parent: LazyNode | null) {
		super(tsNode, parent);
		this.definite = !!tsNode.exclamationToken;
	}

	get id() {
		if (this._id !== undefined) return this._id;
		const ts_ = this._ts as ts.VariableDeclaration;
		const idNode = convertChild(ts_.name, this);
		// VariableDeclarator.id carries the name's typeAnnotation. typescript-estree
		// also extends the id's range to cover the typeAnnotation
		// (`fixParentLocation`), so range checks like `id.range[1] === end` continue
		// to work.
		if (idNode && ts_.type) {
			const annotation = convertTypeAnnotation(ts_.type, idNode);
			(idNode as { typeAnnotation?: LazyNode | null }).typeAnnotation = annotation;
			(idNode as unknown as { _extendRange: (r: [number, number]) => void })._extendRange(annotation.range);
		}
		return this._id = idNode;
	}

	get init() {
		return this._init ??= convertChild((this._ts as ts.VariableDeclaration).initializer, this);
	}
}

class TSAsExpressionNode extends LazyNode {
	readonly type = 'TSAsExpression' as const;
	private _expression?: LazyNode | null;
	private _typeAnnotation?: LazyNode | null;

	get expression() {
		return this._expression ??= convertChild((this._ts as ts.AsExpression).expression, this);
	}

	get typeAnnotation() {
		return this._typeAnnotation ??= convertChild((this._ts as ts.AsExpression).type, this);
	}
}

class TSTypeReferenceNode extends LazyNode {
	readonly type = 'TSTypeReference' as const;
	private _typeName?: LazyNode | null;
	private _typeArguments?: LazyNode | undefined;

	get typeName() {
		return this._typeName ??= convertChild((this._ts as ts.TypeReferenceNode).typeName, this);
	}

	get typeArguments() {
		if (this._typeArguments !== undefined) return this._typeArguments;
		return this._typeArguments = convertTypeArguments((this._ts as ts.TypeReferenceNode).typeArguments, this);
	}
}

class TSTypeAnnotationNode extends LazyNode {
	readonly type = 'TSTypeAnnotation' as const;
	private _typeAnnotation?: LazyNode | null;

	constructor(tsTypeNode: ts.Node, parent: LazyNode, range: [number, number]) {
		// `registerInMaps: false` — this wrapper is synthetic (no direct TS
		// counterpart). The TS type node belongs to the inner conversion
		// (e.g. TSNumberKeyword), which registers itself when materialised.
		super(tsTypeNode, parent, undefined, false);
		this.range = range;
	}

	get typeAnnotation() {
		return this._typeAnnotation ??= convertChild(this._ts, this);
	}
}

// Type-position keywords (`any`, `number`, `string`, …). All have the same
// shape — just `type: 'TSXxxKeyword'`. Group them under one class to avoid
// 14 near-identical declarations.
class TypeKeywordNode extends LazyNode {
	readonly type: string;
	constructor(type: string, tsNode: ts.Node, parent: LazyNode) {
		super(tsNode, parent);
		this.type = type;
	}
}

class ExpressionStatementNode extends LazyNode {
	readonly type = 'ExpressionStatement' as const;
	directive: string | undefined = undefined;
	private _expression?: LazyNode | null;
	get expression() {
		return this._expression ??= convertChild((this._ts as ts.ExpressionStatement).expression, this);
	}
}

class ReturnStatementNode extends LazyNode {
	readonly type = 'ReturnStatement' as const;
	private _argument?: LazyNode | null;
	get argument() {
		return this._argument ??= convertChild((this._ts as ts.ReturnStatement).expression, this);
	}
}

class BlockStatementNode extends LazyNode {
	readonly type = 'BlockStatement' as const;
	private _body?: (LazyNode | null)[];
	get body() {
		if (this._body) return this._body;
		const ts_ = this._ts as ts.Block;
		// Function-like bodies allow leading-string directives ("use strict").
		const pk = ts_.parent?.kind;
		const allowsDirectives = pk === SK.FunctionDeclaration
			|| pk === SK.FunctionExpression
			|| pk === SK.ArrowFunction
			|| pk === SK.MethodDeclaration
			|| pk === SK.Constructor
			|| pk === SK.GetAccessor
			|| pk === SK.SetAccessor;
		return this._body = allowsDirectives
			? convertBodyWithDirectives(ts_.statements, this)
			: convertChildren(ts_.statements, this);
	}
}

class IfStatementNode extends LazyNode {
	readonly type = 'IfStatement' as const;
	private _test?: LazyNode | null;
	private _consequent?: LazyNode | null;
	private _alternate?: LazyNode | null;
	get test() {
		return this._test ??= convertChild((this._ts as ts.IfStatement).expression, this);
	}
	get consequent() {
		return this._consequent ??= convertChild((this._ts as ts.IfStatement).thenStatement, this);
	}
	get alternate() {
		return this._alternate ??= convertChild((this._ts as ts.IfStatement).elseStatement, this);
	}
}

// Type-position nodes — direct 1:1 with typescript-estree's cases.

class TSUnionTypeNode extends LazyNode {
	readonly type = 'TSUnionType' as const;
	private _types?: (LazyNode | null)[];
	get types() {
		return this._types ??= convertChildren((this._ts as ts.UnionTypeNode).types, this);
	}
}

class TSIntersectionTypeNode extends LazyNode {
	readonly type = 'TSIntersectionType' as const;
	private _types?: (LazyNode | null)[];
	get types() {
		return this._types ??= convertChildren((this._ts as ts.IntersectionTypeNode).types, this);
	}
}

class TSArrayTypeNode extends LazyNode {
	readonly type = 'TSArrayType' as const;
	private _elementType?: LazyNode | null;
	get elementType() {
		return this._elementType ??= convertChild((this._ts as ts.ArrayTypeNode).elementType, this);
	}
}

class TSTypeLiteralNode extends LazyNode {
	readonly type = 'TSTypeLiteral' as const;
	private _members?: (LazyNode | null)[];
	get members() {
		return this._members ??= convertChildren((this._ts as ts.TypeLiteralNode).members, this);
	}
}

class TSTypeQueryNode extends LazyNode {
	readonly type = 'TSTypeQuery' as const;
	readonly typeArguments = undefined;
	private _exprName?: LazyNode | null;
	get exprName() {
		return this._exprName ??= convertChild((this._ts as ts.TypeQueryNode).exprName, this);
	}
}

class TSTypeOperatorNode extends LazyNode {
	readonly type = 'TSTypeOperator' as const;
	readonly operator: 'keyof' | 'unique' | 'readonly';
	private _typeAnnotation?: LazyNode | null;
	constructor(tsNode: ts.TypeOperatorNode, parent: LazyNode) {
		super(tsNode, parent);
		this.operator = tsNode.operator === SK.KeyOfKeyword
			? 'keyof'
			: tsNode.operator === SK.UniqueKeyword
			? 'unique'
			: 'readonly';
	}
	get typeAnnotation() {
		return this._typeAnnotation ??= convertChild((this._ts as ts.TypeOperatorNode).type, this);
	}
}

class TSIndexedAccessTypeNode extends LazyNode {
	readonly type = 'TSIndexedAccessType' as const;
	private _objectType?: LazyNode | null;
	private _indexType?: LazyNode | null;
	get objectType() {
		return this._objectType ??= convertChild((this._ts as ts.IndexedAccessTypeNode).objectType, this);
	}
	get indexType() {
		return this._indexType ??= convertChild((this._ts as ts.IndexedAccessTypeNode).indexType, this);
	}
}

// LiteralType has a special case for `null`: TS 4.0+ wraps NullKeyword in
// a LiteralType node, but we expose the bare TSNullKeyword to match eager.
function convertLiteralType(tsNode: ts.LiteralTypeNode, parent: LazyNode): LazyNode {
	if (tsNode.literal.kind === SK.NullKeyword) {
		const node = new TypeKeywordNode('TSNullKeyword', tsNode.literal, parent);
		// Cache under BOTH the inner NullKeyword (set by the LazyNode
		// constructor's registerInMaps) AND the outer LiteralType — without
		// the outer entry, the Parameter.type wrapper route's
		// `tsNodeToESTreeNodeMap.get(LiteralType)` post-check after `trigger`
		// fails and throws "wrapper route did not register the inner node"
		// on `function f(x: null = null)` and similar patterns.
		parent._ctx.maps.tsNodeToESTreeNodeMap.set(tsNode, node);
		return node;
	}
	return new TSLiteralTypeNode(tsNode, parent);
}

class TSLiteralTypeNode extends LazyNode {
	readonly type = 'TSLiteralType' as const;
	private _literal?: LazyNode | null;
	get literal() {
		return this._literal ??= convertChild((this._ts as ts.LiteralTypeNode).literal, this);
	}
}

// `typeof import('x')` produces a TSTypeQuery whose exprName is a
// TSImportType. The wrapper takes the same TS node identity (matching
// eager line 1962).
class TSTypeQueryWrappingNode extends LazyNode {
	readonly type = 'TSTypeQuery' as const;
	readonly typeArguments = undefined;
	readonly exprName: LazyNode;
	constructor(tsNode: ts.ImportTypeNode, parent: LazyNode, exprName: LazyNode) {
		super(tsNode, parent, undefined, false);
		// Re-point the TS node map to the outer wrapper.
		this._ctx.maps.tsNodeToESTreeNodeMap.set(tsNode, this);
		(exprName as { parent: LazyNode }).parent = this;
		this.exprName = exprName;
	}
}

class TSImportTypeNode extends LazyNode {
	readonly type = 'TSImportType' as const;
	readonly options = null;
	private _source?: LazyNode | null;
	private _qualifier?: LazyNode | null;
	private _typeArguments?: LazyNode | null;
	private _argumentEstree?: LazyNode | null;

	constructor(tsNode: ts.ImportTypeNode, parent: LazyNode) {
		super(tsNode, parent);
		// `typeof import('x')` — when isTypeOf is true, the wrapping TSTypeQuery
		// adjusts the range. For TSImportType itself, eager uses the
		// importType's own range MINUS the leading `typeof ` if isTypeOf.
		if (tsNode.isTypeOf) {
			const typeofTokenStart = tsNode.getStart(this._ctx.ast);
			// eager: range[0] = findNextToken(getFirstToken(), node).getStart(ast)
			const text = this._ctx.ast.text;
			let cursor = typeofTokenStart + 'typeof'.length;
			while (cursor < text.length && /\s/.test(text[cursor])) cursor++;
			this.range = [cursor, this.range[1]];
		}
	}

	// eager exposes `source` (= argument.literal — the StringLiteral) and
	// `argument` is a deprecated alias.
	get source() {
		if (this._source !== undefined) return this._source;
		const argEstree = this._argumentEstree ??= convertChild((this._ts as ts.ImportTypeNode).argument, this);
		// argEstree is a TSLiteralType wrapping a StringLiteral.
		const lit = (argEstree as unknown as { literal?: LazyNode | null } | null)?.literal ?? null;
		return this._source = lit;
	}

	// Deprecated alias for source — eager wires this via #withDeprecatedAliasGetter.
	get argument() {
		return this._argumentEstree ??= convertChild((this._ts as ts.ImportTypeNode).argument, this);
	}

	get qualifier() {
		return this._qualifier ??= convertChild((this._ts as ts.ImportTypeNode).qualifier, this);
	}

	get typeArguments() {
		if (this._typeArguments !== undefined) return this._typeArguments;
		return this._typeArguments = convertTypeArguments((this._ts as ts.ImportTypeNode).typeArguments, this) ?? null;
	}
}

class TSQualifiedNameNode extends LazyNode {
	readonly type = 'TSQualifiedName' as const;
	private _left?: LazyNode | null;
	private _right?: LazyNode | null;
	get left() {
		return this._left ??= convertChild((this._ts as ts.QualifiedName).left, this);
	}
	get right() {
		return this._right ??= convertChild((this._ts as ts.QualifiedName).right, this);
	}
}

class VoidExpressionNode extends LazyNode {
	readonly type = 'UnaryExpression' as const;
	readonly operator = 'void' as const;
	readonly prefix = true as const;
	private _argument?: LazyNode | null;
	get argument() {
		return this._argument ??= convertChild((this._ts as ts.VoidExpression).expression, this);
	}
}

class DeleteExpressionNode extends LazyNode {
	readonly type = 'UnaryExpression' as const;
	readonly operator = 'delete' as const;
	readonly prefix = true as const;
	private _argument?: LazyNode | null;
	get argument() {
		return this._argument ??= convertChild((this._ts as ts.DeleteExpression).expression, this);
	}
}

// VariableDeclarationList appears in for-loop initializers (`for (let i = 0;...)`).
// typescript-estree converts it to a VariableDeclaration with no `declare`.
class VariableDeclarationListAsNode extends LazyNode {
	readonly type = 'VariableDeclaration' as const;
	readonly kind: 'var' | 'let' | 'const' | 'using' | 'await using';
	readonly declare = false;
	private _declarations?: (LazyNode | null)[];
	constructor(tsNode: ts.VariableDeclarationList, parent: LazyNode) {
		super(tsNode, parent);
		const flags = tsNode.flags;
		// AwaitUsing = Using | Const overlaps with Const, so check it first.
		// Without `'await using'` / `'using'` kinds, plugin rules listening
		// on `VariableDeclaration[kind="await using"]` (await-thenable's
		// async-disposable check) miss every stage-3 disposable.
		this.kind = (flags & ts.NodeFlags.AwaitUsing) === ts.NodeFlags.AwaitUsing
			? 'await using'
			: (flags & ts.NodeFlags.Using) === ts.NodeFlags.Using
			? 'using'
			: flags & ts.NodeFlags.Const
			? 'const'
			: flags & ts.NodeFlags.Let
			? 'let'
			: 'var';
	}
	get declarations() {
		return this._declarations ??= convertChildren((this._ts as ts.VariableDeclarationList).declarations, this);
	}
}

// Classes — typescript-estree assembles `body` from the class members
// filtered through `isESTreeClassMember`. MVP just passes them through;
// HeritageClause folded into superClass / implements via inline scan.

class ClassNode extends LazyNode {
	readonly type: 'ClassDeclaration' | 'ClassExpression';
	readonly abstract: boolean;
	readonly declare: boolean;
	readonly superTypeArguments = undefined;
	readonly superTypeParameters = undefined;
	private _typeParameters?: LazyNode | undefined;
	private _id?: LazyNode | null;
	private _body?: ClassBodyNode;
	private _superClass?: LazyNode | null;
	private _implements?: (LazyNode | null)[];
	private _decorators?: (LazyNode | null)[];
	get decorators() {
		return this._decorators ??= convertDecorators(this._ts, this);
	}

	constructor(
		type: 'ClassDeclaration' | 'ClassExpression',
		tsNode: ts.ClassDeclaration | ts.ClassExpression,
		parent: LazyNode,
	) {
		super(tsNode, parent);
		this.type = type;
		this.abstract = !!tsNode.modifiers?.some(m => m.kind === SK.AbstractKeyword);
		this.declare = !!tsNode.modifiers?.some(m => m.kind === SK.DeclareKeyword);
	}
	get id() {
		return this._id ??= convertChild((this._ts as ts.ClassDeclaration).name, this);
	}
	get typeParameters() {
		if (this._typeParameters !== undefined) return this._typeParameters;
		return this._typeParameters = convertTypeParameters((this._ts as ts.ClassDeclaration).typeParameters, this);
	}
	get body() {
		if (this._body) return this._body;
		const ts_ = this._ts as ts.ClassDeclaration;
		const range: [number, number] = [ts_.members.pos - 1, ts_.end];
		return this._body = new ClassBodyNode(ts_, this, range);
	}
	get superClass() {
		if (this._superClass !== undefined) return this._superClass;
		const ext = (this._ts as ts.ClassDeclaration).heritageClauses
			?.find(h => h.token === SK.ExtendsKeyword);
		const t = ext?.types[0]?.expression;
		return this._superClass = t ? convertChild(t, this) : null;
	}
	get implements() {
		if (this._implements) return this._implements;
		const impl = (this._ts as ts.ClassDeclaration).heritageClauses
			?.find(h => h.token === SK.ImplementsKeyword);
		return this._implements = impl ? convertChildren(impl.types, this) : [];
	}
}

class ClassBodyNode extends LazyNode {
	readonly type = 'ClassBody' as const;
	private _body?: (LazyNode | null)[];
	constructor(classTsNode: ts.ClassDeclaration | ts.ClassExpression, parent: LazyNode, range: [number, number]) {
		super(classTsNode, parent, undefined, false);
		this.range = range;
	}
	get body() {
		if (this._body) return this._body;
		const members = (this._ts as ts.ClassDeclaration).members.filter(m => m.kind !== SK.SemicolonClassElement);
		return this._body = convertChildren(members, this);
	}
}

// Method-as-FunctionExpression — eager (line 826) builds the FunctionExpression
// with `id: null`, `range: [parameters.pos - 1, end]`, and per-context kind.
// Used as `value` for both class MethodDefinition and object Property.
class MethodFunctionExpressionNode extends LazyNode {
	// Body-less methods (abstract or interface-style) emit
	// TSEmptyBodyFunctionExpression instead of FunctionExpression.
	readonly type: 'FunctionExpression' | 'TSEmptyBodyFunctionExpression';
	readonly id = null;
	readonly async: boolean;
	readonly declare = false;
	readonly generator: boolean;
	readonly expression = false;
	private _typeParameters?: LazyNode | undefined;
	private _params?: (LazyNode | null)[];
	private _body?: LazyNode | null;
	private _returnType?: LazyNode | null | undefined;

	constructor(
		tsNode: ts.MethodDeclaration | ts.ConstructorDeclaration | ts.GetAccessorDeclaration | ts.SetAccessorDeclaration,
		parent: LazyNode,
	) {
		super(tsNode, parent, undefined, false);
		// Eager method range starts one before parameters' first paren.
		let start = tsNode.parameters.pos - 1;
		const end = tsNode.end;
		// If there are typeParameters (`foo<T>(x: T)`), eager extends the
		// method range to include them via fixParentLocation (line 841).
		const tps = (tsNode as ts.MethodDeclaration).typeParameters;
		if (tps && tps.length > 0) {
			start = Math.min(start, tps.pos - 1);
		}
		this.range = [start, end];
		this.async = !!tsNode.modifiers?.some(m => m.kind === SK.AsyncKeyword);
		this.generator = !!(tsNode as ts.MethodDeclaration).asteriskToken;
		this.type = (tsNode as ts.MethodDeclaration).body
			? 'FunctionExpression'
			: 'TSEmptyBodyFunctionExpression';
	}
	get params() {
		return this._params ??= convertChildren((this._ts as ts.MethodDeclaration).parameters, this);
	}
	get body() {
		return this._body ??= convertChild((this._ts as ts.MethodDeclaration).body, this);
	}
	get typeParameters() {
		if (this._typeParameters !== undefined) return this._typeParameters;
		return this._typeParameters = convertTypeParameters((this._ts as ts.MethodDeclaration).typeParameters, this);
	}
	get returnType() {
		if (this._returnType !== undefined) return this._returnType;
		const t = (this._ts as ts.MethodDeclaration).type;
		return this._returnType = t ? convertTypeAnnotation(t, this) : undefined;
	}
}

// Object-literal accessor: `{ get foo() {} }` / `{ set foo(v) {} }` becomes
// Property with kind:'get'/'set' (eager applies the same MethodDefinition
// case but flips kind based on the TS SyntaxKind).
class ObjectAccessorPropertyNode extends LazyNode {
	readonly type = 'Property' as const;
	readonly kind: 'get' | 'set';
	readonly method = false;
	readonly shorthand = false;
	readonly computed: boolean;
	readonly optional = false;
	private _key?: LazyNode | null;
	private _value?: MethodFunctionExpressionNode;
	constructor(tsNode: ts.GetAccessorDeclaration | ts.SetAccessorDeclaration, parent: LazyNode) {
		super(tsNode, parent);
		this.kind = tsNode.kind === SK.GetAccessor ? 'get' : 'set';
		this.computed = tsNode.name.kind === SK.ComputedPropertyName;
	}
	get key() {
		return this._key ??= convertChild(
			(this._ts as ts.GetAccessorDeclaration | ts.SetAccessorDeclaration).name,
			this,
		);
	}
	get value() {
		return this._value ??= new MethodFunctionExpressionNode(
			this._ts as ts.GetAccessorDeclaration | ts.SetAccessorDeclaration,
			this,
		);
	}
}

// Object-literal method shorthand: `{ foo() {} }` becomes Property with
// `method: true` and a FunctionExpression value (mirrors eager line 845).
class ObjectMethodPropertyNode extends LazyNode {
	readonly type = 'Property' as const;
	readonly kind: 'init' = 'init';
	readonly method = true;
	readonly shorthand = false;
	readonly computed: boolean;
	readonly optional: boolean;
	private _key?: LazyNode | null;
	private _value?: MethodFunctionExpressionNode;
	constructor(tsNode: ts.MethodDeclaration, parent: LazyNode) {
		super(tsNode, parent);
		this.computed = tsNode.name.kind === SK.ComputedPropertyName;
		this.optional = !!tsNode.questionToken;
	}
	get key() {
		return this._key ??= convertChild((this._ts as ts.MethodDeclaration).name, this);
	}
	get value() {
		return this._value ??= new MethodFunctionExpressionNode(this._ts as ts.MethodDeclaration, this);
	}
}

class MethodDefinitionNode extends LazyNode {
	readonly type: 'MethodDefinition' | 'TSAbstractMethodDefinition';
	readonly kind: 'method' | 'constructor' | 'get' | 'set';
	readonly static: boolean;
	readonly override: boolean;
	readonly accessibility: 'public' | 'private' | 'protected' | undefined;
	readonly computed: boolean;
	readonly optional: boolean;
	private _key?: LazyNode | null;
	private _value?: MethodFunctionExpressionNode;
	private _decorators?: (LazyNode | null)[];
	get decorators() {
		return this._decorators ??= convertDecorators(this._ts, this);
	}

	constructor(
		tsNode: ts.MethodDeclaration | ts.ConstructorDeclaration | ts.GetAccessorDeclaration | ts.SetAccessorDeclaration,
		parent: LazyNode,
	) {
		super(tsNode, parent);
		this.kind = tsNode.kind === SK.Constructor
			? 'constructor'
			: tsNode.kind === SK.GetAccessor
			? 'get'
			: tsNode.kind === SK.SetAccessor
			? 'set'
			: 'method';
		// `abstract foo();` (body-less method in an abstract class) becomes
		// TSAbstractMethodDefinition; everything else stays MethodDefinition.
		this.type = tsNode.modifiers?.some(m => m.kind === SK.AbstractKeyword)
			? 'TSAbstractMethodDefinition'
			: 'MethodDefinition';
		this.static = !!tsNode.modifiers?.some(m => m.kind === SK.StaticKeyword);
		this.override = !!tsNode.modifiers?.some(m => m.kind === SK.OverrideKeyword);
		const accMod = tsNode.modifiers?.find(m =>
			m.kind === SK.PublicKeyword || m.kind === SK.PrivateKeyword || m.kind === SK.ProtectedKeyword
		);
		this.accessibility = accMod
			? (accMod.kind === SK.PublicKeyword ? 'public' : accMod.kind === SK.PrivateKeyword ? 'private' : 'protected')
			: undefined;
		this.computed = !!(tsNode as ts.MethodDeclaration).name
			&& (tsNode as ts.MethodDeclaration).name.kind === SK.ComputedPropertyName;
		this.optional = !!(tsNode as ts.MethodDeclaration).questionToken;
	}
	get key() {
		if (this._key !== undefined) return this._key;
		const t = this._ts as ts.MethodDeclaration | ts.ConstructorDeclaration;
		// Constructor has no `name`; eager synthesizes an Identifier 'constructor'.
		if (t.kind === SK.Constructor) {
			return this._key = new ConstructorKeyIdentifierNode(t, this);
		}
		return this._key = convertChild(t.name, this);
	}
	get value() {
		return this._value ??= new MethodFunctionExpressionNode(
			this._ts as ts.MethodDeclaration | ts.ConstructorDeclaration,
			this,
		);
	}
}

// Synthetic Identifier for `constructor` — eager line 905 builds an
// Identifier node spanning just the keyword. We replicate the range
// (start of method, length of "constructor").
class ConstructorKeyIdentifierNode extends LazyNode {
	readonly type = 'Identifier' as const;
	readonly name = 'constructor' as const;
	readonly decorators: never[] = EMPTY_ARRAY;
	readonly optional = false;
	readonly typeAnnotation = undefined;
	constructor(tsNode: ts.ConstructorDeclaration, parent: LazyNode) {
		super(tsNode, parent, undefined, false);
		// Find the `constructor` keyword: it's the first token after any
		// modifiers and before the `(`. Easiest: it ends one before the
		// parameter list start.
		const end = tsNode.parameters.pos - 1;
		const start = end - 'constructor'.length;
		this.range = [start, end];
	}
}

class PropertyDefinitionNode extends LazyNode {
	readonly type:
		| 'PropertyDefinition'
		| 'TSAbstractPropertyDefinition'
		| 'AccessorProperty'
		| 'TSAbstractAccessorProperty';
	readonly static: boolean;
	readonly override: boolean;
	readonly readonly: boolean;
	readonly declare: boolean;
	readonly accessibility: 'public' | 'private' | 'protected' | undefined;
	readonly computed: boolean;
	readonly optional: boolean;
	readonly definite: boolean;
	private _key?: LazyNode | null;
	private _value?: LazyNode | null;
	private _typeAnnotation?: LazyNode | null | undefined;
	private _decorators?: (LazyNode | null)[];
	get decorators() {
		return this._decorators ??= convertDecorators(this._ts, this);
	}

	constructor(
		tsNode: ts.PropertyDeclaration,
		parent: LazyNode,
		type: 'PropertyDefinition' | 'TSAbstractPropertyDefinition' | 'AccessorProperty' | 'TSAbstractAccessorProperty' =
			'PropertyDefinition',
	) {
		super(tsNode, parent);
		this.type = type;
		this.static = !!tsNode.modifiers?.some(m => m.kind === SK.StaticKeyword);
		this.override = !!tsNode.modifiers?.some(m => m.kind === SK.OverrideKeyword);
		this.readonly = !!tsNode.modifiers?.some(m => m.kind === SK.ReadonlyKeyword);
		this.declare = !!tsNode.modifiers?.some(m => m.kind === SK.DeclareKeyword);
		const accMod = tsNode.modifiers?.find(m =>
			m.kind === SK.PublicKeyword || m.kind === SK.PrivateKeyword || m.kind === SK.ProtectedKeyword
		);
		this.accessibility = accMod
			? (accMod.kind === SK.PublicKeyword ? 'public' : accMod.kind === SK.PrivateKeyword ? 'private' : 'protected')
			: undefined;
		this.computed = tsNode.name.kind === SK.ComputedPropertyName;
		this.optional = !!tsNode.questionToken;
		this.definite = !!tsNode.exclamationToken;
	}
	get key() {
		return this._key ??= convertChild((this._ts as ts.PropertyDeclaration).name, this);
	}
	get value() {
		return this._value ??= convertChild((this._ts as ts.PropertyDeclaration).initializer, this);
	}
	get typeAnnotation() {
		if (this._typeAnnotation !== undefined) return this._typeAnnotation;
		const t = (this._ts as ts.PropertyDeclaration).type;
		return this._typeAnnotation = t ? convertTypeAnnotation(t, this) : undefined;
	}
}

class ArrayPatternNode extends LazyNode {
	readonly type = 'ArrayPattern' as const;
	readonly decorators: never[] = EMPTY_ARRAY;
	readonly optional = false;
	readonly typeAnnotation = undefined;
	private _elements?: (LazyNode | null)[];
	get elements() {
		const ts_ = this._ts as ts.ArrayBindingPattern;
		return this._elements ??= ts_.elements.map(e => e.kind === SK.OmittedExpression ? null : convertChild(e, this));
	}
}

class ObjectPatternNode extends LazyNode {
	readonly type = 'ObjectPattern' as const;
	readonly decorators: never[] = EMPTY_ARRAY;
	readonly optional = false;
	readonly typeAnnotation = undefined;
	private _properties?: (LazyNode | null)[];
	get properties() {
		return this._properties ??= convertChildren((this._ts as ts.ObjectBindingPattern).elements, this);
	}
}

// Used when `[a = 1] = ...` and `{ b: c = 2 } = ...` — wraps the inner
// pattern with a default value. typescript-estree's range covers from
// the binding NAME (not the BindingElement's outer start, which would
// include the property key in the object case) through the initializer.
class BindingAssignmentPatternNode extends LazyNode {
	readonly type = 'AssignmentPattern' as const;
	readonly decorators: never[] = EMPTY_ARRAY;
	readonly optional = false;
	readonly typeAnnotation = undefined;
	readonly left: LazyNode;
	private _right?: LazyNode | null;
	constructor(tsNode: ts.BindingElement, parent: LazyNode, left: LazyNode) {
		super(tsNode, parent, undefined, false);
		const start = tsNode.name.getStart(this._ctx.ast);
		const end = tsNode.initializer!.end;
		this.range = [start, end];
		this.left = left;
		// Re-point the inner's parent to us — without this, the bound name
		// keeps the parent the value getter passed to `convertChildAsPattern`
		// (the surrounding BindingElement / ArrayPattern), and rules reading
		// `parent.type === 'AssignmentPattern'` (id-length, no-shadow-
		// restricted-names, …) for default-value destructure bindings see
		// the wrapper layer skipped. Same pattern as TSParameterPropertyNode
		// re-points its `parameter` slot.
		(left as { parent: LazyNode }).parent = this;
	}
	get right() {
		return this._right ??= convertChild((this._ts as ts.BindingElement).initializer, this);
	}
}

// upstream: typescript-estree's `convertBindingElement` for
// ObjectBindingPattern children. Maps to ESTree `Property` (with
// `value`, optional default via `AssignmentPattern`) for normal
// bindings, and `RestElement` for `...rest`. ArrayBindingPattern's
// BindingElement is handled separately at the convertChildInner
// dispatch (it collapses to the inner Identifier directly).
class BindingElementNode extends LazyNode {
	readonly type: 'Property' | 'RestElement';
	readonly computed: boolean;
	readonly kind: 'init' = 'init';
	readonly method = false;
	readonly optional = false;
	readonly shorthand: boolean;
	readonly decorators: never[] = EMPTY_ARRAY;
	private _key?: LazyNode | null;
	private _value?: LazyNode | null;
	private _argument?: LazyNode | null;

	constructor(tsNode: ts.BindingElement, parent: LazyNode) {
		super(tsNode, parent);
		this.type = tsNode.dotDotDotToken ? 'RestElement' : 'Property';
		// shorthand iff no `propertyName` (just `name`).
		this.shorthand = !tsNode.propertyName;
		// `{ ["resolution-mode"]: res }` — TS wraps a computed-key
		// destructure name in `ComputedPropertyName`. ESTree marks the
		// surrounding Property `computed: true`. no-useless-computed-key
		// reports computed keys whose value would be the same as the
		// non-computed form — the rule listens on `Property` and reads
		// `node.computed`.
		this.computed = !!tsNode.propertyName
			&& tsNode.propertyName.kind === SK.ComputedPropertyName;
	}
	get key() {
		if (this._key !== undefined) return this._key;
		const t = this._ts as ts.BindingElement;
		return this._key = convertChild(t.propertyName ?? t.name, this);
	}
	// `value` only exists on the Property variant (RestElement has none).
	// eager line 1015 sets value to convertPattern of the binding name.
	// When the BindingElement carries a default (`{a = 1}`), eager wraps
	// the value in an AssignmentPattern{left: <name>, right: <initializer>}.
	get value() {
		if (this.type !== 'Property') return undefined;
		if (this._value !== undefined) return this._value;
		const t = this._ts as ts.BindingElement;
		const inner = convertChildAsPattern(t.name, this);
		if (t.initializer) {
			return this._value = new BindingAssignmentPatternNode(t, this, inner!);
		}
		return this._value = inner;
	}
	get argument() {
		return this._argument ??= convertChild((this._ts as ts.BindingElement).name, this);
	}
}

class NullLiteralNode extends LazyNode {
	readonly type = 'Literal' as const;
	readonly value = null;
	readonly raw = 'null';
}

class SuperNode extends LazyNode {
	readonly type = 'Super' as const;
}

class ThisExpressionNode extends LazyNode {
	readonly type = 'ThisExpression' as const;
}

class TSTypeParameterNode extends LazyNode {
	readonly type = 'TSTypeParameter' as const;
	readonly const: boolean;
	readonly in: boolean;
	readonly out: boolean;
	private _name?: LazyNode | null;
	private _constraint?: LazyNode | null;
	private _default?: LazyNode | null;

	constructor(tsNode: ts.TypeParameterDeclaration, parent: LazyNode) {
		super(tsNode, parent);
		this.const = !!tsNode.modifiers?.some(m => m.kind === SK.ConstKeyword);
		this.in = !!tsNode.modifiers?.some(m => m.kind === SK.InKeyword);
		this.out = !!tsNode.modifiers?.some(m => m.kind === SK.OutKeyword);
	}
	get name() {
		return this._name ??= convertChild((this._ts as ts.TypeParameterDeclaration).name, this);
	}
	get constraint() {
		return this._constraint ??= convertChild((this._ts as ts.TypeParameterDeclaration).constraint, this);
	}
	get default() {
		return this._default ??= convertChild((this._ts as ts.TypeParameterDeclaration).default, this);
	}
}

class PrivateIdentifierNode extends LazyNode {
	readonly type = 'PrivateIdentifier' as const;
	readonly name: string;
	constructor(tsNode: ts.PrivateIdentifier, parent: LazyNode) {
		super(tsNode, parent);
		this.name = tsNode.text.slice(1);
	}
}

class TSTypeAssertionNode extends LazyNode {
	readonly type = 'TSTypeAssertion' as const;
	private _expression?: LazyNode | null;
	private _typeAnnotation?: LazyNode | null;
	get expression() {
		return this._expression ??= convertChild((this._ts as ts.TypeAssertion).expression, this);
	}
	get typeAnnotation() {
		return this._typeAnnotation ??= convertChild((this._ts as ts.TypeAssertion).type, this);
	}
}

class TSSatisfiesExpressionNode extends LazyNode {
	readonly type = 'TSSatisfiesExpression' as const;
	private _expression?: LazyNode | null;
	private _typeAnnotation?: LazyNode | null;
	get expression() {
		return this._expression ??= convertChild((this._ts as ts.SatisfiesExpression).expression, this);
	}
	get typeAnnotation() {
		return this._typeAnnotation ??= convertChild((this._ts as ts.SatisfiesExpression).type, this);
	}
}

class TSConstructorTypeNode extends LazyNode {
	readonly type = 'TSConstructorType' as const;
	readonly abstract: boolean;
	private _typeParameters?: LazyNode | undefined;
	private _params?: (LazyNode | null)[];
	private _returnType?: LazyNode | null | undefined;

	constructor(tsNode: ts.ConstructorTypeNode, parent: LazyNode) {
		super(tsNode, parent);
		this.abstract = !!tsNode.modifiers?.some(m => m.kind === SK.AbstractKeyword);
	}
	get typeParameters() {
		if (this._typeParameters !== undefined) return this._typeParameters;
		return this._typeParameters = convertTypeParameters((this._ts as ts.ConstructorTypeNode).typeParameters, this);
	}
	get params() {
		return this._params ??= convertChildren((this._ts as ts.ConstructorTypeNode).parameters, this);
	}
	get returnType() {
		if (this._returnType !== undefined) return this._returnType;
		const t = (this._ts as ts.ConstructorTypeNode).type;
		return this._returnType = t ? convertTypeAnnotation(t, this) : undefined;
	}
}

class TSMappedTypeNode extends LazyNode {
	readonly type = 'TSMappedType' as const;
	readonly readonly: boolean | '+' | '-' | undefined;
	readonly optional: boolean | '+' | '-';
	private _key?: LazyNode | null;
	private _constraint?: LazyNode | null;
	private _nameType?: LazyNode | null;
	private _typeAnnotation?: LazyNode | null;

	constructor(tsNode: ts.MappedTypeNode, parent: LazyNode) {
		super(tsNode, parent);
		// Asymmetry matches eager: readonly defaults to undefined, optional to false.
		this.readonly = tsNode.readonlyToken
			? (tsNode.readonlyToken.kind === SK.PlusToken ? '+' : tsNode.readonlyToken.kind === SK.MinusToken ? '-' : true)
			: undefined;
		this.optional = tsNode.questionToken
			? (tsNode.questionToken.kind === SK.PlusToken ? '+' : tsNode.questionToken.kind === SK.MinusToken ? '-' : true)
			: false;
	}
	get key() {
		return this._key ??= convertChild((this._ts as ts.MappedTypeNode).typeParameter.name, this);
	}
	get constraint() {
		return this._constraint ??= convertChild((this._ts as ts.MappedTypeNode).typeParameter.constraint, this);
	}
	get nameType() {
		return this._nameType ??= convertChild((this._ts as ts.MappedTypeNode).nameType, this) ?? null;
	}
	get typeAnnotation() {
		return this._typeAnnotation ??= convertChild((this._ts as ts.MappedTypeNode).type, this);
	}
}

class TSConditionalTypeNode extends LazyNode {
	readonly type = 'TSConditionalType' as const;
	private _checkType?: LazyNode | null;
	private _extendsType?: LazyNode | null;
	private _trueType?: LazyNode | null;
	private _falseType?: LazyNode | null;
	get checkType() {
		return this._checkType ??= convertChild((this._ts as ts.ConditionalTypeNode).checkType, this);
	}
	get extendsType() {
		return this._extendsType ??= convertChild((this._ts as ts.ConditionalTypeNode).extendsType, this);
	}
	get trueType() {
		return this._trueType ??= convertChild((this._ts as ts.ConditionalTypeNode).trueType, this);
	}
	get falseType() {
		return this._falseType ??= convertChild((this._ts as ts.ConditionalTypeNode).falseType, this);
	}
}

class TSInferTypeNode extends LazyNode {
	readonly type = 'TSInferType' as const;
	private _typeParameter?: LazyNode | null;
	get typeParameter() {
		return this._typeParameter ??= convertChild((this._ts as ts.InferTypeNode).typeParameter, this);
	}
}

class TSThisTypeNode extends LazyNode {
	readonly type = 'TSThisType' as const;
}

class TSTypePredicateNode extends LazyNode {
	readonly type = 'TSTypePredicate' as const;
	readonly asserts: boolean;
	private _parameterName?: LazyNode | null;
	private _typeAnnotation?: LazyNode | null;

	constructor(tsNode: ts.TypePredicateNode, parent: LazyNode) {
		super(tsNode, parent);
		this.asserts = tsNode.assertsModifier != null;
	}
	get parameterName() {
		return this._parameterName ??= convertChild((this._ts as ts.TypePredicateNode).parameterName, this);
	}
	get typeAnnotation() {
		if (this._typeAnnotation !== undefined) return this._typeAnnotation;
		const t = (this._ts as ts.TypePredicateNode).type;
		if (!t) return this._typeAnnotation = null;
		const wrapper = convertTypeAnnotation(t, this);
		// Eager (line 1908) overrides the wrapper's range to match the INNER
		// type — type predicates drop the colon-prefixed range. The range
		// setter invalidates loc, so the lazy getter recomputes from the
		// new range when needed.
		const inner = wrapper.typeAnnotation as { range: [number, number] } | null;
		if (inner) {
			(wrapper as unknown as { range: [number, number] }).range = inner.range;
		}
		return this._typeAnnotation = wrapper;
	}
}

class TSModuleDeclarationNode extends LazyNode {
	readonly type = 'TSModuleDeclaration' as const;
	readonly declare: boolean;
	readonly global: boolean;
	readonly kind: 'namespace' | 'module' | 'global';
	private _id?: LazyNode | null;
	private _body?: LazyNode | null;

	constructor(tsNode: ts.ModuleDeclaration, parent: LazyNode) {
		super(tsNode, parent);
		this.declare = !!tsNode.modifiers?.some(m => m.kind === SK.DeclareKeyword);
		this.global = !!(tsNode.flags & ts.NodeFlags.GlobalAugmentation);
		this.kind = tsNode.flags & ts.NodeFlags.Namespace ? 'namespace' : 'module';
	}
	get id() {
		return this._id ??= convertChild((this._ts as ts.ModuleDeclaration).name, this);
	}
	get body() {
		return this._body ??= convertChild((this._ts as ts.ModuleDeclaration).body, this);
	}
}

class TSModuleBlockNode extends LazyNode {
	readonly type = 'TSModuleBlock' as const;
	private _body?: (LazyNode | null)[];
	get body() {
		return this._body ??= convertChildren((this._ts as ts.ModuleBlock).statements, this);
	}
}

class TSEnumDeclarationNode extends LazyNode {
	readonly type = 'TSEnumDeclaration' as const;
	readonly const: boolean;
	readonly declare: boolean;
	private _id?: LazyNode | null;
	private _body?: TSEnumBodyNode;
	private _members?: (LazyNode | null)[];

	constructor(tsNode: ts.EnumDeclaration, parent: LazyNode) {
		super(tsNode, parent);
		this.const = !!tsNode.modifiers?.some(m => m.kind === SK.ConstKeyword);
		this.declare = !!tsNode.modifiers?.some(m => m.kind === SK.DeclareKeyword);
	}
	get id() {
		return this._id ??= convertChild((this._ts as ts.EnumDeclaration).name, this);
	}
	get body() {
		if (this._body) return this._body;
		const tsNode = this._ts as ts.EnumDeclaration;
		// typescript-estree v8 wraps members in a TSEnumBody whose range
		// covers the `{ … }` block. `members.pos` sits right after the `{`,
		// so `pos - 1` is the open-brace position; `tsNode.end` covers
		// past the closing `}`.
		return this._body = new TSEnumBodyNode(tsNode, this, [tsNode.members.pos - 1, tsNode.end]);
	}
	get members() {
		// Legacy field — typescript-estree still emits it alongside .body
		// (suppressDeprecatedPropertyWarnings hides the deprecation
		// notice). Keep mirror behaviour for parity.
		return this._members ??= convertChildren((this._ts as ts.EnumDeclaration).members, this);
	}
}

class TSEnumBodyNode extends LazyNode {
	readonly type = 'TSEnumBody' as const;
	private _members?: (LazyNode | null)[];
	constructor(enumTsNode: ts.EnumDeclaration, parent: LazyNode, range: [number, number]) {
		super(enumTsNode, parent, undefined, false);
		this.range = range;
	}
	get members() {
		return this._members ??= convertChildren((this._ts as ts.EnumDeclaration).members, this);
	}
}

class TSEnumMemberNode extends LazyNode {
	readonly type = 'TSEnumMember' as const;
	readonly computed: boolean;
	private _id?: LazyNode | null;
	private _initializer?: LazyNode | null;
	constructor(tsNode: ts.EnumMember, parent: LazyNode) {
		super(tsNode, parent);
		this.computed = tsNode.name.kind === SK.ComputedPropertyName;
	}
	get id() {
		return this._id ??= convertChild((this._ts as ts.EnumMember).name, this);
	}
	get initializer() {
		return this._initializer ??= convertChild((this._ts as ts.EnumMember).initializer, this);
	}
}

class DecoratorNode extends LazyNode {
	readonly type = 'Decorator' as const;
	private _expression?: LazyNode | null;
	get expression() {
		return this._expression ??= convertChild((this._ts as ts.Decorator).expression, this);
	}
}

// Pull `@dec` decorators out of a node's `modifiers` array. TS folds
// decorators and modifiers into one list since 4.8; typescript-estree
// emits them as a separate `decorators` slot on the owning ESTree node.
function convertDecorators(tsNode: ts.Node, parent: LazyNode): (LazyNode | null)[] {
	const modifiers = (tsNode as { modifiers?: ts.NodeArray<ts.ModifierLike> }).modifiers;
	if (!modifiers) return [];
	const out: (LazyNode | null)[] = [];
	for (const m of modifiers) {
		if (m.kind === SK.Decorator) {
			out.push(convertChild(m, parent));
		}
	}
	return out;
}

// Object/array literals + properties

// Pattern variants of array/object literals — used when the literal is on
// the LHS of an assignment or in another pattern context.
class ArrayPatternFromLiteralNode extends LazyNode {
	readonly type = 'ArrayPattern' as const;
	readonly decorators: never[] = EMPTY_ARRAY;
	readonly optional = false;
	readonly typeAnnotation = undefined;
	private _elements?: (LazyNode | null)[];
	get elements() {
		const ts_ = this._ts as ts.ArrayLiteralExpression;
		return this._elements ??= ts_.elements.map(e =>
			e.kind === SK.OmittedExpression ? null : convertChildAsPattern(e, this)
		);
	}
}

class ObjectPatternFromLiteralNode extends LazyNode {
	readonly type = 'ObjectPattern' as const;
	readonly decorators: never[] = EMPTY_ARRAY;
	readonly optional = false;
	readonly typeAnnotation = undefined;
	private _properties?: (LazyNode | null)[];
	get properties() {
		return this._properties ??= (this._ts as ts.ObjectLiteralExpression).properties.map(p =>
			convertChildAsPattern(p, this)
		);
	}
}

class ArrayExpressionNode extends LazyNode {
	readonly type = 'ArrayExpression' as const;
	private _elements?: (LazyNode | null)[];
	get elements() {
		const ts_ = this._ts as ts.ArrayLiteralExpression;
		return this._elements ??= ts_.elements.map(e => e.kind === SK.OmittedExpression ? null : convertChild(e, this));
	}
}

class ObjectExpressionNode extends LazyNode {
	readonly type = 'ObjectExpression' as const;
	private _properties?: (LazyNode | null)[];
	get properties() {
		return this._properties ??= convertChildren((this._ts as ts.ObjectLiteralExpression).properties, this);
	}
}

class PropertyAssignmentNode extends LazyNode {
	readonly type = 'Property' as const;
	readonly kind: 'init' = 'init';
	readonly method = false;
	readonly optional = false;
	readonly shorthand = false;
	readonly computed: boolean;
	private _key?: LazyNode | null;
	private _value?: LazyNode | null;
	constructor(tsNode: ts.PropertyAssignment, parent: LazyNode) {
		super(tsNode, parent);
		this.computed = tsNode.name.kind === SK.ComputedPropertyName;
	}
	get key() {
		return this._key ??= convertChild((this._ts as ts.PropertyAssignment).name, this);
	}
	get value() {
		return this._value ??= convertChild((this._ts as ts.PropertyAssignment).initializer, this);
	}
}

class ShorthandPropertyNode extends LazyNode {
	readonly type = 'Property' as const;
	readonly kind: 'init' = 'init';
	readonly method = false;
	readonly optional = false;
	readonly shorthand = true;
	readonly computed = false;
	private _key?: LazyNode | null;
	get key() {
		return this._key ??= convertChild((this._ts as ts.ShorthandPropertyAssignment).name, this);
	}
	get value() {
		return this.key;
	}
}

class TemplateLiteralNode extends LazyNode {
	readonly type = 'TemplateLiteral' as const;
	private _quasis?: object[];
	private _expressions?: (LazyNode | null)[];
	get quasis() {
		if (this._quasis) return this._quasis;
		const ts_ = this._ts as ts.TemplateExpression;
		const ast = this._ctx.ast;
		const out: object[] = [];
		const headRange: [number, number] = [ts_.head.getStart(ast), ts_.head.getEnd()];
		out.push({
			type: 'TemplateElement',
			tail: false,
			range: headRange,
			loc: getLocFor(ast, headRange[0], headRange[1]),
			value: { cooked: ts_.head.text, raw: ts_.head.getText(ast).slice(1, -2) },
		});
		for (const span of ts_.templateSpans) {
			const lit = span.literal;
			const isTail = lit.kind === SK.TemplateTail;
			const range: [number, number] = [lit.getStart(ast), lit.getEnd()];
			const raw = lit.getText(ast);
			out.push({
				type: 'TemplateElement',
				tail: isTail,
				range,
				loc: getLocFor(ast, range[0], range[1]),
				value: {
					cooked: lit.text,
					raw: isTail ? raw.slice(1, -1) : raw.slice(1, -2),
				},
			});
		}
		return this._quasis = out;
	}
	get expressions() {
		if (this._expressions) return this._expressions;
		const ts_ = this._ts as ts.TemplateExpression;
		return this._expressions = ts_.templateSpans.map(s => convertChild(s.expression, this));
	}
}

class RegExpLiteralNode extends LazyNode {
	readonly type = 'Literal' as const;
	readonly raw: string;
	readonly regex: { pattern: string; flags: string };
	private _value?: RegExp | null;
	private _valueComputed = false;
	constructor(tsNode: ts.RegularExpressionLiteral, parent: LazyNode) {
		super(tsNode, parent);
		this.raw = tsNode.text;
		const m = /^\/(.+)\/([gimsuy]*)$/.exec(tsNode.text);
		const pattern = m?.[1] ?? '';
		const flags = m?.[2] ?? '';
		this.regex = { pattern, flags };
	}
	get value(): RegExp | null {
		// `new RegExp(pattern, flags)` parses + compiles — only worth paying
		// for rules that actually evaluate the regex (rare; most read
		// `.regex.pattern` / `.regex.flags`).
		if (this._valueComputed) return this._value as RegExp | null;
		this._valueComputed = true;
		try {
			return this._value = new RegExp(this.regex.pattern, this.regex.flags);
		}
		catch {
			return this._value = null;
		}
	}
}

class ThrowStatementNode extends LazyNode {
	readonly type = 'ThrowStatement' as const;
	private _argument?: LazyNode | null;
	get argument() {
		return this._argument ??= convertChild((this._ts as ts.ThrowStatement).expression, this);
	}
}

class TryStatementNode extends LazyNode {
	readonly type = 'TryStatement' as const;
	private _block?: LazyNode | null;
	private _handler?: LazyNode | null;
	private _finalizer?: LazyNode | null;
	get block() {
		return this._block ??= convertChild((this._ts as ts.TryStatement).tryBlock, this);
	}
	get handler() {
		return this._handler ??= convertChild((this._ts as ts.TryStatement).catchClause, this);
	}
	get finalizer() {
		return this._finalizer ??= convertChild((this._ts as ts.TryStatement).finallyBlock, this);
	}
}

class CatchClauseNode extends LazyNode {
	readonly type = 'CatchClause' as const;
	private _param?: LazyNode | null;
	private _body?: LazyNode | null;
	get param() {
		const decl = (this._ts as ts.CatchClause).variableDeclaration;
		return this._param ??= decl ? convertChild(decl.name, this) : null;
	}
	get body() {
		return this._body ??= convertChild((this._ts as ts.CatchClause).block, this);
	}
}

class WhileStatementNode extends LazyNode {
	readonly type = 'WhileStatement' as const;
	private _test?: LazyNode | null;
	private _body?: LazyNode | null;
	get test() {
		return this._test ??= convertChild((this._ts as ts.WhileStatement).expression, this);
	}
	get body() {
		return this._body ??= convertChild((this._ts as ts.WhileStatement).statement, this);
	}
}

class DoWhileStatementNode extends LazyNode {
	readonly type = 'DoWhileStatement' as const;
	private _test?: LazyNode | null;
	private _body?: LazyNode | null;
	get test() {
		return this._test ??= convertChild((this._ts as ts.DoStatement).expression, this);
	}
	get body() {
		return this._body ??= convertChild((this._ts as ts.DoStatement).statement, this);
	}
}

class ForStatementNode extends LazyNode {
	readonly type = 'ForStatement' as const;
	private _init?: LazyNode | null;
	private _test?: LazyNode | null;
	private _update?: LazyNode | null;
	private _body?: LazyNode | null;
	get init() {
		return this._init ??= convertChild((this._ts as ts.ForStatement).initializer, this);
	}
	get test() {
		return this._test ??= convertChild((this._ts as ts.ForStatement).condition, this);
	}
	get update() {
		return this._update ??= convertChild((this._ts as ts.ForStatement).incrementor, this);
	}
	get body() {
		return this._body ??= convertChild((this._ts as ts.ForStatement).statement, this);
	}
}

class ForInStatementNode extends LazyNode {
	readonly type = 'ForInStatement' as const;
	private _left?: LazyNode | null;
	private _right?: LazyNode | null;
	private _body?: LazyNode | null;
	get left() {
		// `for ([a, b] in obj)` — LHS is a destructuring pattern.
		return this._left ??= convertChildAsPattern((this._ts as ts.ForInStatement).initializer, this);
	}
	get right() {
		return this._right ??= convertChild((this._ts as ts.ForInStatement).expression, this);
	}
	get body() {
		return this._body ??= convertChild((this._ts as ts.ForInStatement).statement, this);
	}
}

class ForOfStatementNode extends LazyNode {
	readonly type = 'ForOfStatement' as const;
	readonly await: boolean;
	private _left?: LazyNode | null;
	private _right?: LazyNode | null;
	private _body?: LazyNode | null;
	constructor(tsNode: ts.ForOfStatement, parent: LazyNode) {
		super(tsNode, parent);
		this.await = !!tsNode.awaitModifier;
	}
	get left() {
		// `for ([a, b] of items)` — LHS is a destructuring pattern.
		return this._left ??= convertChildAsPattern((this._ts as ts.ForOfStatement).initializer, this);
	}
	get right() {
		return this._right ??= convertChild((this._ts as ts.ForOfStatement).expression, this);
	}
	get body() {
		return this._body ??= convertChild((this._ts as ts.ForOfStatement).statement, this);
	}
}

class SwitchStatementNode extends LazyNode {
	readonly type = 'SwitchStatement' as const;
	private _discriminant?: LazyNode | null;
	private _cases?: (LazyNode | null)[];
	get discriminant() {
		return this._discriminant ??= convertChild((this._ts as ts.SwitchStatement).expression, this);
	}
	get cases() {
		return this._cases ??= convertChildren((this._ts as ts.SwitchStatement).caseBlock.clauses, this);
	}
}

class SwitchCaseNode extends LazyNode {
	readonly type = 'SwitchCase' as const;
	private _test?: LazyNode | null;
	private _consequent?: (LazyNode | null)[];
	get test() {
		const ts_ = this._ts as ts.CaseClause | ts.DefaultClause;
		return this._test ??= ts_.kind === SK.CaseClause ? convertChild(ts_.expression, this) : null;
	}
	get consequent() {
		return this._consequent ??= convertChildren((this._ts as ts.CaseClause | ts.DefaultClause).statements, this);
	}
}

class BreakOrContinueNode extends LazyNode {
	readonly type: 'BreakStatement' | 'ContinueStatement';
	private _label?: LazyNode | null;
	constructor(type: 'BreakStatement' | 'ContinueStatement', tsNode: ts.BreakOrContinueStatement, parent: LazyNode) {
		super(tsNode, parent);
		this.type = type;
	}
	get label() {
		return this._label ??= convertChild((this._ts as ts.BreakOrContinueStatement).label, this);
	}
}

class LabeledStatementNode extends LazyNode {
	readonly type = 'LabeledStatement' as const;
	private _label?: LazyNode | null;
	private _body?: LazyNode | null;
	get label() {
		return this._label ??= convertChild((this._ts as ts.LabeledStatement).label, this);
	}
	get body() {
		return this._body ??= convertChild((this._ts as ts.LabeledStatement).statement, this);
	}
}

class EmptyStatementNode extends LazyNode {
	readonly type = 'EmptyStatement' as const;
}

class AwaitExpressionNode extends LazyNode {
	readonly type = 'AwaitExpression' as const;
	private _argument?: LazyNode | null;
	get argument() {
		return this._argument ??= convertChild((this._ts as ts.AwaitExpression).expression, this);
	}
}

class YieldExpressionNode extends LazyNode {
	readonly type = 'YieldExpression' as const;
	readonly delegate: boolean;
	private _argument?: LazyNode | null;
	constructor(tsNode: ts.YieldExpression, parent: LazyNode) {
		super(tsNode, parent);
		this.delegate = !!tsNode.asteriskToken;
	}
	get argument() {
		return this._argument ??= convertChild((this._ts as ts.YieldExpression).expression, this);
	}
}

class TSTupleTypeNode extends LazyNode {
	readonly type = 'TSTupleType' as const;
	private _elementTypes?: (LazyNode | null)[];
	get elementTypes() {
		return this._elementTypes ??= convertChildren((this._ts as ts.TupleTypeNode).elements, this);
	}
}

// NamedTupleMember: with `...` becomes TSRestType wrapping the member.
function convertNamedTupleMember(tsNode: ts.NamedTupleMember, parent: LazyNode): LazyNode {
	if (tsNode.dotDotDotToken) {
		return new TSRestTypeWrappingNamedTupleMemberNode(tsNode, parent);
	}
	return new TSNamedTupleMemberNode(tsNode, parent);
}

class TSNamedTupleMemberNode extends LazyNode {
	readonly type = 'TSNamedTupleMember' as const;
	readonly optional: boolean;
	private _label?: LazyNode | null;
	private _elementType?: LazyNode | null;
	constructor(tsNode: ts.NamedTupleMember, parent: LazyNode) {
		super(tsNode, parent);
		this.optional = tsNode.questionToken != null;
	}
	get label() {
		return this._label ??= convertChild((this._ts as ts.NamedTupleMember).name, this);
	}
	get elementType() {
		return this._elementType ??= convertChild((this._ts as ts.NamedTupleMember).type, this);
	}
}

class TSRestTypeWrappingNamedTupleMemberNode extends LazyNode {
	readonly type = 'TSRestType' as const;
	private _typeAnnotation?: TSNamedTupleMemberNode;
	get typeAnnotation() {
		if (this._typeAnnotation) return this._typeAnnotation;
		const inner = new TSNamedTupleMemberNode(this._ts as ts.NamedTupleMember, this);
		// Eager (line 2173) UNCONDITIONALLY moves the inner's range[0] to
		// the label's start to skip the leading `...`. Our _extendRange
		// only extends; do a direct set instead.
		const lbl = inner.label as { range: [number, number] } | null;
		if (lbl) {
			(inner as unknown as { range: [number, number] }).range = [lbl.range[0], inner.range[1]];
		}
		return this._typeAnnotation = inner;
	}
}

class TSOptionalTypeNode extends LazyNode {
	readonly type = 'TSOptionalType' as const;
	private _typeAnnotation?: LazyNode | null;
	get typeAnnotation() {
		return this._typeAnnotation ??= convertChild((this._ts as ts.OptionalTypeNode).type, this);
	}
}

class TSRestTypeNode extends LazyNode {
	readonly type = 'TSRestType' as const;
	private _typeAnnotation?: LazyNode | null;
	get typeAnnotation() {
		return this._typeAnnotation ??= convertChild((this._ts as ts.RestTypeNode).type, this);
	}
}

class ConditionalExpressionNode extends LazyNode {
	readonly type = 'ConditionalExpression' as const;
	private _test?: LazyNode | null;
	private _consequent?: LazyNode | null;
	private _alternate?: LazyNode | null;
	get test() {
		return this._test ??= convertChild((this._ts as ts.ConditionalExpression).condition, this);
	}
	get consequent() {
		return this._consequent ??= convertChild((this._ts as ts.ConditionalExpression).whenTrue, this);
	}
	get alternate() {
		return this._alternate ??= convertChild((this._ts as ts.ConditionalExpression).whenFalse, this);
	}
}

class NewExpressionNode extends LazyNode {
	readonly type = 'NewExpression' as const;
	readonly typeParameters = undefined;
	private _callee?: LazyNode | null;
	private _arguments?: (LazyNode | null)[];
	private _typeArguments?: LazyNode | undefined;
	get callee() {
		return this._callee ??= convertChild((this._ts as ts.NewExpression).expression, this);
	}
	get arguments() {
		return this._arguments ??= convertChildren((this._ts as ts.NewExpression).arguments ?? [], this);
	}
	get typeArguments() {
		if (this._typeArguments !== undefined) return this._typeArguments;
		return this._typeArguments = convertTypeArguments((this._ts as ts.NewExpression).typeArguments, this);
	}
}

// Template literal types (`` `hello ${T}` `` in type position). Like
// TemplateLiteralNode but the spans interleave with TYPE nodes (not
// expressions). typescript-estree shape:
//   { type: 'TSTemplateLiteralType', quasis: TemplateElement[], types: TypeNode[] }
class TSTemplateLiteralTypeNode extends LazyNode {
	readonly type = 'TSTemplateLiteralType' as const;
	private _quasis?: object[];
	private _types?: (LazyNode | null)[];
	get quasis() {
		if (this._quasis) return this._quasis;
		const ts_ = this._ts as ts.TemplateLiteralTypeNode;
		const ast = this._ctx.ast;
		const out: object[] = [];
		const headRange: [number, number] = [ts_.head.getStart(ast), ts_.head.getEnd()];
		out.push({
			type: 'TemplateElement',
			tail: false,
			range: headRange,
			loc: getLocFor(ast, headRange[0], headRange[1]),
			value: { cooked: ts_.head.text, raw: ts_.head.getText(ast).slice(1, -2) },
		});
		for (const span of ts_.templateSpans) {
			const lit = span.literal;
			const isTail = lit.kind === SK.TemplateTail;
			const range: [number, number] = [lit.getStart(ast), lit.getEnd()];
			const raw = lit.getText(ast);
			out.push({
				type: 'TemplateElement',
				tail: isTail,
				range,
				loc: getLocFor(ast, range[0], range[1]),
				value: {
					cooked: lit.text,
					raw: isTail ? raw.slice(1, -1) : raw.slice(1, -2),
				},
			});
		}
		return this._quasis = out;
	}
	get types() {
		if (this._types) return this._types;
		const ts_ = this._ts as ts.TemplateLiteralTypeNode;
		return this._types = ts_.templateSpans.map(s => convertChild(s.type, this));
	}
}

// `` tag`hello ${x}` `` — function call with template literal as argument.
// typescript-estree shape: { type: 'TaggedTemplateExpression', tag, quasi,
// typeArguments? }. quasi is the TemplateLiteral itself (re-using the
// existing TemplateLiteralNode / NoSubstitutionTemplateNode classes).
class TaggedTemplateExpressionNode extends LazyNode {
	readonly type = 'TaggedTemplateExpression' as const;
	private _tag?: LazyNode | null;
	private _quasi?: LazyNode | null;
	private _typeArguments?: LazyNode | undefined;
	get tag() {
		return this._tag ??= convertChild((this._ts as ts.TaggedTemplateExpression).tag, this);
	}
	get quasi() {
		return this._quasi ??= convertChild((this._ts as ts.TaggedTemplateExpression).template, this);
	}
	get typeArguments() {
		if (this._typeArguments !== undefined) return this._typeArguments;
		return this._typeArguments = convertTypeArguments(
			(this._ts as ts.TaggedTemplateExpression).typeArguments,
			this,
		);
	}
}

// NoSubstitutionTemplateLiteral: backtick string with no `${}`. Maps to a
// TemplateLiteral with a single quasi.
class NoSubstitutionTemplateNode extends LazyNode {
	readonly type = 'TemplateLiteral' as const;
	readonly expressions: never[] = EMPTY_ARRAY;
	private _quasis?: object[];
	get quasis(): object[] {
		// Defer: builds a synthesized TemplateElement that reads `range`/`loc`
		// (each lazy on its own) and runs `getText(ast)` (scanner walk for
		// the raw slice). Most rules look at `node.type` / `node.expressions`,
		// not at the synthesized quasi.
		if (this._quasis) return this._quasis;
		const tsNode = this._ts as ts.NoSubstitutionTemplateLiteral;
		return this._quasis = [
			{
				type: 'TemplateElement',
				tail: true,
				range: this.range,
				loc: this.loc,
				value: { cooked: tsNode.text, raw: tsNode.getText(this._ctx.ast).slice(1, -1) },
			},
		];
	}
}

class RestElementFromSpreadNode extends LazyNode {
	readonly type = 'RestElement' as const;
	readonly decorators: never[] = EMPTY_ARRAY;
	readonly optional = false;
	readonly value = undefined;
	readonly typeAnnotation = undefined;
	private _argument?: LazyNode | null;
	get argument() {
		return this._argument ??= convertChildAsPattern(
			(this._ts as ts.SpreadElement | ts.SpreadAssignment).expression,
			this,
		);
	}
}

class SpreadElementNode extends LazyNode {
	readonly type = 'SpreadElement' as const;
	private _argument?: LazyNode | null;
	get argument() {
		return this._argument ??= convertChild(
			(this._ts as ts.SpreadElement | ts.SpreadAssignment).expression,
			this,
		);
	}
}

class TSTypeAliasDeclarationNode extends LazyNode {
	readonly type = 'TSTypeAliasDeclaration' as const;
	readonly declare: boolean;
	private _typeParameters?: LazyNode | undefined;
	private _id?: LazyNode | null;
	private _typeAnnotation?: LazyNode | null;

	constructor(tsNode: ts.TypeAliasDeclaration, parent: LazyNode) {
		super(tsNode, parent);
		this.declare = !!tsNode.modifiers?.some(m => m.kind === SK.DeclareKeyword);
	}
	get id() {
		return this._id ??= convertChild((this._ts as ts.TypeAliasDeclaration).name, this);
	}
	get typeParameters() {
		if (this._typeParameters !== undefined) return this._typeParameters;
		return this._typeParameters = convertTypeParameters((this._ts as ts.TypeAliasDeclaration).typeParameters, this);
	}
	get typeAnnotation() {
		return this._typeAnnotation ??= convertChild((this._ts as ts.TypeAliasDeclaration).type, this);
	}
}

// Prefix/postfix unary expressions: ++/-- become UpdateExpression, others
// become UnaryExpression (matches typescript-estree's split at line 2188).
class UnaryLikeExpressionNode extends LazyNode {
	readonly type: 'UpdateExpression' | 'UnaryExpression';
	readonly operator: string;
	readonly prefix: boolean;
	private _argument?: LazyNode | null;

	constructor(tsNode: ts.PrefixUnaryExpression | ts.PostfixUnaryExpression, parent: LazyNode, prefix: boolean) {
		super(tsNode, parent);
		this.prefix = prefix;
		const tokenKind = tsNode.operator;
		const op = tokenKind === SK.PlusPlusToken
			? '++'
			: tokenKind === SK.MinusMinusToken
			? '--'
			: tokenKind === SK.PlusToken
			? '+'
			: tokenKind === SK.MinusToken
			? '-'
			: tokenKind === SK.ExclamationToken
			? '!'
			: tokenKind === SK.TildeToken
			? '~'
			: '?';
		this.operator = op;
		this.type = (op === '++' || op === '--') ? 'UpdateExpression' : 'UnaryExpression';
	}
	get argument() {
		return this._argument ??= convertChild(
			(this._ts as ts.PrefixUnaryExpression | ts.PostfixUnaryExpression).operand,
			this,
		);
	}
}

class TypeofExpressionNode extends LazyNode {
	readonly type = 'UnaryExpression' as const;
	readonly operator = 'typeof' as const;
	readonly prefix = true as const;
	private _argument?: LazyNode | null;
	get argument() {
		return this._argument ??= convertChild((this._ts as ts.TypeOfExpression).expression, this);
	}
}

class TSNonNullExpressionNode extends LazyNode {
	readonly type = 'TSNonNullExpression' as const;
	private _expression?: LazyNode | null;
	get expression() {
		return this._expression ??= convertChild((this._ts as ts.NonNullExpression).expression, this);
	}
}

// Export forms — typescript-estree picks ExportNamedDeclaration vs
// ExportAllDeclaration vs ExportDefaultDeclaration vs TSExportAssignment
// based on the structure. Mirror.
function convertExportDeclaration(tsNode: ts.ExportDeclaration, parent: LazyNode): LazyNode {
	if (tsNode.exportClause?.kind === SK.NamedExports) {
		return new ExportNamedDeclarationNode(tsNode, parent);
	}
	return new ExportAllDeclarationNode(tsNode, parent);
}

function convertExportAssignment(tsNode: ts.ExportAssignment, parent: LazyNode): LazyNode {
	if (tsNode.isExportEquals) {
		return new TSExportAssignmentNode(tsNode, parent);
	}
	return new ExportDefaultDeclarationNode(tsNode, parent);
}

// ExpressionWithTypeArguments — three possible ESTree types depending on parent.
class ExpressionWithTypeArgumentsNode extends LazyNode {
	readonly type: 'TSInterfaceHeritage' | 'TSClassImplements' | 'TSInstantiationExpression';
	private _expression?: LazyNode | null;
	private _typeArguments?: LazyNode | undefined;

	constructor(
		tsNode: ts.ExpressionWithTypeArguments,
		parent: LazyNode,
		type: 'TSInterfaceHeritage' | 'TSClassImplements' | 'TSInstantiationExpression',
	) {
		super(tsNode, parent);
		this.type = type;
	}
	get expression() {
		return this._expression ??= convertChild((this._ts as ts.ExpressionWithTypeArguments).expression, this);
	}
	get typeArguments() {
		if (this._typeArguments !== undefined) return this._typeArguments;
		return this._typeArguments = convertTypeArguments((this._ts as ts.ExpressionWithTypeArguments).typeArguments, this);
	}
}

// upstream: `@typescript-eslint/typescript-estree/dist/ts-estree/.../convert.ts`
// `convertExportDeclaration` creates an
// `AST_NODE_TYPES.ExportNamedDeclaration` whose `.declaration` is the
// converted inner statement, with `inner.parent = wrapper` re-pointed.
//
// We mirror the SAME shape but the wrapper claims the TS node's slot
// in `tsNodeToESTreeNodeMap` (so `materialize(declaration_TsNode)`
// returns the wrapper, not the inner). Rules that listen on the
// inner type (FunctionDeclaration, ClassDeclaration) use
// `scope.block === node` and `def.node === node` to identify their
// scope — `TsScope.block` and `TsDefinition.node` unwrap the
// wrapper there.
class ExportNamedWrappingNode extends LazyNode {
	readonly type = 'ExportNamedDeclaration' as const;
	readonly attributes: never[] = EMPTY_ARRAY;
	readonly assertions: never[] = EMPTY_ARRAY;
	readonly source = null;
	readonly specifiers: never[] = EMPTY_ARRAY;
	readonly exportKind: 'value' | 'type';
	readonly declaration: LazyNode;
	constructor(tsNode: ts.Node, parent: LazyNode, declaration: LazyNode, range: [number, number]) {
		super(tsNode, parent, undefined, false);
		this.range = range;
		// Inner gets re-pointed to us in the maps (eager registers the
		// wrapper as the canonical mapping for the original TS node) AND
		// inner.parent must point to us, not to the original Program /
		// ModuleBlock — typescript-estree's shape is
		// `Program → ExportNamedDeclaration → FunctionDeclaration`, so
		// rules that gate on `node.parent.type` being a statement-list
		// parent (padding-line-between-statements, no-redeclare, …) rely
		// on this. ChainExpressionWrappingNode / TSTypeQueryWrappingNode
		// already do the same.
		(declaration as { parent: LazyNode }).parent = this;
		this._ctx.maps.tsNodeToESTreeNodeMap.set(tsNode, this);
		this.declaration = declaration;
		const isType = declaration.type === 'TSInterfaceDeclaration'
			|| declaration.type === 'TSTypeAliasDeclaration';
		const isDeclare = !!(declaration as unknown as { declare?: boolean }).declare;
		this.exportKind = isType || isDeclare ? 'type' : 'value';
	}
}

class ExportDefaultWrappingNode extends LazyNode {
	readonly type = 'ExportDefaultDeclaration' as const;
	readonly exportKind: 'value' = 'value';
	readonly declaration: LazyNode;
	constructor(tsNode: ts.Node, parent: LazyNode, declaration: LazyNode, range: [number, number]) {
		super(tsNode, parent, undefined, false);
		this.range = range;
		(declaration as { parent: LazyNode }).parent = this;
		this._ctx.maps.tsNodeToESTreeNodeMap.set(tsNode, this);
		this.declaration = declaration;
	}
}

class ExportNamedDeclarationNode extends LazyNode {
	readonly type = 'ExportNamedDeclaration' as const;
	readonly declaration = null;
	readonly exportKind: 'value' | 'type';
	readonly attributes: never[] = EMPTY_ARRAY;
	readonly assertions: never[] = EMPTY_ARRAY;
	private _source?: LazyNode | null;
	private _specifiers?: (LazyNode | null)[];

	constructor(tsNode: ts.ExportDeclaration, parent: LazyNode) {
		super(tsNode, parent);
		this.exportKind = tsNode.isTypeOnly ? 'type' : 'value';
	}
	get source() {
		return this._source ??= convertChild((this._ts as ts.ExportDeclaration).moduleSpecifier, this);
	}
	get specifiers() {
		if (this._specifiers !== undefined) return this._specifiers;
		const clause = (this._ts as ts.ExportDeclaration).exportClause;
		if (clause?.kind === SK.NamedExports) {
			return this._specifiers = convertChildren(clause.elements, this);
		}
		return this._specifiers = [];
	}
}

class ExportAllDeclarationNode extends LazyNode {
	readonly type = 'ExportAllDeclaration' as const;
	readonly exportKind: 'value' | 'type';
	readonly attributes: never[] = EMPTY_ARRAY;
	readonly assertions: never[] = EMPTY_ARRAY;
	private _exported?: LazyNode | null;
	private _source?: LazyNode | null;

	constructor(tsNode: ts.ExportDeclaration, parent: LazyNode) {
		super(tsNode, parent);
		this.exportKind = tsNode.isTypeOnly ? 'type' : 'value';
	}
	get exported() {
		if (this._exported !== undefined) return this._exported;
		const clause = (this._ts as ts.ExportDeclaration).exportClause;
		return this._exported = clause?.kind === SK.NamespaceExport ? convertChild(clause.name, this) : null;
	}
	get source() {
		return this._source ??= convertChild((this._ts as ts.ExportDeclaration).moduleSpecifier, this);
	}
}

class ExportSpecifierNode extends LazyNode {
	readonly type = 'ExportSpecifier' as const;
	readonly exportKind: 'value' | 'type';
	private _exported?: LazyNode | null;
	private _local?: LazyNode | null;

	constructor(tsNode: ts.ExportSpecifier, parent: LazyNode) {
		super(tsNode, parent);
		this.exportKind = tsNode.isTypeOnly ? 'type' : 'value';
	}
	get exported() {
		return this._exported ??= convertChild((this._ts as ts.ExportSpecifier).name, this);
	}
	get local() {
		const ts_ = this._ts as ts.ExportSpecifier;
		return this._local ??= convertChild(ts_.propertyName ?? ts_.name, this);
	}
}

class ExportDefaultDeclarationNode extends LazyNode {
	readonly type = 'ExportDefaultDeclaration' as const;
	readonly exportKind: 'value' = 'value';
	private _declaration?: LazyNode | null;

	get declaration() {
		return this._declaration ??= convertChild((this._ts as ts.ExportAssignment).expression, this);
	}
}

class TSExportAssignmentNode extends LazyNode {
	readonly type = 'TSExportAssignment' as const;
	private _expression?: LazyNode | null;

	get expression() {
		return this._expression ??= convertChild((this._ts as ts.ExportAssignment).expression, this);
	}
}

class TSImportEqualsDeclarationNode extends LazyNode {
	readonly type = 'TSImportEqualsDeclaration' as const;
	readonly importKind: 'value' | 'type';
	private _id?: LazyNode | null;
	private _moduleReference?: LazyNode | null;

	constructor(tsNode: ts.ImportEqualsDeclaration, parent: LazyNode) {
		super(tsNode, parent);
		this.importKind = tsNode.isTypeOnly ? 'type' : 'value';
	}
	get id() {
		return this._id ??= convertChild((this._ts as ts.ImportEqualsDeclaration).name, this);
	}
	get moduleReference() {
		return this._moduleReference ??= convertChild((this._ts as ts.ImportEqualsDeclaration).moduleReference, this);
	}
}

class TSExternalModuleReferenceNode extends LazyNode {
	readonly type = 'TSExternalModuleReference' as const;
	private _expression?: LazyNode | null;
	get expression() {
		return this._expression ??= convertChild((this._ts as ts.ExternalModuleReference).expression, this);
	}
}

// CallSignature + ConstructSignature share a shape — params + returnType +
// typeParameters. typescript-estree picks the type literal at construction.
class TSCallishSignatureNode extends LazyNode {
	readonly type: 'TSCallSignatureDeclaration' | 'TSConstructSignatureDeclaration';
	private _typeParameters?: LazyNode | undefined;
	private _params?: (LazyNode | null)[];
	private _returnType?: LazyNode | null | undefined;

	constructor(
		type: 'TSCallSignatureDeclaration' | 'TSConstructSignatureDeclaration',
		tsNode: ts.SignatureDeclarationBase,
		parent: LazyNode,
	) {
		super(tsNode, parent);
		this.type = type;
	}
	get typeParameters() {
		if (this._typeParameters !== undefined) return this._typeParameters;
		return this._typeParameters = convertTypeParameters((this._ts as ts.SignatureDeclarationBase).typeParameters, this);
	}
	get params() {
		return this._params ??= convertChildren((this._ts as ts.SignatureDeclarationBase).parameters, this);
	}
	get returnType() {
		if (this._returnType !== undefined) return this._returnType;
		const t = (this._ts as ts.SignatureDeclarationBase).type;
		return this._returnType = t ? convertTypeAnnotation(t, this) : undefined;
	}
}

class TSIndexSignatureNode extends LazyNode {
	readonly type = 'TSIndexSignature' as const;
	readonly accessibility = undefined;
	readonly readonly: boolean;
	readonly static: boolean;
	private _parameters?: (LazyNode | null)[];
	private _typeAnnotation?: LazyNode | null | undefined;

	constructor(tsNode: ts.IndexSignatureDeclaration, parent: LazyNode) {
		super(tsNode, parent);
		this.readonly = !!tsNode.modifiers?.some(m => m.kind === SK.ReadonlyKeyword);
		this.static = !!tsNode.modifiers?.some(m => m.kind === SK.StaticKeyword);
	}
	get parameters() {
		return this._parameters ??= convertChildren((this._ts as ts.IndexSignatureDeclaration).parameters, this);
	}
	get typeAnnotation() {
		if (this._typeAnnotation !== undefined) return this._typeAnnotation;
		const t = (this._ts as ts.IndexSignatureDeclaration).type;
		return this._typeAnnotation = t ? convertTypeAnnotation(t, this) : undefined;
	}
}

// Interface — `body` is wrapped in a synthetic TSInterfaceBody whose range
// starts one char before the first member (the `{`). MVP skips
// heritageClauses + typeParameters (the `extends` and generics array).
class TSInterfaceDeclarationNode extends LazyNode {
	readonly type = 'TSInterfaceDeclaration' as const;
	readonly declare: boolean;
	private _typeParameters?: LazyNode | undefined;
	private _body?: TSInterfaceBodyNode;
	private _id?: LazyNode | null;
	private _extends?: (LazyNode | null)[];

	constructor(tsNode: ts.InterfaceDeclaration, parent: LazyNode) {
		super(tsNode, parent);
		this.declare = !!tsNode.modifiers?.some(m => m.kind === SK.DeclareKeyword);
	}
	get id() {
		return this._id ??= convertChild((this._ts as ts.InterfaceDeclaration).name, this);
	}
	get extends() {
		if (this._extends) return this._extends;
		const ext = (this._ts as ts.InterfaceDeclaration).heritageClauses
			?.filter(h => h.token === SK.ExtendsKeyword)
			.flatMap(h => h.types.map(t => convertChild(t, this)));
		return this._extends = ext ?? [];
	}
	get typeParameters() {
		if (this._typeParameters !== undefined) return this._typeParameters;
		return this._typeParameters = convertTypeParameters((this._ts as ts.InterfaceDeclaration).typeParameters, this);
	}
	get body() {
		if (this._body) return this._body;
		const ts_ = this._ts as ts.InterfaceDeclaration;
		const range: [number, number] = [ts_.members.pos - 1, ts_.end];
		return this._body = new TSInterfaceBodyNode(ts_, this, range);
	}
}

class TSInterfaceBodyNode extends LazyNode {
	readonly type = 'TSInterfaceBody' as const;
	private _body?: (LazyNode | null)[];

	constructor(interfaceTsNode: ts.InterfaceDeclaration, parent: LazyNode, range: [number, number]) {
		// Synthetic — body is the same `{` block as the interface, no
		// independent TS node, so don't pollute the maps.
		super(interfaceTsNode, parent, undefined, false);
		this.range = range;
	}
	get body() {
		return this._body ??= convertChildren((this._ts as ts.InterfaceDeclaration).members, this);
	}
}

class TSPropertySignatureNode extends LazyNode {
	readonly type = 'TSPropertySignature' as const;
	readonly accessibility = undefined;
	readonly computed: boolean;
	readonly optional: boolean;
	readonly readonly: boolean;
	readonly static: boolean;
	private _key?: LazyNode | null;
	private _typeAnnotation?: LazyNode | null | undefined;

	constructor(tsNode: ts.PropertySignature, parent: LazyNode) {
		super(tsNode, parent);
		this.computed = tsNode.name.kind === SK.ComputedPropertyName;
		this.optional = !!tsNode.questionToken;
		this.readonly = !!tsNode.modifiers?.some(m => m.kind === SK.ReadonlyKeyword);
		this.static = !!tsNode.modifiers?.some(m => m.kind === SK.StaticKeyword);
	}
	get key() {
		return this._key ??= convertChild((this._ts as ts.PropertySignature).name, this);
	}
	get typeAnnotation() {
		if (this._typeAnnotation !== undefined) return this._typeAnnotation;
		const t = (this._ts as ts.PropertySignature).type;
		return this._typeAnnotation = t ? convertTypeAnnotation(t, this) : undefined;
	}
}

class TSMethodSignatureNode extends LazyNode {
	readonly type = 'TSMethodSignature' as const;
	readonly accessibility = undefined;
	readonly computed: boolean;
	readonly optional: boolean;
	readonly readonly: boolean;
	readonly static: boolean;
	readonly kind: 'method' = 'method';
	private _typeParameters?: LazyNode | undefined;
	private _key?: LazyNode | null;
	private _params?: (LazyNode | null)[];
	private _returnType?: LazyNode | null | undefined;

	constructor(tsNode: ts.MethodSignature, parent: LazyNode) {
		super(tsNode, parent);
		this.computed = tsNode.name.kind === SK.ComputedPropertyName;
		this.optional = !!tsNode.questionToken;
		this.readonly = !!tsNode.modifiers?.some(m => m.kind === SK.ReadonlyKeyword);
		this.static = !!tsNode.modifiers?.some(m => m.kind === SK.StaticKeyword);
	}
	get typeParameters() {
		if (this._typeParameters !== undefined) return this._typeParameters;
		return this._typeParameters = convertTypeParameters((this._ts as ts.MethodSignature).typeParameters, this);
	}
	get key() {
		return this._key ??= convertChild((this._ts as ts.MethodSignature).name, this);
	}
	get params() {
		return this._params ??= convertChildren((this._ts as ts.MethodSignature).parameters, this);
	}
	get returnType() {
		if (this._returnType !== undefined) return this._returnType;
		const t = (this._ts as ts.MethodSignature).type;
		return this._returnType = t ? convertTypeAnnotation(t, this) : undefined;
	}
}

class TSFunctionTypeNode extends LazyNode {
	readonly type = 'TSFunctionType' as const;
	private _typeParameters?: LazyNode | undefined;
	private _params?: (LazyNode | null)[];
	private _returnType?: LazyNode | null | undefined;

	get typeParameters() {
		if (this._typeParameters !== undefined) return this._typeParameters;
		return this._typeParameters = convertTypeParameters((this._ts as ts.FunctionTypeNode).typeParameters, this);
	}
	get params() {
		return this._params ??= convertChildren((this._ts as ts.FunctionTypeNode).parameters, this);
	}
	get returnType() {
		if (this._returnType !== undefined) return this._returnType;
		const t = (this._ts as ts.FunctionTypeNode).type;
		return this._returnType = t ? convertTypeAnnotation(t, this) : undefined;
	}
}

// Imports — typescript-estree assembles ImportDeclaration.specifiers from
// the import clause / named bindings / namespace import; we replicate.
class ImportDeclarationNode extends LazyNode {
	readonly type = 'ImportDeclaration' as const;
	readonly importKind: 'value' | 'type';
	private _attributes?: (LazyNode | null)[];
	private _source?: LazyNode | null;
	private _specifiers?: (LazyNode | null)[];

	constructor(tsNode: ts.ImportDeclaration, parent: LazyNode) {
		super(tsNode, parent);
		this.importKind = tsNode.importClause?.isTypeOnly ? 'type' : 'value';
	}

	get attributes() {
		if (this._attributes) return this._attributes;
		const ts_ = this._ts as ts.ImportDeclaration & {
			attributes?: { elements?: ReadonlyArray<ts.Node> };
			assertClause?: { elements?: ReadonlyArray<ts.Node> };
		};
		const attrs = ts_.attributes ?? ts_.assertClause;
		return this._attributes = attrs?.elements ? convertChildren(attrs.elements, this) : [];
	}
	// Deprecated alias for attributes.
	get assertions() {
		return this.attributes;
	}

	get source() {
		return this._source ??= convertChild((this._ts as ts.ImportDeclaration).moduleSpecifier, this);
	}

	get specifiers() {
		if (this._specifiers !== undefined) return this._specifiers;
		const specs: (LazyNode | null)[] = [];
		const ts_ = this._ts as ts.ImportDeclaration;
		const clause = ts_.importClause;
		if (clause) {
			if (clause.name) {
				specs.push(convertChild(clause, this));
			}
			if (clause.namedBindings) {
				if (clause.namedBindings.kind === SK.NamespaceImport) {
					specs.push(convertChild(clause.namedBindings, this));
				}
				else if (clause.namedBindings.kind === SK.NamedImports) {
					for (const el of clause.namedBindings.elements) {
						specs.push(convertChild(el, this));
					}
				}
			}
		}
		return this._specifiers = specs;
	}
}

class ImportSpecifierNode extends LazyNode {
	readonly type = 'ImportSpecifier' as const;
	readonly importKind: 'value' | 'type';
	private _imported?: LazyNode | null;
	private _local?: LazyNode | null;

	constructor(tsNode: ts.ImportSpecifier, parent: LazyNode) {
		super(tsNode, parent);
		this.importKind = tsNode.isTypeOnly ? 'type' : 'value';
	}

	get imported() {
		const ts_ = this._ts as ts.ImportSpecifier;
		return this._imported ??= convertChild(ts_.propertyName ?? ts_.name, this);
	}

	get local() {
		return this._local ??= convertChild((this._ts as ts.ImportSpecifier).name, this);
	}
}

class ImportNamespaceSpecifierNode extends LazyNode {
	readonly type = 'ImportNamespaceSpecifier' as const;
	private _local?: LazyNode | null;

	get local() {
		return this._local ??= convertChild((this._ts as ts.NamespaceImport).name, this);
	}
}

class ImportAttributeNode extends LazyNode {
	readonly type = 'ImportAttribute' as const;
	private _key?: LazyNode | null;
	private _value?: LazyNode | null;
	get key() {
		return this._key ??= convertChild((this._ts as ts.ImportAttribute).name, this);
	}
	get value() {
		return this._value ??= convertChild((this._ts as ts.ImportAttribute).value, this);
	}
}

// ImportClause maps to ImportDefaultSpecifier in ESTree (when it has a name).
class ImportDefaultSpecifierNode extends LazyNode {
	readonly type = 'ImportDefaultSpecifier' as const;
	private _local?: LazyNode | null;

	constructor(tsNode: ts.ImportClause, parent: LazyNode) {
		super(tsNode, parent);
		// typescript-estree narrows the range to the local name's range.
		if (tsNode.name) {
			const local = convertChild(tsNode.name, this);
			if (local) {
				this._local = local;
				this.range = [...local.range] as [number, number];
			}
		}
	}

	get local() {
		return this._local ??= convertChild((this._ts as ts.ImportClause).name, this);
	}
}

// Function-like declarations share a shape — id (sometimes), params,
// body, returnType, generator/async/declare modifiers. typescript-estree
// flattens this into per-kind cases (FunctionDeclaration, FunctionExpression,
// ArrowFunction); we do the same to keep `this.type` literal.

class FunctionDeclarationNode extends LazyNode {
	readonly type: 'FunctionDeclaration' | 'TSDeclareFunction';
	readonly async: boolean;
	readonly declare: boolean;
	readonly generator: boolean;
	readonly expression = false;
	private _typeParameters?: LazyNode | undefined;
	private _id?: LazyNode | null;
	private _params?: (LazyNode | null)[];
	private _body?: LazyNode | null | undefined;
	private _returnType?: LazyNode | null | undefined;

	constructor(tsNode: ts.FunctionDeclaration, parent: LazyNode) {
		super(tsNode, parent);
		this.async = !!tsNode.modifiers?.some(m => m.kind === SK.AsyncKeyword);
		this.declare = !!tsNode.modifiers?.some(m => m.kind === SK.DeclareKeyword);
		this.generator = !!tsNode.asteriskToken;
		this.type = tsNode.body ? 'FunctionDeclaration' : 'TSDeclareFunction';
	}
	get id() {
		return this._id ??= convertChild((this._ts as ts.FunctionDeclaration).name, this);
	}
	get typeParameters() {
		if (this._typeParameters !== undefined) return this._typeParameters;
		return this._typeParameters = convertTypeParameters((this._ts as ts.FunctionDeclaration).typeParameters, this);
	}
	get params() {
		return this._params ??= convertChildren((this._ts as ts.FunctionDeclaration).parameters, this);
	}
	get body() {
		if (this._body !== undefined) return this._body;
		const b = (this._ts as ts.FunctionDeclaration).body;
		return this._body = b ? convertChild(b, this) : undefined;
	}
	get returnType() {
		if (this._returnType !== undefined) return this._returnType;
		const t = (this._ts as ts.FunctionDeclaration).type;
		return this._returnType = t ? convertTypeAnnotation(t, this) : undefined;
	}
}

class FunctionExpressionNode extends LazyNode {
	readonly type = 'FunctionExpression' as const;
	readonly async: boolean;
	readonly declare = false;
	readonly generator: boolean;
	readonly expression = false;
	private _typeParameters?: LazyNode | undefined;
	private _id?: LazyNode | null;
	private _params?: (LazyNode | null)[];
	private _body?: LazyNode | null;
	private _returnType?: LazyNode | null | undefined;

	constructor(tsNode: ts.FunctionExpression, parent: LazyNode) {
		super(tsNode, parent);
		this.async = !!tsNode.modifiers?.some(m => m.kind === SK.AsyncKeyword);
		this.generator = !!tsNode.asteriskToken;
	}
	get id() {
		return this._id ??= convertChild((this._ts as ts.FunctionExpression).name, this);
	}
	get typeParameters() {
		if (this._typeParameters !== undefined) return this._typeParameters;
		return this._typeParameters = convertTypeParameters((this._ts as ts.FunctionExpression).typeParameters, this);
	}
	get params() {
		return this._params ??= convertChildren((this._ts as ts.FunctionExpression).parameters, this);
	}
	get body() {
		return this._body ??= convertChild((this._ts as ts.FunctionExpression).body, this);
	}
	get returnType() {
		if (this._returnType !== undefined) return this._returnType;
		const t = (this._ts as ts.FunctionExpression).type;
		return this._returnType = t ? convertTypeAnnotation(t, this) : undefined;
	}
}

class ArrowFunctionExpressionNode extends LazyNode {
	readonly type = 'ArrowFunctionExpression' as const;
	readonly async: boolean;
	readonly generator = false;
	readonly id = null;
	readonly expression: boolean;
	private _typeParameters?: LazyNode | undefined;
	private _params?: (LazyNode | null)[];
	private _body?: LazyNode | null;
	private _returnType?: LazyNode | null | undefined;

	constructor(tsNode: ts.ArrowFunction, parent: LazyNode) {
		super(tsNode, parent);
		this.async = !!tsNode.modifiers?.some(m => m.kind === SK.AsyncKeyword);
		// `expression: true` for `() => x`, `false` for `() => { x }`.
		this.expression = tsNode.body.kind !== SK.Block;
	}
	get params() {
		return this._params ??= convertChildren((this._ts as ts.ArrowFunction).parameters, this);
	}
	get typeParameters() {
		if (this._typeParameters !== undefined) return this._typeParameters;
		return this._typeParameters = convertTypeParameters((this._ts as ts.ArrowFunction).typeParameters, this);
	}
	get body() {
		return this._body ??= convertChild((this._ts as ts.ArrowFunction).body, this);
	}
	get returnType() {
		if (this._returnType !== undefined) return this._returnType;
		const t = (this._ts as ts.ArrowFunction).type;
		return this._returnType = t ? convertTypeAnnotation(t, this) : undefined;
	}
}

// Parameter — typescript-estree (line 1156) builds it in steps:
//   1. Pick the inner shape (RestElement / AssignmentPattern / plain Identifier).
//   2. Attach typeAnnotation onto the inner.
//   3. Extend range for `?`, set `optional`.
//   4. Wrap in TSParameterProperty if there are class-constructor modifiers.
// We mirror that structure.
function convertParameter(tsNode: ts.ParameterDeclaration, parent: LazyNode): LazyNode | null {
	const isClassPropertyModifier = (m: ts.ModifierLike) =>
		m.kind === SK.PublicKeyword || m.kind === SK.PrivateKeyword || m.kind === SK.ProtectedKeyword
		|| m.kind === SK.ReadonlyKeyword || m.kind === SK.OverrideKeyword;
	const propertyModifiers = tsNode.modifiers?.filter(isClassPropertyModifier);
	const hasPropertyModifiers = !!propertyModifiers?.length;

	let parameter: LazyNode | null;
	let result: LazyNode | null;

	if (tsNode.dotDotDotToken) {
		const rest = new RestElementNode(tsNode, parent);
		parameter = rest;
		result = rest;
	}
	else if (tsNode.initializer) {
		const inner = convertChild(tsNode.name, parent);
		if (!inner) return null;
		const assign = new AssignmentPatternNode(tsNode, parent, inner);
		parameter = inner;
		result = assign;
	}
	else {
		const inner = convertChild(tsNode.name, parent);
		parameter = inner;
		result = inner;
	}

	if (parameter && tsNode.type) {
		const annotation = convertTypeAnnotation(tsNode.type, parameter);
		(parameter as { typeAnnotation?: LazyNode | null }).typeAnnotation = annotation;
		(parameter as unknown as { _extendRange: (r: [number, number]) => void })._extendRange(annotation.range);
	}
	if (parameter) {
		const decorators = convertDecorators(tsNode, parameter);
		if (decorators.length > 0) {
			(parameter as { decorators?: (LazyNode | null)[] }).decorators = decorators;
		}
	}
	if (parameter && tsNode.questionToken) {
		(parameter as { optional?: boolean }).optional = true;
		if (tsNode.questionToken.end > parameter.range[1]) {
			(parameter as unknown as { _extendRange: (r: [number, number]) => void })
				._extendRange([parameter.range[0], tsNode.questionToken.end]);
		}
	}

	if (hasPropertyModifiers && result) {
		const wrapper = new TSParameterPropertyNode(tsNode, parent, result, propertyModifiers);
		parent._ctx.maps.tsNodeToESTreeNodeMap.set(tsNode, wrapper);
		return wrapper;
	}

	if (result) {
		parent._ctx.maps.tsNodeToESTreeNodeMap.set(tsNode, result);
	}
	return result;
}

class RestElementNode extends LazyNode {
	readonly type = 'RestElement' as const;
	readonly decorators: never[] = EMPTY_ARRAY;
	readonly optional = false;
	readonly value = undefined;
	typeAnnotation: LazyNode | null | undefined = undefined;
	private _argument?: LazyNode | null;
	get argument() {
		return this._argument ??= convertChild((this._ts as ts.ParameterDeclaration).name, this);
	}
}

class AssignmentPatternNode extends LazyNode {
	readonly type = 'AssignmentPattern' as const;
	readonly decorators: never[] = EMPTY_ARRAY;
	readonly optional = false;
	typeAnnotation: LazyNode | null | undefined = undefined;
	readonly left: LazyNode;
	private _right?: LazyNode | null;

	constructor(tsNode: ts.ParameterDeclaration, parent: LazyNode, left: LazyNode) {
		super(tsNode, parent);
		this.left = left;
		// AssignmentPattern range starts at the param name (eager strips
		// modifiers from the range — line 1182).
		const start = (tsNode.name as ts.Node).getStart(this._ctx.ast);
		const end = tsNode.initializer!.end;
		this.range = [start, end];
	}
	get right() {
		return this._right ??= convertChild((this._ts as ts.ParameterDeclaration).initializer, this);
	}
}

// upstream: typescript-estree wraps a class-constructor parameter
// property (`constructor(public x)`) in `TSParameterProperty { parameter:
// <Identifier> }`. Like the export wrappers, this wrapper claims the
// TS slot in the cache.
class TSParameterPropertyNode extends LazyNode {
	readonly type = 'TSParameterProperty' as const;
	readonly accessibility: 'public' | 'private' | 'protected' | undefined;
	readonly override: boolean;
	readonly readonly: boolean;
	readonly static = false;
	readonly decorators: never[] = EMPTY_ARRAY;
	readonly parameter: LazyNode;
	constructor(
		tsNode: ts.ParameterDeclaration,
		parent: LazyNode,
		parameter: LazyNode,
		mods: ReadonlyArray<ts.ModifierLike>,
	) {
		super(tsNode, parent);
		const accMod = mods.find(m =>
			m.kind === SK.PublicKeyword || m.kind === SK.PrivateKeyword || m.kind === SK.ProtectedKeyword
		);
		this.accessibility = accMod
			? (accMod.kind === SK.PublicKeyword ? 'public' : accMod.kind === SK.PrivateKeyword ? 'private' : 'protected')
			: undefined;
		this.override = mods.some(m => m.kind === SK.OverrideKeyword);
		this.readonly = mods.some(m => m.kind === SK.ReadonlyKeyword);
		// Re-point the inner parameter's parent to us — same reason as the
		// Export wrappers above: rules that key off `node.parent.type` need
		// to see TSParameterProperty here, not the underlying function.
		(parameter as { parent: LazyNode }).parent = this;
		this.parameter = parameter;
	}
}

// Operator-token-kind sets used by BinaryLikeExpressionNode to derive both
// the ESTree type tag and the operator string from the token kind alone —
// no scanner walk per BinaryExpression.
const LOGICAL_OP_KINDS = new Set<ts.SyntaxKind>([
	SK.AmpersandAmpersandToken,
	SK.BarBarToken,
	SK.QuestionQuestionToken,
]);
const ASSIGN_OP_KINDS = new Set<ts.SyntaxKind>([
	SK.EqualsToken,
	SK.PlusEqualsToken,
	SK.MinusEqualsToken,
	SK.AsteriskAsteriskEqualsToken,
	SK.AsteriskEqualsToken,
	SK.SlashEqualsToken,
	SK.PercentEqualsToken,
	SK.AmpersandEqualsToken,
	SK.BarEqualsToken,
	SK.CaretEqualsToken,
	SK.LessThanLessThanEqualsToken,
	SK.GreaterThanGreaterThanEqualsToken,
	SK.GreaterThanGreaterThanGreaterThanEqualsToken,
	SK.AmpersandAmpersandEqualsToken,
	SK.BarBarEqualsToken,
	SK.QuestionQuestionEqualsToken,
]);

// One class for all binary-shaped operators. typescript-estree splits the
// shape into BinaryExpression / LogicalExpression / AssignmentExpression
// based on the operator; we do the same in the constructor.
class BinaryLikeExpressionNode extends LazyNode {
	readonly type: 'BinaryExpression' | 'LogicalExpression' | 'AssignmentExpression';
	readonly operator: string;
	private _left?: LazyNode | null;
	private _right?: LazyNode | null;

	constructor(tsNode: ts.BinaryExpression, parent: LazyNode) {
		super(tsNode, parent);
		// `ts.tokenToString(kind)` is a kind→literal-text switch — no scanner
		// walk, no source-text slice. About 5–10x faster than `getText(ast)`
		// for BinaryExpression's hot constructor.
		const opKind = tsNode.operatorToken.kind;
		this.operator = ts.tokenToString(opKind)!;
		if (LOGICAL_OP_KINDS.has(opKind)) {
			this.type = 'LogicalExpression';
		}
		else if (ASSIGN_OP_KINDS.has(opKind)) {
			this.type = 'AssignmentExpression';
		}
		else {
			this.type = 'BinaryExpression';
		}
	}

	get left() {
		if (this._left !== undefined) return this._left;
		const tsLeft = (this._ts as ts.BinaryExpression).left;
		// Assignment-style: the left is in pattern position (`[a,b] = ...`).
		if (this.type === 'AssignmentExpression') {
			return this._left = convertChildAsPattern(tsLeft, this);
		}
		return this._left = convertChild(tsLeft, this);
	}

	get right() {
		return this._right ??= convertChild((this._ts as ts.BinaryExpression).right, this);
	}
}

// upstream: `typescript-estree/.../convert.ts` `convertBinaryExpression`
// dispatches on `operatorToken.kind === SyntaxKind.CommaToken` to
// `AST_NODE_TYPES.SequenceExpression` and flattens
// `left.expressions` into the result UNLESS the left operand was
// `ParenthesizedExpression` (preserves user grouping).
//
// `a, b, c` parses as nested `BinaryExpression(',')` in TS but
// flattens to a single ESTree SequenceExpression with
// `expressions=[a,b,c]`. ts-ast-scan has a matching predicate that
// fires only on the outermost (or paren-wrapped) comma BE — see
// `ts-ast-scan.ts` SequenceExpression predicate.
class SequenceExpressionNode extends LazyNode {
	readonly type = 'SequenceExpression' as const;
	private _expressions?: (LazyNode | null)[];

	constructor(tsNode: ts.BinaryExpression, parent: LazyNode) {
		super(tsNode, parent);
	}

	get expressions() {
		if (this._expressions !== undefined) return this._expressions;
		const be = this._ts as ts.BinaryExpression;
		const out: (LazyNode | null)[] = [];
		const left = convertChild(be.left, this);
		// Only flatten when the user didn't parenthesize the left side —
		// `(a, b), c` keeps the inner SequenceExpression as a single
		// expression entry. ParenthesizedExpression collapses in
		// convertChildInner so we check the TS node directly.
		if (
			left
			&& left.type === 'SequenceExpression'
			&& be.left.kind !== SK.ParenthesizedExpression
		) {
			for (const e of (left as SequenceExpressionNode).expressions) {
				out.push(e);
			}
		}
		else {
			out.push(left);
		}
		out.push(convertChild(be.right, this));
		return this._expressions = out;
	}
}

class MemberExpressionNode extends LazyNode {
	readonly type = 'MemberExpression' as const;
	readonly computed: boolean;
	readonly optional: boolean;
	private _object?: LazyNode | null;
	private _property?: LazyNode | null;

	constructor(tsNode: ts.PropertyAccessExpression | ts.ElementAccessExpression, parent: LazyNode) {
		super(tsNode, parent);
		this.computed = tsNode.kind === SK.ElementAccessExpression;
		this.optional = !!tsNode.questionDotToken;
	}

	get object() {
		return this._object ??= convertChild(
			(this._ts as ts.PropertyAccessExpression | ts.ElementAccessExpression).expression,
			this,
		);
	}

	get property() {
		if (this._property !== undefined) return this._property;
		const ts_ = this._ts as ts.PropertyAccessExpression | ts.ElementAccessExpression;
		return this._property = this.computed
			? convertChild((ts_ as ts.ElementAccessExpression).argumentExpression, this)
			: convertChild((ts_ as ts.PropertyAccessExpression).name, this);
	}
}

class CallExpressionNode extends LazyNode {
	readonly type = 'CallExpression' as const;
	readonly optional: boolean;
	readonly typeParameters = undefined;
	private _callee?: LazyNode | null;
	private _arguments?: (LazyNode | null)[];
	private _typeArguments?: LazyNode | undefined;

	constructor(tsNode: ts.CallExpression, parent: LazyNode) {
		super(tsNode, parent);
		this.optional = !!tsNode.questionDotToken;
	}

	get callee() {
		return this._callee ??= convertChild((this._ts as ts.CallExpression).expression, this);
	}

	get arguments() {
		return this._arguments ??= convertChildren((this._ts as ts.CallExpression).arguments, this);
	}

	get typeArguments() {
		if (this._typeArguments !== undefined) return this._typeArguments;
		return this._typeArguments = convertTypeArguments((this._ts as ts.CallExpression).typeArguments, this);
	}
}

class ImportExpressionNode extends LazyNode {
	readonly type = 'ImportExpression' as const;
	readonly attributes: never[] = EMPTY_ARRAY;
	private _source?: LazyNode | null;
	private _options?: LazyNode | null;
	get source() {
		const args = (this._ts as ts.CallExpression).arguments;
		return this._source ??= convertChild(args[0], this);
	}
	get options() {
		const args = (this._ts as ts.CallExpression).arguments;
		return this._options ??= args[1] ? convertChild(args[1], this) : null;
	}
}

// `class C { static { ... } }` — class static initialiser block.
class StaticBlockNode extends LazyNode {
	readonly type = 'StaticBlock' as const;
	readonly decorators: never[] = EMPTY_ARRAY;
	private _body?: (LazyNode | null)[];
	get body() {
		return this._body ??= convertChildren(
			(this._ts as ts.ClassStaticBlockDeclaration).body.statements,
			this,
		);
	}
}

// `new.target` and `import.meta`. typescript-estree emits
// MetaProperty { meta: Identifier, property: Identifier } where the
// `meta` Identifier is synthetic (TS has only the keyword tokens).
class MetaPropertyNode extends LazyNode {
	readonly type = 'MetaProperty' as const;
	readonly meta: {
		type: 'Identifier';
		name: string;
		decorators: never[];
		optional: boolean;
		range: [number, number];
		loc: ReturnType<typeof getLocFor>;
		parent: LazyNode;
	};
	private _property?: LazyNode | null;
	constructor(tsNode: ts.MetaProperty, parent: LazyNode) {
		super(tsNode, parent);
		// `meta` is the keyword (`new` or `import`) — synthesize an Identifier.
		const keywordStart = tsNode.getStart(this._ctx.ast);
		const keywordEnd = keywordStart + (tsNode.keywordToken === SK.NewKeyword ? 3 : 6); // 'new' or 'import'
		const range: [number, number] = [keywordStart, keywordEnd];
		this.meta = {
			type: 'Identifier',
			name: tsNode.keywordToken === SK.NewKeyword ? 'new' : 'import',
			decorators: [],
			optional: false,
			range,
			loc: getLocFor(this._ctx.ast, range[0], range[1]),
			parent: this,
		};
	}
	get property() {
		return this._property ??= convertChild((this._ts as ts.MetaProperty).name, this);
	}
}

// `true` / `false` keyword literals. typescript-estree maps them to
// `Literal { value: true|false, raw: 'true'|'false' }`.
class BoolLiteralNode extends LazyNode {
	readonly type = 'Literal' as const;
	readonly value: boolean;
	readonly raw: 'true' | 'false';
	constructor(tsNode: ts.TrueLiteral | ts.FalseLiteral, parent: LazyNode, value: boolean) {
		super(tsNode, parent);
		this.value = value;
		this.raw = value ? 'true' : 'false';
	}
}

class LiteralNode extends LazyNode {
	readonly type = 'Literal' as const;
	readonly value: string | number | null;
	private _raw?: string;

	constructor(tsNode: ts.LiteralExpression, parent: LazyNode) {
		super(tsNode, parent);
		// `value` is cheap (`tsNode.text` is already parsed), set eagerly.
		// `raw` would call `getText(ast)` (scanner trivia walk) — defer to a
		// lazy getter. Most rules read `.value` or `.type`; `.raw` matters
		// mainly for string-quote / regex-source rules.
		if (tsNode.kind === SK.NumericLiteral) {
			this.value = Number(tsNode.text);
		}
		else if (tsNode.kind === SK.StringLiteral) {
			// JSX attribute string values get HTML entity decoding from
			// typescript-estree (`unescapeStringLiteralText`). Apply when
			// the StringLiteral's parent is JsxAttribute so `<x t="&amp;" />`
			// reads `value === '&'` for parity with the eager converter.
			if (parent._ts.kind === SK.JsxAttribute) {
				this.value = unescapeJsxText(tsNode.text);
			}
			else {
				this.value = tsNode.text;
			}
		}
		else {
			this.value = null;
		}
	}
	get raw(): string {
		return this._raw ??= (this._ts as ts.LiteralExpression).getText(this._ctx.ast);
	}
}

// --- JSX nodes ---------------------------------------------------------
//
// typescript-estree shapes we replicate (see its convert.ts):
//   - JsxElement → JSXElement{ openingElement, closingElement, children }
//   - JsxSelfClosingElement → JSXElement{
//       openingElement: JSXOpeningElement{ selfClosing: true, range = same },
//       closingElement: null,
//       children: [],
//     }
//     The same TS node owns BOTH the JSXElement and the inner
//     JSXOpeningElement; the JSXOpeningElement is synthetic (we don't
//     claim the cache slot — it stays mapped to the JSXElement).
//   - JsxOpeningElement → JSXOpeningElement{ name, typeArguments, attributes, selfClosing: false }
//   - JsxClosingElement → JSXClosingElement{ name }
//   - JsxFragment → JSXFragment{ openingFragment, closingFragment, children }
//   - JsxOpeningFragment / JsxClosingFragment → JSXOpeningFragment / JSXClosingFragment
//   - JsxAttribute → JSXAttribute{ name, value }
//   - JsxSpreadAttribute → JSXSpreadAttribute{ argument }
//   - JsxExpression with dotDotDotToken → JSXSpreadChild{ expression }
//   - JsxExpression with expression  → JSXExpressionContainer{ expression }
//   - JsxExpression empty            → JSXExpressionContainer{
//       expression: JSXEmptyExpression{ range: [start+1, end-1] }
//     }
//   - JsxText → JSXText{ value, raw }, range uses fullStart (so leading
//     whitespace between sibling JSX nodes is part of the JSXText range).
//   - JsxNamespacedName → JSXNamespacedName{ namespace, name } (used as
//     JSXAttribute.name and as an opening-element's tag name).
//
// Tag name conversion (`<Foo />`, `<Foo.Bar />`, `<svg:rect />`,
// `<this />`): handled by `convertJSXTagName`. ts.Identifier becomes a
// JSXIdentifier; PropertyAccessExpression becomes JSXMemberExpression
// with each link converted recursively; JsxNamespacedName becomes
// JSXNamespacedName; ThisKeyword falls through to the regular converter.
//
// Attribute name conversion (`<Foo x="1" />` vs `<Foo svg:rect="1" />`):
// handled by `convertJSXNamespaceOrIdentifier`.

class JSXElementNode extends LazyNode {
	readonly type = 'JSXElement' as const;
	private _openingElement?: LazyNode;
	private _closingElement?: LazyNode | null;
	private _children?: (LazyNode | null)[];

	get openingElement(): LazyNode {
		if (this._openingElement) return this._openingElement;
		const t = this._ts;
		if (t.kind === SK.JsxSelfClosingElement) {
			return this._openingElement = new JSXOpeningElementNode(t as ts.JsxSelfClosingElement, this, true);
		}
		return this._openingElement = convertChild((t as ts.JsxElement).openingElement, this) as LazyNode;
	}

	get closingElement(): LazyNode | null {
		if (this._closingElement !== undefined) return this._closingElement;
		const t = this._ts;
		if (t.kind === SK.JsxSelfClosingElement) return this._closingElement = null;
		return this._closingElement = convertChild((t as ts.JsxElement).closingElement, this);
	}

	get children(): (LazyNode | null)[] {
		if (this._children) return this._children;
		const t = this._ts;
		if (t.kind === SK.JsxSelfClosingElement) return this._children = EMPTY_ARRAY;
		return this._children = convertChildren((t as ts.JsxElement).children, this);
	}
}

class JSXOpeningElementNode extends LazyNode {
	readonly type = 'JSXOpeningElement' as const;
	readonly selfClosing: boolean;
	private _name?: LazyNode;
	private _attributes?: (LazyNode | null)[];
	private _typeArguments?: TSTypeParameterInstantiationNode | undefined;
	private _typeArgsResolved = false;

	constructor(
		tsNode: ts.JsxOpeningElement | ts.JsxSelfClosingElement,
		parent: LazyNode | null,
		synthetic = false,
	) {
		// `synthetic=true` for the inner opening element of a self-closing
		// JsxSelfClosingElement — the JsxSelfClosingElement TS slot is owned
		// by the outer JSXElement, not by this opening element.
		super(tsNode, parent, undefined, !synthetic);
		this.selfClosing = tsNode.kind === SK.JsxSelfClosingElement;
	}

	get name(): LazyNode {
		if (this._name) return this._name;
		const t = this._ts as ts.JsxOpeningElement | ts.JsxSelfClosingElement;
		return this._name = convertJSXTagName(t.tagName, this);
	}

	get attributes(): (LazyNode | null)[] {
		if (this._attributes) return this._attributes;
		const t = this._ts as ts.JsxOpeningElement | ts.JsxSelfClosingElement;
		return this._attributes = convertChildren(t.attributes.properties, this);
	}

	get typeArguments(): TSTypeParameterInstantiationNode | undefined {
		if (this._typeArgsResolved) return this._typeArguments;
		this._typeArgsResolved = true;
		const t = this._ts as ts.JsxOpeningElement | ts.JsxSelfClosingElement;
		return this._typeArguments = convertTypeArguments(t.typeArguments, this);
	}
}

class JSXClosingElementNode extends LazyNode {
	readonly type = 'JSXClosingElement' as const;
	private _name?: LazyNode;
	get name(): LazyNode {
		if (this._name) return this._name;
		const t = this._ts as ts.JsxClosingElement;
		return this._name = convertJSXTagName(t.tagName, this);
	}
}

class JSXFragmentNode extends LazyNode {
	readonly type = 'JSXFragment' as const;
	private _openingFragment?: LazyNode;
	private _closingFragment?: LazyNode;
	private _children?: (LazyNode | null)[];

	get openingFragment(): LazyNode {
		if (this._openingFragment) return this._openingFragment;
		return this._openingFragment = convertChild((this._ts as ts.JsxFragment).openingFragment, this) as LazyNode;
	}
	get closingFragment(): LazyNode {
		if (this._closingFragment) return this._closingFragment;
		return this._closingFragment = convertChild((this._ts as ts.JsxFragment).closingFragment, this) as LazyNode;
	}
	get children(): (LazyNode | null)[] {
		if (this._children) return this._children;
		return this._children = convertChildren((this._ts as ts.JsxFragment).children, this);
	}
}

class JSXOpeningFragmentNode extends LazyNode {
	readonly type = 'JSXOpeningFragment' as const;
}

class JSXClosingFragmentNode extends LazyNode {
	readonly type = 'JSXClosingFragment' as const;
}

class JSXAttributeNode extends LazyNode {
	readonly type = 'JSXAttribute' as const;
	private _name?: LazyNode;
	private _value?: LazyNode | null;

	get name(): LazyNode {
		if (this._name) return this._name;
		return this._name = convertJSXNamespaceOrIdentifier((this._ts as ts.JsxAttribute).name, this);
	}
	get value(): LazyNode | null {
		if (this._value !== undefined) return this._value;
		return this._value = convertChild((this._ts as ts.JsxAttribute).initializer, this);
	}
}

class JSXSpreadAttributeNode extends LazyNode {
	readonly type = 'JSXSpreadAttribute' as const;
	private _argument?: LazyNode | null;
	get argument(): LazyNode | null {
		if (this._argument !== undefined) return this._argument;
		return this._argument = convertChild((this._ts as ts.JsxSpreadAttribute).expression, this);
	}
}

class JSXExpressionContainerNode extends LazyNode {
	readonly type = 'JSXExpressionContainer' as const;
	private _expression?: LazyNode;

	get expression(): LazyNode {
		if (this._expression) return this._expression;
		const t = this._ts as ts.JsxExpression;
		if (t.expression) {
			return this._expression = convertChild(t.expression, this) as LazyNode;
		}
		return this._expression = new JSXEmptyExpressionNode(t, this);
	}
}

class JSXEmptyExpressionNode extends LazyNode {
	readonly type = 'JSXEmptyExpression' as const;
	constructor(tsNode: ts.JsxExpression, parent: LazyNode) {
		// Synthetic — the JsxExpression TS slot is owned by JSXExpressionContainerNode.
		super(tsNode, parent, undefined, false);
		// Range matches eager: `[start+1, end-1]` to exclude the `{` `}`.
		this.range = [tsNode.getStart(this._ctx.ast) + 1, tsNode.getEnd() - 1];
	}
}

class JSXSpreadChildNode extends LazyNode {
	readonly type = 'JSXSpreadChild' as const;
	private _expression?: LazyNode | null;
	get expression(): LazyNode | null {
		if (this._expression !== undefined) return this._expression;
		return this._expression = convertChild((this._ts as ts.JsxExpression).expression, this);
	}
}

class JSXTextNode extends LazyNode {
	readonly type = 'JSXText' as const;
	readonly value: string;
	readonly raw: string;
	constructor(tsNode: ts.JsxText, parent: LazyNode) {
		super(tsNode, parent);
		// JsxText doesn't own its leading trivia the way other TS nodes do —
		// the gap between sibling JSX children IS the JsxText's content. Use
		// fullStart to capture leading whitespace.
		const start = tsNode.getFullStart();
		const end = tsNode.getEnd();
		this.range = [start, end];
		const text = this._ctx.ast.text.slice(start, end);
		this.raw = text;
		this.value = unescapeJsxText(text);
	}
}

// JSXIdentifier — synthetic in the sense that it has no own TS kind; it
// wraps an Identifier (or sub-piece of a JsxNamespacedName). Tag-name
// identifiers DO claim the cache slot (typescript-estree's
// convertJSXIdentifier registers them); identifiers inside JsxNamespacedName
// don't (the JSXNamespacedName owns that slot).
class JSXIdentifierNode extends LazyNode {
	readonly type = 'JSXIdentifier' as const;
	readonly name: string;
	constructor(
		tsNode: ts.Node,
		parent: LazyNode | null,
		name: string,
		registerInMaps = true,
		range?: [number, number],
	) {
		super(tsNode, parent, undefined, registerInMaps);
		this.name = name;
		if (range) this.range = range;
	}
}

class JSXMemberExpressionNode extends LazyNode {
	readonly type = 'JSXMemberExpression' as const;
	private _object?: LazyNode;
	private _property?: JSXIdentifierNode;
	get object(): LazyNode {
		if (this._object) return this._object;
		const t = this._ts as ts.PropertyAccessExpression;
		return this._object = convertJSXTagName(t.expression, this);
	}
	get property(): JSXIdentifierNode {
		if (this._property) return this._property;
		const name = (this._ts as ts.PropertyAccessExpression).name as ts.Identifier;
		// Inner identifier of a member-expression chain — slot is owned by
		// the property's own ts.Identifier, so we DO register here (matches
		// typescript-estree's convertJSXIdentifier behavior).
		return this._property = new JSXIdentifierNode(name, this, name.text, true);
	}
}

class JSXNamespacedNameNode extends LazyNode {
	readonly type = 'JSXNamespacedName' as const;
	private _namespace?: JSXIdentifierNode;
	private _name?: JSXIdentifierNode;
	get namespace(): JSXIdentifierNode {
		if (this._namespace) return this._namespace;
		const ns = (this._ts as ts.JsxNamespacedName).namespace;
		// Inner — JSXNamespacedName owns the JsxNamespacedName slot, so the
		// namespace JSXIdentifier doesn't register against namespace.parent
		// (which would conflict). The namespace ts.Identifier itself has a
		// distinct TS node, so we register that.
		return this._namespace = new JSXIdentifierNode(ns, this, ns.text, true);
	}
	get name(): JSXIdentifierNode {
		if (this._name) return this._name;
		const nm = (this._ts as ts.JsxNamespacedName).name;
		return this._name = new JSXIdentifierNode(nm, this, nm.text, true);
	}
}

// JSX tag-name dispatch: translate the TS node that lives in `tagName`
// (Identifier, PropertyAccessExpression, JsxNamespacedName, ThisKeyword)
// into the right JSX-flavored ESTree node.
function convertJSXTagName(node: ts.Node, parent: LazyNode): LazyNode {
	if (node.kind === SK.PropertyAccessExpression) {
		return new JSXMemberExpressionNode(node, parent);
	}
	if (node.kind === SK.JsxNamespacedName) {
		return new JSXNamespacedNameNode(node, parent);
	}
	if (node.kind === SK.ThisKeyword) {
		// `<this />` — typescript-estree falls back to convertJSXNamespaceOrIdentifier
		// which then calls convertJSXIdentifier (treats it as a JSXIdentifier
		// with name='this'). Mirror that.
		return new JSXIdentifierNode(node, parent, 'this', true);
	}
	const id = node as ts.Identifier;
	return new JSXIdentifierNode(id, parent, id.text, true);
}

// JSX attribute-name dispatch: a JsxNamespacedName (`<el ns:attr=… />`)
// or a plain ts.Identifier (`<el attr=… />`).
function convertJSXNamespaceOrIdentifier(node: ts.Node, parent: LazyNode): LazyNode {
	if (node.kind === SK.JsxNamespacedName) {
		return new JSXNamespacedNameNode(node, parent);
	}
	const id = node as ts.Identifier;
	return new JSXIdentifierNode(id, parent, id.text, true);
}

// JsxText / JsxAttribute-string entity decoding. typescript-estree's
// `unescapeStringLiteralText` (lib/node-utils.ts) decodes the full XHTML
// named-entity set + numeric refs. We vendor its `xhtmlEntities` table
// so `&copy;` → `©`, `&nbsp;` → U+00A0 (no-break space, NOT 0x20), etc.
// resolve to the exact code points eager produces. Rules that compare
// `.value` (react/no-unescaped-entities, jsx-a11y accessibility checks,
// whitespace detectors) need this parity — partial decoding silently
// hides real entities behind their `&name;` source form.
const { xhtmlEntities } = require('./xhtml-entities.js') as { xhtmlEntities: Record<string, string> };
function unescapeJsxText(text: string): string {
	if (!text.includes('&')) return text;
	return text.replace(/&(?:#\d+|#x[\da-fA-F]+|[0-9a-zA-Z]+);/g, entity => {
		const item = entity.slice(1, -1);
		if (item[0] === '#') {
			const codePoint = item[1] === 'x'
				? parseInt(item.slice(2), 16)
				: parseInt(item.slice(1), 10);
			// String.fromCodePoint throws RangeError on out-of-range
			// inputs; eager leaves the entity intact in that case.
			return codePoint > 0x10ffff ? entity : String.fromCodePoint(codePoint);
		}
		return xhtmlEntities[item] ?? entity;
	});
}

// --- Entry point --------------------------------------------------------

export function convertLazy(
	file: ts.SourceFile,
): { estree: ProgramNode; astMaps: LazyAstMaps; context: ConvertContext } {
	const maps: LazyAstMaps = {
		esTreeNodeToTSNodeMap: ESTREE_TO_TS_FACADE,
		tsNodeToESTreeNodeMap: new WeakMap(),
	};
	const context: ConvertContext = { ast: file, maps };
	const estree = new ProgramNode(file, null, context);
	return { estree, astMaps: maps, context };
}
