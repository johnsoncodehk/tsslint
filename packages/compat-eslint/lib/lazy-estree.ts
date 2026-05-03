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
import { xhtmlEntities } from './xhtml-entities';

const SK = ts.SyntaxKind;

// Debug instrumentation: when enabled, every materialised LazyNode bumps
// a per-`type` counter so `--debug-estree` (or callers using the env var
// directly) can dump the actual conversion volume per ESTree node type.
//
// Counter lives on globalThis under a Symbol.for key so all loaded
// compat-eslint instances in the same process share one map. This
// matters because the user's project typically resolves compat-eslint
// against ITS node_modules, while the CLI's --debug-estree handler
// reads the count via its OWN module resolution — different instances,
// same Node process. Without globalThis sharing, the CLI would see an
// empty counter even though linting populated one.
//
// Cost when off: a single boolean check per construction, no allocation.
// Cost when on: one queueMicrotask per construction. We defer the read
// because the subclass's `readonly type = '...'` field is initialised
// AFTER `super(...)` returns — class-property assignments compile to
// constructor body statements that execute post-`super()`. Reading
// `this.type` synchronously here would observe `undefined`.
const DEBUG_ESTREE = process.env.TSSLINT_DEBUG_ESTREE === '1';
const COUNTS_KEY = Symbol.for('@tsslint/compat-eslint:node-type-counts');
type GlobalCountsHolder = { [k in typeof COUNTS_KEY]?: Map<string, number> };
const _global = globalThis as unknown as GlobalCountsHolder;
const nodeTypeCounts: Map<string, number> = _global[COUNTS_KEY] ??= new Map();

export function getNodeTypeCounts(): ReadonlyMap<string, number> {
	return nodeTypeCounts;
}

export function resetNodeTypeCounts(): void {
	nodeTypeCounts.clear();
}

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

// Architectural gate: every ESTree type lazy-estree can produce must be
// listed here. Both `LazyNode.type` (hand-written subclasses) and
// `defineShape.type` (factory-built shapes) are constrained to this
// union — adding a new ESTree shape requires editing this list first.
//
// Why: prevents phantom types like 'TSJsxAttributes' (the bug class
// that started this refactor) from being introduced. Any subclass
// declaring `readonly type = 'X' as const` for an X not in this
// union fails at compile time.
//
// The union mirrors typescript-estree's published TS- and ES-prefixed
// node types. 13 TS keyword types (TSAnyKeyword, TSStringKeyword, …)
// are dynamic via TypeKeywordNode, so they go in here too.
type KnownEstreeType =
	// Core ESTree
	| 'AccessorProperty'
	| 'ArrayExpression'
	| 'ArrayPattern'
	| 'ArrowFunctionExpression'
	| 'AssignmentExpression'
	| 'AssignmentPattern'
	| 'AwaitExpression'
	| 'BinaryExpression'
	| 'BlockStatement'
	| 'BreakStatement'
	| 'CallExpression'
	| 'CatchClause'
	| 'ChainExpression'
	| 'ClassBody'
	| 'ClassDeclaration'
	| 'ClassExpression'
	| 'ConditionalExpression'
	| 'ContinueStatement'
	| 'DebuggerStatement'
	| 'Decorator'
	| 'DoWhileStatement'
	| 'EmptyStatement'
	| 'ExportAllDeclaration'
	| 'ExportDefaultDeclaration'
	| 'ExportNamedDeclaration'
	| 'ExportSpecifier'
	| 'ExpressionStatement'
	| 'ForInStatement'
	| 'ForOfStatement'
	| 'ForStatement'
	| 'FunctionDeclaration'
	| 'FunctionExpression'
	| 'Identifier'
	| 'IfStatement'
	| 'ImportAttribute'
	| 'ImportDeclaration'
	| 'ImportDefaultSpecifier'
	| 'ImportExpression'
	| 'ImportNamespaceSpecifier'
	| 'ImportSpecifier'
	| 'LabeledStatement'
	| 'Literal'
	| 'LogicalExpression'
	| 'MemberExpression'
	| 'MetaProperty'
	| 'MethodDefinition'
	| 'NewExpression'
	| 'ObjectExpression'
	| 'ObjectPattern'
	| 'PrivateIdentifier'
	| 'Program'
	| 'Property'
	| 'PropertyDefinition'
	| 'RestElement'
	| 'ReturnStatement'
	| 'SequenceExpression'
	| 'SpreadElement'
	| 'StaticBlock'
	| 'Super'
	| 'SwitchCase'
	| 'SwitchStatement'
	| 'TaggedTemplateExpression'
	| 'TemplateElement'
	| 'TemplateLiteral'
	| 'ThisExpression'
	| 'ThrowStatement'
	| 'TryStatement'
	| 'UnaryExpression'
	| 'UpdateExpression'
	| 'VariableDeclaration'
	| 'VariableDeclarator'
	| 'WhileStatement'
	| 'WithStatement'
	| 'YieldExpression'
	// JSX
	| 'JSXAttribute'
	| 'JSXClosingElement'
	| 'JSXClosingFragment'
	| 'JSXElement'
	| 'JSXEmptyExpression'
	| 'JSXExpressionContainer'
	| 'JSXFragment'
	| 'JSXIdentifier'
	| 'JSXMemberExpression'
	| 'JSXNamespacedName'
	| 'JSXOpeningElement'
	| 'JSXOpeningFragment'
	| 'JSXSpreadAttribute'
	| 'JSXSpreadChild'
	| 'JSXText'
	// TS-specific (composite types)
	| 'TSAbstractAccessorProperty'
	| 'TSAbstractKeyword'
	| 'TSAbstractMethodDefinition'
	| 'TSAbstractPropertyDefinition'
	| 'TSArrayType'
	| 'TSAsExpression'
	| 'TSCallSignatureDeclaration'
	| 'TSClassImplements'
	| 'TSConditionalType'
	| 'TSConstructSignatureDeclaration'
	| 'TSConstructorType'
	| 'TSDeclareFunction'
	| 'TSEmptyBodyFunctionExpression'
	| 'TSEnumBody'
	| 'TSEnumDeclaration'
	| 'TSEnumMember'
	| 'TSExportAssignment'
	| 'TSExternalModuleReference'
	| 'TSFunctionType'
	| 'TSImportEqualsDeclaration'
	| 'TSImportType'
	| 'TSIndexSignature'
	| 'TSIndexedAccessType'
	| 'TSInferType'
	| 'TSInstantiationExpression'
	| 'TSInterfaceBody'
	| 'TSInterfaceDeclaration'
	| 'TSInterfaceHeritage'
	| 'TSIntersectionType'
	| 'TSLiteralType'
	| 'TSMappedType'
	| 'TSMethodSignature'
	| 'TSModuleBlock'
	| 'TSModuleDeclaration'
	| 'TSNamedTupleMember'
	| 'TSNamespaceExportDeclaration'
	| 'TSNonNullExpression'
	| 'TSOptionalType'
	| 'TSParameterProperty'
	| 'TSPropertySignature'
	| 'TSQualifiedName'
	| 'TSRestType'
	| 'TSSatisfiesExpression'
	| 'TSTemplateLiteralType'
	| 'TSThisType'
	| 'TSTupleType'
	| 'TSTypeAliasDeclaration'
	| 'TSTypeAnnotation'
	| 'TSTypeAssertion'
	| 'TSTypeLiteral'
	| 'TSTypeOperator'
	| 'TSTypeParameter'
	| 'TSTypeParameterDeclaration'
	| 'TSTypeParameterInstantiation'
	| 'TSTypePredicate'
	| 'TSTypeQuery'
	| 'TSTypeReference'
	| 'TSUnionType'
	// TS keyword types (TypeKeywordNode dynamic dispatch)
	| 'TSAnyKeyword'
	| 'TSBigIntKeyword'
	| 'TSBooleanKeyword'
	| 'TSIntrinsicKeyword'
	| 'TSNeverKeyword'
	| 'TSNullKeyword'
	| 'TSNumberKeyword'
	| 'TSObjectKeyword'
	| 'TSStringKeyword'
	| 'TSSymbolKeyword'
	| 'TSUndefinedKeyword'
	| 'TSUnknownKeyword'
	| 'TSVoidKeyword';

function getLocFor(ast: ts.SourceFile, start: number, end: number) {
	const startLC = ast.getLineAndCharacterOfPosition(start);
	const endLC = ast.getLineAndCharacterOfPosition(end);
	return {
		start: { line: startLC.line + 1, column: startLC.character },
		end: { line: endLC.line + 1, column: endLC.character },
	};
}

abstract class LazyNode {
	// Architectural gate: every concrete LazyNode subclass's `type` must
	// be a member of KnownEstreeType. Prevents introducing phantom types
	// like 'TSJsxAttributes' that don't exist in typescript-estree's
	// shape. New ESTree shape = add to KnownEstreeType first.
	abstract readonly type: KnownEstreeType;
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

	constructor(tsNode: ts.Node, parent: LazyNode | null, context?: ConvertContext) {
		this._ts = tsNode;
		this.parent = parent;
		this._ctx = context ?? parent!._ctx;
		if (this._registersInMaps()) {
			this._ctx.maps.tsNodeToESTreeNodeMap.set(tsNode, this);
			// esTreeNodeToTSNodeMap is a facade reading _ts — no .set needed.
		}
		if (DEBUG_ESTREE) {
			// `this.type` is set by the subclass's `readonly type = '...'`
			// field initialiser, which runs AFTER super() returns. Defer to
			// the next microtask so the read sees the final value.
			queueMicrotask(() => {
				const t = (this as unknown as { type: string }).type;
				nodeTypeCounts.set(t, (nodeTypeCounts.get(t) ?? 0) + 1);
			});
		}
	}

	// Real ESTree nodes claim the TS node's slot in tsNodeToESTreeNodeMap.
	// Synthetic intermediates (extending SyntheticLazyNode) don't — that
	// slot belongs to the inner converted node. Method dispatch through
	// the prototype chain means subclass overrides are visible during
	// super(), even though field initialisers haven't run yet.
	protected _registersInMaps(): boolean {
		return true;
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

// Architectural boundary: synthetic intermediates extend this base instead
// of LazyNode directly. They represent ESTree nodes with no direct TS
// counterpart (TSTypeAnnotation wrapping a TypeNode, ClassBody wrapping
// class members, ChainExpression wrapping an OptionalChain, etc.) — or
// share a TS node with an inner node that's the canonical map owner.
//
// Adding a synthetic class is a deliberate architectural act: the TS
// parent chain doesn't reach the new node directly, so bottom-up
// materialise needs a wrapper-route entry (TYPE_SLOT_TRIGGERS /
// WRAPPER_DRILLS / findJSXOwnerRoute / pattern-position routing /
// findTypeArgRoute / ChainExpressionWrappingNode dispatch) to traverse
// through it. Without one, bottom-up of a node inside the synthetic
// produces a parent reference pointing at the wrapper-less ESTree
// parent — a silently-wrong shape.
//
// Grep `extends SyntheticLazyNode` to find every current synthetic class;
// each entry there should have a corresponding navigation-table line.
abstract class SyntheticLazyNode extends LazyNode {
	protected override _registersInMaps(): boolean {
		return false;
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

// ─── SHAPE TABLE ─────────────────────────────────────────────────────────
//
// Single source of truth for "where typescript-estree's ESTree shape
// diverges from the raw TS AST". Two divergence categories are encoded
// here:
//
// 1. SKIP: a TS kind is structural-only (no ESTree counterpart in this
//    position) and should be transparent to materialise's parent walk.
//    The walk skips past, so the next-level real ESTree ancestor becomes
//    the child's parent. Examples: SyntaxList (marker), JsxAttributes
//    (container), VariableDeclarationList inside VariableStatement
//    (folded into VariableDeclaration), CatchClause's
//    VariableDeclaration shim (catch param is direct), HeritageClause
//    extends (lifted to ClassDeclaration.superClass).
//
// 2. WRAPPER (added incrementally below; not in this initial table —
//    findWrapperRoute still owns those for now): a slot needs a synthetic
//    ESTree wrapper between the TS child and the materialised parent
//    (e.g. TSTypeAnnotation between PropertySignature and the type kind).
//    Future commits move those into this table too.
//
// Adding a new shape divergence MUST update this table — the bottom-up
// walk consults it as the single authority. Also keeps the knowledge
// near each parent kind rather than scattered across if/else cascades.
type SkipDecision = boolean | ((walker: ts.Node) => boolean);
const SKIP_AS_PARENT: Partial<Record<ts.SyntaxKind, SkipDecision>> = {
	[SK.SyntaxList]: true,
	[SK.CaseBlock]: true,
	[SK.NamedImports]: true,
	[SK.NamedExports]: true,
	[SK.ImportClause]: true,
	[SK.JsxAttributes]: true,
	// TS wraps each `${expr}` in a TemplateSpan with the trailing literal
	// piece. ESTree flattens: TemplateLiteral.expressions and .quasis are
	// siblings, no per-span container. Skip past TemplateSpan so the
	// expressions/literal-pieces resolve to TemplateLiteral as parent.
	[SK.TemplateSpan]: true,
	// TS MappedType wraps the iterating identifier in a TypeParameter
	// container; ESTree exposes the bare name on TSMappedType.key. Skip
	// past TypeParameter so the inner Identifier resolves to TSMappedType,
	// matching typescript-estree's convertMappedType output.
	[SK.TypeParameter]: w => w.parent?.kind === SK.MappedType,
	// `import('foo')` type: TS wraps the string literal in a LiteralType
	// (so the AST shape is ImportTypeNode { argument: LiteralType {
	// literal: StringLiteral } }). ESTree exposes TSImportType.argument
	// as the bare StringLiteral — no TSLiteralType in between. Skip the
	// LiteralType so bottom-up materialise of the inner StringLiteral
	// resolves to TSImportType as parent.
	[SK.LiteralType]: w => w.parent?.kind === SK.ImportType,
	[SK.VariableDeclarationList]: w => w.parent?.kind === SK.VariableStatement,
	[SK.VariableDeclaration]: w => w.parent?.kind === SK.CatchClause,
	[SK.HeritageClause]: w => (w as ts.HeritageClause).token === SK.ExtendsKeyword,
	[SK.ExpressionWithTypeArguments]: w =>
		w.parent?.kind === SK.HeritageClause
		&& (w.parent as ts.HeritageClause).token === SK.ExtendsKeyword,
};
function shouldSkipAsParent(walker: ts.Node): boolean {
	const decision = SKIP_AS_PARENT[walker.kind];
	if (decision === undefined) return false;
	return typeof decision === 'function' ? decision(walker) : decision;
}

// Wrapper-drill entries: when materialise's walk-up hits a CACHED ancestor
// whose ESTree shape WRAPS the child's actual parent (synthetic
// intermediate slot without TS counterpart), drill into the slot to set
// the right parent. Without these, e.g. a class method's parameter
// resolves `parent.parent` as ClassDeclaration directly, missing the
// ClassBody wrapper between.
//
// Entries are evaluated in order; first match wins. Adding a new drill
// case = one new entry (declarative match + drill function).
interface WrapperDrill {
	match: (walker: ts.Node, drillFromType: string | undefined, innermostChild: ts.Node) => boolean;
	drill: (drillFrom: any, walker: ts.Node) => LazyNode | undefined;
}
const WRAPPER_DRILLS: WrapperDrill[] = [
	// Class members → ClassBody. ts.ClassDeclaration/Expression children
	// (Method/Property/Static block etc.) live in ESTree under
	// ClassDeclaration.body (a ClassBody wrapper).
	{
		match: (w, _dt, child) =>
			(w.kind === SK.ClassDeclaration || w.kind === SK.ClassExpression)
			&& CLASS_MEMBER_KINDS_SET[child.kind] === 1,
		drill: drillFrom => drillFrom.body,
	},
	// Interface members → TSInterfaceBody. Same pattern.
	{
		match: (w, _dt, child) =>
			w.kind === SK.InterfaceDeclaration
			&& INTERFACE_MEMBER_KINDS_SET[child.kind] === 1,
		drill: drillFrom => drillFrom.body,
	},
	// Enum members → TSEnumBody.
	{
		match: (w, _dt, child) =>
			w.kind === SK.EnumDeclaration
			&& child.kind === SK.EnumMember,
		drill: drillFrom => drillFrom.body,
	},
	// `class A { constructor(public x = 0) {} }` — Parameter cached as
	// TSParameterProperty wrapper. The parameter's initializer slot
	// belongs to AssignmentPattern (sitting at wrapper.parameter).
	{
		match: (w, dt, child) =>
			w.kind === SK.Parameter
			&& dt === 'TSParameterProperty'
			&& child === (w as ts.ParameterDeclaration).initializer,
		drill: drillFrom => {
			const ap = drillFrom.parameter;
			return ap && ap.type === 'AssignmentPattern' ? ap : undefined;
		},
	},
	// Class methods (MethodDefinition / TSAbstractMethodDefinition) wrap a
	// FunctionExpression in `.value`. Children of the underlying ts.Method/
	// Constructor/GetAccessor/SetAccessor map to slots on FunctionExpression
	// (params, body, returnType, typeParameters) EXCEPT for `name`.
	{
		match: (w, dt, child) =>
			(dt === 'MethodDefinition' || dt === 'TSAbstractMethodDefinition')
			&& (w.kind === SK.MethodDeclaration || w.kind === SK.Constructor
				|| w.kind === SK.GetAccessor || w.kind === SK.SetAccessor)
			&& child !== (w.kind !== SK.Constructor
					? (w as ts.MethodDeclaration | ts.GetAccessorDeclaration | ts.SetAccessorDeclaration).name
					: undefined),
		drill: drillFrom => drillFrom.value,
	},
	// Object-literal method shorthand / accessors wrap into Property.value.
	{
		match: (w, dt, child) =>
			dt === 'Property'
			&& (w.kind === SK.MethodDeclaration || w.kind === SK.GetAccessor || w.kind === SK.SetAccessor)
			&& child !== (w as ts.MethodDeclaration | ts.GetAccessorDeclaration | ts.SetAccessorDeclaration).name,
		drill: drillFrom => drillFrom.value,
	},
	// `const { x = 1 } = o` — BindingElement's name (and default
	// initializer) live at Property.value.left / .right (AssignmentPattern).
	{
		match: (w, _dt, child) =>
			w.kind === SK.BindingElement
			&& (w as ts.BindingElement).initializer !== undefined
			&& w.parent?.kind === SK.ObjectBindingPattern
			&& (child === (w as ts.BindingElement).name
				|| child === (w as ts.BindingElement).initializer),
		drill: drillFrom => {
			const v = drillFrom.value;
			return v && v.type === 'AssignmentPattern' ? v : undefined;
		},
	},
	// `typeof import('x')` — the TSTypeQueryWrappingNode claims the
	// ImportType's TS slot in the cache, but the inner TSImportType
	// (TSTypeQuery.exprName) is what holds the import's children. Without
	// this drill, bottom-up materialise of the import's argument lands
	// on TSTypeQuery directly, missing the inner TSImportType layer.
	{
		match: (w, dt) => w.kind === SK.ImportType && dt === 'TSTypeQuery',
		drill: drillFrom => drillFrom.exprName,
	},
];

// Per-parent-kind: how to materialise the type-position child via the
// parent's getter chain. typescript-estree always wraps these slots in
// a synthetic TSTypeAnnotation; the trigger drills the path that builds
// the wrapper + registers the inner TypeNode in the cache.
//
// Adding a TS parent kind that has a `.type` slot rendered through a
// TSTypeAnnotation wrapper means one new line here — the wrapper-route
// dispatch picks it up automatically.
const TYPE_SLOT_TRIGGERS: Partial<Record<ts.SyntaxKind, (owner: any) => void>> = {
	[SK.VariableDeclaration]: o => {
		// VariableDeclaration.type is exposed via `id.typeAnnotation.typeAnnotation`
		// (the binding name carries the annotation in the ESTree shape).
		const id = o.id;
		if (id?.typeAnnotation) void id.typeAnnotation.typeAnnotation;
	},
	[SK.Parameter]: o => {
		// Owner may be AssignmentPattern (default value) or
		// TSParameterProperty (`private x: T`); drill through to the
		// binding name to reach `.typeAnnotation`.
		let cur = o;
		if (cur.parameter) cur = cur.parameter;
		if (cur.left) cur = cur.left;
		if (cur.typeAnnotation) void cur.typeAnnotation.typeAnnotation;
	},
	[SK.FunctionDeclaration]: o => {
		const inner = unwrapInner(o) as any;
		if (inner.returnType) void inner.returnType.typeAnnotation;
	},
	[SK.FunctionExpression]: o => {
		const inner = unwrapInner(o) as any;
		if (inner.returnType) void inner.returnType.typeAnnotation;
	},
	[SK.ArrowFunction]: o => {
		const inner = unwrapInner(o) as any;
		if (inner.returnType) void inner.returnType.typeAnnotation;
	},
	[SK.PropertySignature]: o => {
		if (o.typeAnnotation) void o.typeAnnotation.typeAnnotation;
	},
	[SK.MethodSignature]: o => {
		if (o.returnType) void o.returnType.typeAnnotation;
	},
	[SK.CallSignature]: o => {
		if (o.returnType) void o.returnType.typeAnnotation;
	},
	[SK.ConstructSignature]: o => {
		if (o.returnType) void o.returnType.typeAnnotation;
	},
	[SK.IndexSignature]: o => {
		if (o.typeAnnotation) void o.typeAnnotation.typeAnnotation;
	},
	[SK.FunctionType]: o => {
		if (o.returnType) void o.returnType.typeAnnotation;
	},
	[SK.ConstructorType]: o => {
		if (o.returnType) void o.returnType.typeAnnotation;
	},
	[SK.PropertyDeclaration]: o => {
		// PropertyDefinition / AccessorProperty / TSAbstract* — class field.
		if (o.typeAnnotation) void o.typeAnnotation.typeAnnotation;
	},
	[SK.MethodDeclaration]: o => {
		// MethodDefinition / Property (object shorthand) — method body is a
		// FunctionExpression at .value; returnType lives there.
		if (o.value?.returnType) void o.value.returnType.typeAnnotation;
	},
	[SK.GetAccessor]: o => {
		// MethodDefinition kind:'get' / Property kind:'get'.
		if (o.value?.returnType) void o.value.returnType.typeAnnotation;
	},
	[SK.TypePredicate]: o => {
		// `x is T` — the predicate's inner type itself wraps in a nested
		// TSTypeAnnotation.
		if (o.typeAnnotation) void o.typeAnnotation.typeAnnotation;
	},
};

// Pattern-position parent kinds (BinaryExpression-LHS / for-loop-LHS /
// nested-pattern host) — these reach findWrapperRoute via the
// pattern-literal-target path. Type-slot parent kinds are derived from
// TYPE_SLOT_TRIGGERS so the bitmap can never drift from the table.
const PATTERN_POSITION_PARENTS = [
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
] as const;

const WRAPPER_ROUTE_PARENT_BITMAP = (() => {
	const a = new Uint8Array(400);
	for (const k of PATTERN_POSITION_PARENTS) a[k] = 1;
	for (const kStr of Object.keys(TYPE_SLOT_TRIGGERS)) a[+kStr] = 1;
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

// TS parent kinds that expose a `typeArguments: ts.NodeArray<TypeNode>`
// field. Looked up by parent kind during findTypeArgRoute. Bottom-up
// materialise of a TypeNode in this position routes through the parent's
// `typeArguments.params` getter (which produces the synthetic
// TSTypeParameterInstantiation wrapper that typescript-estree emits).
//
// JsxSelfClosingElement is special: it materialises as JSXElement, so
// `typeArguments` lives on the synthetic openingElement instead.
const TYPE_ARG_HOSTS: Partial<Record<ts.SyntaxKind, (parent: ts.Node) => ts.NodeArray<ts.TypeNode> | undefined>> = {
	[SK.TypeReference]: p => (p as ts.TypeReferenceNode).typeArguments,
	[SK.ImportType]: p => (p as ts.ImportTypeNode).typeArguments,
	[SK.NewExpression]: p => (p as ts.NewExpression).typeArguments,
	[SK.TaggedTemplateExpression]: p => (p as ts.TaggedTemplateExpression).typeArguments,
	[SK.ExpressionWithTypeArguments]: p => (p as ts.ExpressionWithTypeArguments).typeArguments,
	[SK.CallExpression]: p => (p as ts.CallExpression).typeArguments,
	[SK.JsxOpeningElement]: p => (p as ts.JsxOpeningElement).typeArguments,
	[SK.JsxSelfClosingElement]: p => (p as ts.JsxSelfClosingElement).typeArguments,
};
function findTypeArgRoute(tsNode: ts.Node):
	| { ownerTsNode: ts.Node; trigger: (owner: LazyNode) => void }
	| null
{
	const tsParent = tsNode.parent;
	if (!tsParent) return null;
	const getTypeArgs = TYPE_ARG_HOSTS[tsParent.kind];
	if (!getTypeArgs) return null;
	const typeArgs = getTypeArgs(tsParent);
	if (!typeArgs || typeArgs.indexOf(tsNode as ts.TypeNode) < 0) return null;
	const isSelfClosing = tsParent.kind === SK.JsxSelfClosingElement;
	return {
		ownerTsNode: tsParent,
		trigger: owner => {
			if (isSelfClosing) {
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

	// JsxAttribute / JsxSpreadAttribute: ESTree exposes attributes via
	// JSXOpeningElement.attributes — synthetic for JsxSelfClosingElement
	// (whose materialise is JSXElement, not JSXOpeningElement). Without a
	// route, bottom-up materialise of an attribute under a self-closing tag
	// lands `attribute.parent = JSXElement` instead of the synthetic
	// JSXOpeningElement that eager produces. Route through the
	// owning element's `openingElement.attributes` getter (or directly
	// `attributes` for non-self-closing JsxOpeningElement) so the
	// JSXAttribute children land with the correct synthetic parent in both
	// cases. The TS parent chain is JsxAttribute → JsxAttributes → owning
	// element; the JsxAttributes container has no ESTree counterpart and is
	// also skipped in materialise's walk-up.
	if (
		(tsNode.kind === SK.JsxAttribute || tsNode.kind === SK.JsxSpreadAttribute)
		&& tsParent.kind === SK.JsxAttributes
		&& tsParent.parent
	) {
		const owner = tsParent.parent;
		const ownerKind = owner.kind;
		if (ownerKind === SK.JsxOpeningElement || ownerKind === SK.JsxSelfClosingElement) {
			return {
				ownerTsNode: owner,
				trigger: ownerNode => {
					if (ownerKind === SK.JsxSelfClosingElement) {
						// owner materialises as JSXElement; attributes live on
						// its synthetic openingElement.
						const opening = (ownerNode as unknown as { openingElement?: { attributes?: unknown } }).openingElement;
						if (opening) void opening.attributes;
					}
					else {
						void (ownerNode as unknown as { attributes?: unknown }).attributes;
					}
				},
			};
		}
	}

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
	// All `.type` slot wrappers (VariableDeclaration / Parameter /
	// FunctionLike return / Signature kinds) are declared in
	// TYPE_SLOT_TRIGGERS. Each entry is the trigger callback that
	// drills the parent's getter chain to materialise the synthetic
	// TSTypeAnnotation wrapper + register the inner type in the cache.
	const typeTrigger = TYPE_SLOT_TRIGGERS[tsParent.kind];
	if (typeTrigger && (tsParent as { type?: ts.Node }).type === tsNode) {
		return { ownerTsNode: tsParent, trigger: typeTrigger };
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
		// Structural-only TS kinds (no ESTree counterpart in their usual
		// position) are declared in SKIP_AS_PARENT. The walker skips past
		// them so the child's parent resolves to the next-level real
		// ESTree ancestor.
		if (shouldSkipAsParent(walker)) {
			walker = walker.parent;
			continue;
		}
		const cachedAnc = tsCache.get(walker);
		if (cachedAnc) {
			parent = cachedAnc as LazyNode;
			// Step 1: unwrap Export wrappers. For `export class Foo {}` the
			// cache holds ExportNamedDeclaration { declaration: ClassDecl };
			// the actual parent of class members is the inner declaration,
			// not the wrapper. Default to the inner; specific drills below
			// can override (class body, function value, etc.).
			let drillFrom: LazyNode = parent;
			let drillType = (drillFrom as { type?: string }).type;
			while (drillType === 'ExportNamedDeclaration' || drillType === 'ExportDefaultDeclaration') {
				const decl = (drillFrom as unknown as { declaration?: LazyNode }).declaration;
				if (!decl) break;
				drillFrom = decl;
				drillType = (drillFrom as { type?: string }).type;
			}
			if (drillFrom !== parent) parent = drillFrom;
			// Step 2: apply the first matching wrapper drill (synthetic
			// intermediate slot like ClassBody / FunctionExpression.value /
			// AssignmentPattern). See WRAPPER_DRILLS for the table.
			const innermostChild = toBuild.length > 0 ? toBuild[toBuild.length - 1] : tsNode;
			for (const d of WRAPPER_DRILLS) {
				if (d.match(walker, drillType, innermostChild)) {
					const drilled = d.drill(drillFrom as any, walker);
					if (drilled) parent = drilled;
					break;
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

// ─── SHAPE TABLE (top-down) ──────────────────────────────────────────────
//
// Same idea as the bottom-up SKIP_AS_PARENT / TYPE_SLOT_TRIGGERS / etc.
// tables: each TS SyntaxKind whose lazy class has only mechanical
// `get x() { return this._x ??= convertChild(this._ts.field, this); }`
// getters lives in SHAPES instead of as a hand-written subclass.
// Single source of truth for both directions:
//   - top-down: makeShapeClass turns a ShapeDef into a LazyNode subclass
//     with memoised getters
//   - bottom-up: existing materialise consults the same registry to know
//     which class to instantiate
// Adding a new mechanical TS kind = one new SHAPES entry instead of a
// new subclass + a new switch case in convertChildInner.
//
// SHAPES only handles the mechanical pattern. Subclasses with custom
// constructor logic (range mutation, modifier-derived flags, conditional
// branching) stay hand-written. The factory + table live alongside.
type ShapeSlotConvert<TsT> =
	| 'convertChild'
	| 'convertChildren'
	| 'convertChildAsPattern'
	| ((tsValue: TsT, parent: LazyNode) => any);
interface ShapeSlotDef<TsParent, TsT = any> {
	// Constrain to keys whose value type extends ts.Node | NodeArray | undefined.
	// Catches typos at the migration call site.
	tsField: keyof TsParent & string;
	// How to convert the TS value. Defaults to 'convertChild'. Function
	// option lets a slot route through a custom converter (e.g.
	// `convertTypeAnnotation` for synthetic-wrapper-bearing type slots).
	via?: ShapeSlotConvert<TsT>;
	// Value when the TS field is null/undefined. Default 'null' — matches
	// typescript-estree for value slots (`init`, `expression`, etc.).
	// Type-position slots (`returnType`, `typeAnnotation`, `typeArguments`)
	// use 'undefined' to match eager's distinction. Note: even
	// `whenAbsent: 'undefined'` slots become own-properties on the instance
	// (eager emits them via Object.keys round-trip parity).
	whenAbsent?: 'null' | 'undefined';
}
// Sentinel: cache value "not yet computed". Lets factory-built getters
// memoise null AND undefined results without re-running on subsequent
// reads. Hand-written subclasses use the `??=` pattern which conflates
// the two; the factory needs to honour eager's null-vs-undefined
// distinction (e.g. ReturnStatement.argument is null when bare; type
// annotations are undefined when absent).
const SHAPE_UNSET = Symbol('shape-unset');
interface ShapeDef<TsT extends ts.Node = ts.Node> {
	// Either a fixed type or a discriminator computed from the TS node.
	// Used when a single TS kind maps to multiple ESTree types based on
	// shape (e.g. ts.PrefixUnaryExpression → UnaryExpression vs UpdateExpression
	// based on operator).
	type: KnownEstreeType | ((tsNode: TsT) => KnownEstreeType);
	slots: Record<string, ShapeSlotDef<TsT>>;
	// Static field defaults — values that don't depend on the TS node
	// (e.g. UnaryExpression's `operator: 'void'`, ObjectPattern's
	// `decorators: EMPTY_ARRAY`). Per-instance assignment matches how
	// `readonly x = '...'` class fields compile.
	defaults?: Record<string, unknown>;
	// Per-instance callback that derives readonly fields from the TS
	// node (e.g. computing `delegate` from `asteriskToken`,
	// `const`/`in`/`out` from modifier flags). Applied after super().
	consts?: (tsNode: TsT, instance: any) => Record<string, unknown>;
	// Custom range — overrides the lazy default (computed from
	// tsNode.getStart() / .getEnd()). Used by classes that absorb a
	// child's range or strip leading modifiers (eager parity).
	range?: (tsNode: TsT, ctx: ConvertContext) => [number, number];
	// Post-construction hook. Runs after super(), defaults, consts, and
	// range. Used for setup that needs the constructed instance — like
	// re-parenting an inner node, registering an extra cache entry, or
	// extending range from a not-yet-built child.
	init?: (instance: any, tsNode: TsT) => void;
}
// Dispatch entry type — either a fixed ShapeDef (single class per kind)
// or a router function that selects among multiple defs based on
// dispatch-time context (e.g. parent kind for ts.MethodDeclaration which
// becomes MethodDefinition vs Property based on whether parent is a
// class or object literal).
type ShapeDispatch =
	| { def: ShapeDef<any>; cls: new(tsNode: ts.Node, parent: LazyNode | null) => LazyNode }
	| { route: (tsNode: ts.Node, parent: LazyNode | null) => LazyNode | null };
const SHAPE_CLASSES = new Map<ts.SyntaxKind, ShapeDispatch>();

function makeShapeClass<TsT extends ts.Node>(def: ShapeDef<TsT>): new(tsNode: ts.Node, parent: LazyNode | null) => LazyNode {
	const slotKeys = Object.keys(def.slots).map(g => '_' + g);
	const cls = class extends LazyNode {
		// Subclass overrides — assigned in constructor body. The base
		// class's `abstract readonly type` is satisfied by the assignment.
		readonly type!: KnownEstreeType;
		constructor(tsNode: ts.Node, parent: LazyNode | null) {
			super(tsNode, parent);
			(this as { type: KnownEstreeType }).type = typeof def.type === 'function'
				? def.type(tsNode as TsT)
				: def.type;
			// Init each cache key to UNSET so getters can distinguish
			// "not yet read" from "computed and got null/undefined".
			for (const k of slotKeys) (this as any)[k] = SHAPE_UNSET;
			if (def.defaults) Object.assign(this, def.defaults);
			if (def.consts) Object.assign(this, def.consts(tsNode as TsT, this));
			if (def.range) this.range = def.range(tsNode as TsT, this._ctx);
			if (def.init) def.init(this, tsNode as TsT);
		}
	};
	for (const [getter, slot] of Object.entries(def.slots)) {
		const cacheKey = '_' + getter;
		const absent = slot.whenAbsent === 'undefined' ? undefined : null;
		const via = slot.via ?? 'convertChild';
		Object.defineProperty(cls.prototype, getter, {
			get(this: any) {
				if (this[cacheKey] !== SHAPE_UNSET) return this[cacheKey];
				const tsValue = this._ts[slot.tsField];
				if (tsValue == null) return this[cacheKey] = absent;
				if (typeof via === 'function') return this[cacheKey] = via(tsValue, this);
				if (via === 'convertChildren') return this[cacheKey] = convertChildren(tsValue, this);
				if (via === 'convertChildAsPattern') return this[cacheKey] = convertChildAsPattern(tsValue, this);
				return this[cacheKey] = convertChild(tsValue, this);
			},
			configurable: true,
		});
	}
	return cls;
}

function defineShape<TsT extends ts.Node>(tsKind: ts.SyntaxKind, def: ShapeDef<TsT>): void {
	const cls = makeShapeClass(def);
	SHAPE_CLASSES.set(tsKind, { def, cls });
}

// Context-aware dispatch: choose among multiple shape variants based on
// dispatch-time information (parent kind, modifier presence, etc.). The
// returned LazyNode flows through the same SHAPES path as fixed
// defineShape entries.
function defineShapeRouter(tsKind: ts.SyntaxKind, route: (tsNode: ts.Node, parent: LazyNode | null) => LazyNode | null): void {
	SHAPE_CLASSES.set(tsKind, { route });
}

// Mechanical shapes. Each entry replaces a hand-written subclass +
// switch case below. Pure declarative form — top-down getters AND
// bottom-up materialise both consult this single registry.
defineShape<ts.IfStatement>(SK.IfStatement, {
	type: 'IfStatement',
	slots: {
		test: { tsField: 'expression' },
		consequent: { tsField: 'thenStatement' },
		alternate: { tsField: 'elseStatement' },
	},
});
defineShape<ts.ReturnStatement>(SK.ReturnStatement, {
	type: 'ReturnStatement',
	slots: { argument: { tsField: 'expression' } },
});
defineShape<ts.UnionTypeNode>(SK.UnionType, {
	type: 'TSUnionType',
	slots: { types: { tsField: 'types', via: 'convertChildren' } },
});
defineShape<ts.IntersectionTypeNode>(SK.IntersectionType, {
	type: 'TSIntersectionType',
	slots: { types: { tsField: 'types', via: 'convertChildren' } },
});
defineShape<ts.ArrayTypeNode>(SK.ArrayType, {
	type: 'TSArrayType',
	slots: { elementType: { tsField: 'elementType' } },
});
defineShape<ts.TypeLiteralNode>(SK.TypeLiteral, {
	type: 'TSTypeLiteral',
	slots: { members: { tsField: 'members', via: 'convertChildren' } },
});
defineShape<ts.IndexedAccessTypeNode>(SK.IndexedAccessType, {
	type: 'TSIndexedAccessType',
	slots: {
		objectType: { tsField: 'objectType' },
		indexType: { tsField: 'indexType' },
	},
});
// SK.LiteralType NOT migrated: convertLiteralType has a special case
// for `null` (wraps NullKeyword as bare TSNullKeyword to match eager).
defineShape<ts.QualifiedName>(SK.QualifiedName, {
	type: 'TSQualifiedName',
	slots: {
		left: { tsField: 'left' },
		right: { tsField: 'right' },
	},
});
defineShape<ts.TypeAssertion>(SK.TypeAssertionExpression, {
	type: 'TSTypeAssertion',
	slots: {
		expression: { tsField: 'expression' },
		typeAnnotation: { tsField: 'type' },
	},
});
defineShape<ts.SatisfiesExpression>(SK.SatisfiesExpression, {
	type: 'TSSatisfiesExpression',
	slots: {
		expression: { tsField: 'expression' },
		typeAnnotation: { tsField: 'type' },
	},
});
defineShape<ts.ConditionalTypeNode>(SK.ConditionalType, {
	type: 'TSConditionalType',
	slots: {
		checkType: { tsField: 'checkType' },
		extendsType: { tsField: 'extendsType' },
		trueType: { tsField: 'trueType' },
		falseType: { tsField: 'falseType' },
	},
});
defineShape<ts.InferTypeNode>(SK.InferType, {
	type: 'TSInferType',
	slots: { typeParameter: { tsField: 'typeParameter' } },
});
defineShape<ts.ModuleBlock>(SK.ModuleBlock, {
	type: 'TSModuleBlock',
	slots: { body: { tsField: 'statements', via: 'convertChildren' } },
});
defineShape<ts.Decorator>(SK.Decorator, {
	type: 'Decorator',
	slots: { expression: { tsField: 'expression' } },
});
// SK.ObjectLiteralExpression NOT migrated: convertChildInner picks
// ObjectPattern vs ObjectExpression based on `allowPattern` flag.
// Same for ArrayLiteralExpression. SHAPES table is a static dispatch
// (TS kind → ESTree class); pattern-context dispatch stays in
// convertChildInner's switch.
defineShape<ts.ThrowStatement>(SK.ThrowStatement, {
	type: 'ThrowStatement',
	slots: { argument: { tsField: 'expression' } },
});
defineShape<ts.TryStatement>(SK.TryStatement, {
	type: 'TryStatement',
	slots: {
		block: { tsField: 'tryBlock' },
		handler: { tsField: 'catchClause' },
		finalizer: { tsField: 'finallyBlock' },
	},
});
defineShape<ts.WhileStatement>(SK.WhileStatement, {
	type: 'WhileStatement',
	slots: {
		test: { tsField: 'expression' },
		body: { tsField: 'statement' },
	},
});
defineShape<ts.DoStatement>(SK.DoStatement, {
	type: 'DoWhileStatement',
	slots: {
		test: { tsField: 'expression' },
		body: { tsField: 'statement' },
	},
});
defineShape<ts.ForStatement>(SK.ForStatement, {
	type: 'ForStatement',
	slots: {
		init: { tsField: 'initializer' },
		test: { tsField: 'condition' },
		update: { tsField: 'incrementor' },
		body: { tsField: 'statement' },
	},
});
defineShape<ts.LabeledStatement>(SK.LabeledStatement, {
	type: 'LabeledStatement',
	slots: {
		label: { tsField: 'label' },
		body: { tsField: 'statement' },
	},
});
defineShape<ts.AwaitExpression>(SK.AwaitExpression, {
	type: 'AwaitExpression',
	slots: { argument: { tsField: 'expression' } },
});
defineShape<ts.TupleTypeNode>(SK.TupleType, {
	type: 'TSTupleType',
	slots: { elementTypes: { tsField: 'elements', via: 'convertChildren' } },
});
defineShape<ts.OptionalTypeNode>(SK.OptionalType, {
	type: 'TSOptionalType',
	slots: { typeAnnotation: { tsField: 'type' } },
});
defineShape<ts.RestTypeNode>(SK.RestType, {
	type: 'TSRestType',
	slots: { typeAnnotation: { tsField: 'type' } },
});
defineShape<ts.ConditionalExpression>(SK.ConditionalExpression, {
	type: 'ConditionalExpression',
	slots: {
		test: { tsField: 'condition' },
		consequent: { tsField: 'whenTrue' },
		alternate: { tsField: 'whenFalse' },
	},
});
defineShape<ts.NonNullExpression>(SK.NonNullExpression, {
	type: 'TSNonNullExpression',
	slots: { expression: { tsField: 'expression' } },
});
defineShape<ts.ExternalModuleReference>(SK.ExternalModuleReference, {
	type: 'TSExternalModuleReference',
	slots: { expression: { tsField: 'expression' } },
});
defineShape<ts.ImportAttribute>(SK.ImportAttribute, {
	type: 'ImportAttribute',
	slots: {
		key: { tsField: 'name' },
		value: { tsField: 'value' },
	},
});
// Constructor-derived fields (`consts`):
defineShape<ts.TypeParameterDeclaration>(SK.TypeParameter, {
	type: 'TSTypeParameter',
	consts: tn => ({
		const: !!tn.modifiers?.some(m => m.kind === SK.ConstKeyword),
		in: !!tn.modifiers?.some(m => m.kind === SK.InKeyword),
		out: !!tn.modifiers?.some(m => m.kind === SK.OutKeyword),
	}),
	slots: {
		name: { tsField: 'name' },
		constraint: { tsField: 'constraint' },
		default: { tsField: 'default' },
	},
});
defineShape<ts.YieldExpression>(SK.YieldExpression, {
	type: 'YieldExpression',
	consts: tn => ({ delegate: !!tn.asteriskToken }),
	slots: { argument: { tsField: 'expression' } },
});
// Pure mechanical with `defaults`:
defineShape<ts.AsExpression>(SK.AsExpression, {
	type: 'TSAsExpression',
	slots: {
		expression: { tsField: 'expression' },
		typeAnnotation: { tsField: 'type' },
	},
});
defineShape<ts.ExpressionStatement>(SK.ExpressionStatement, {
	type: 'ExpressionStatement',
	defaults: { directive: undefined },
	slots: { expression: { tsField: 'expression' } },
});
defineShape<ts.TypeQueryNode>(SK.TypeQuery, {
	type: 'TSTypeQuery',
	defaults: { typeArguments: undefined },
	slots: { exprName: { tsField: 'exprName' } },
});
defineShape<ts.NamespaceImport>(SK.NamespaceImport, {
	type: 'ImportNamespaceSpecifier',
	slots: { local: { tsField: 'name' } },
});
defineShape<ts.ObjectBindingPattern>(SK.ObjectBindingPattern, {
	type: 'ObjectPattern',
	defaults: { decorators: EMPTY_ARRAY, optional: false, typeAnnotation: undefined },
	slots: { properties: { tsField: 'elements', via: 'convertChildren' } },
});
// Unary expressions — TS has separate kinds for void/typeof/delete; ESTree
// folds them into UnaryExpression with the operator literal baked in.
defineShape<ts.VoidExpression>(SK.VoidExpression, {
	type: 'UnaryExpression',
	defaults: { operator: 'void', prefix: true },
	slots: { argument: { tsField: 'expression' } },
});
defineShape<ts.DeleteExpression>(SK.DeleteExpression, {
	type: 'UnaryExpression',
	defaults: { operator: 'delete', prefix: true },
	slots: { argument: { tsField: 'expression' } },
});
defineShape<ts.TypeOfExpression>(SK.TypeOfExpression, {
	type: 'UnaryExpression',
	defaults: { operator: 'typeof', prefix: true },
	slots: { argument: { tsField: 'expression' } },
});
// Shapes that use custom converter funcs + whenAbsent='undefined' for
// type-position slots:
defineShape<ts.TypeReferenceNode>(SK.TypeReference, {
	type: 'TSTypeReference',
	slots: {
		typeName: { tsField: 'typeName' },
		typeArguments: { tsField: 'typeArguments', via: convertTypeArguments, whenAbsent: 'undefined' },
	},
});
defineShape<ts.ConstructorTypeNode>(SK.ConstructorType, {
	type: 'TSConstructorType',
	consts: tn => ({
		abstract: !!tn.modifiers?.some(m => m.kind === SK.AbstractKeyword),
	}),
	slots: {
		typeParameters: { tsField: 'typeParameters', via: convertTypeParameters, whenAbsent: 'undefined' },
		params: { tsField: 'parameters', via: 'convertChildren' },
		returnType: { tsField: 'type', via: convertTypeAnnotation, whenAbsent: 'undefined' },
	},
});
defineShape<ts.ModuleDeclaration>(SK.ModuleDeclaration, {
	type: 'TSModuleDeclaration',
	consts: tn => ({
		declare: !!tn.modifiers?.some(m => m.kind === SK.DeclareKeyword),
		global: !!(tn.flags & ts.NodeFlags.GlobalAugmentation),
		kind: tn.flags & ts.NodeFlags.Namespace ? 'namespace' : 'module',
	}),
	slots: {
		id: { tsField: 'name' },
		body: { tsField: 'body' },
	},
});
defineShape<ts.EnumMember>(SK.EnumMember, {
	type: 'TSEnumMember',
	consts: tn => ({
		computed: tn.name.kind === SK.ComputedPropertyName,
	}),
	slots: {
		id: { tsField: 'name' },
		initializer: { tsField: 'initializer' },
	},
});
defineShape<ts.TypeAliasDeclaration>(SK.TypeAliasDeclaration, {
	type: 'TSTypeAliasDeclaration',
	consts: tn => ({
		declare: !!tn.modifiers?.some(m => m.kind === SK.DeclareKeyword),
	}),
	slots: {
		id: { tsField: 'name' },
		typeParameters: { tsField: 'typeParameters', via: convertTypeParameters, whenAbsent: 'undefined' },
		typeAnnotation: { tsField: 'type' },
	},
});
defineShape<ts.ImportEqualsDeclaration>(SK.ImportEqualsDeclaration, {
	type: 'TSImportEqualsDeclaration',
	consts: tn => ({
		importKind: tn.isTypeOnly ? 'type' : 'value',
	}),
	slots: {
		id: { tsField: 'name' },
		moduleReference: { tsField: 'moduleReference' },
	},
});
defineShape<ts.IndexSignatureDeclaration>(SK.IndexSignature, {
	type: 'TSIndexSignature',
	defaults: { accessibility: undefined },
	consts: tn => ({
		readonly: !!tn.modifiers?.some(m => m.kind === SK.ReadonlyKeyword),
		static: !!tn.modifiers?.some(m => m.kind === SK.StaticKeyword),
	}),
	slots: {
		parameters: { tsField: 'parameters', via: 'convertChildren' },
		typeAnnotation: { tsField: 'type', via: convertTypeAnnotation, whenAbsent: 'undefined' },
	},
});
defineShape<ts.PropertyAssignment>(SK.PropertyAssignment, {
	type: 'Property',
	defaults: { kind: 'init', method: false, optional: false, shorthand: false },
	consts: tn => ({
		computed: tn.name.kind === SK.ComputedPropertyName,
	}),
	slots: {
		key: { tsField: 'name' },
		value: { tsField: 'initializer' },
	},
});
// Pure type-tag shapes — no slots, no fields. The ESTree node carries
// only the `type` discriminator and inherited range/loc/parent.
defineShape<ts.SuperExpression>(SK.SuperKeyword, { type: 'Super', slots: {} });
defineShape<ts.ThisExpression>(SK.ThisKeyword, { type: 'ThisExpression', slots: {} });
defineShape<ts.ThisTypeNode>(SK.ThisType, { type: 'TSThisType', slots: {} });
defineShape<ts.EmptyStatement>(SK.EmptyStatement, { type: 'EmptyStatement', slots: {} });
defineShape<ts.JsxOpeningFragment>(SK.JsxOpeningFragment, { type: 'JSXOpeningFragment', slots: {} });
defineShape<ts.JsxClosingFragment>(SK.JsxClosingFragment, { type: 'JSXClosingFragment', slots: {} });
// `null` literal in expression position. The LiteralType wrapper case
// (`type X = null`) is handled separately in convertLiteralType, which
// emits TSNullKeyword instead.
defineShape<ts.NullLiteral>(SK.NullKeyword, {
	type: 'Literal',
	slots: {},
	defaults: { value: null, raw: 'null' },
});
defineShape<ts.PrivateIdentifier>(SK.PrivateIdentifier, {
	type: 'PrivateIdentifier',
	slots: {},
	consts: tn => ({ name: tn.text.slice(1) }),
});
defineShape<ts.JsxSpreadAttribute>(SK.JsxSpreadAttribute, {
	type: 'JSXSpreadAttribute',
	slots: { argument: { tsField: 'expression' } },
});
defineShape<ts.JsxClosingElement>(SK.JsxClosingElement, {
	type: 'JSXClosingElement',
	slots: { name: { tsField: 'tagName', via: convertJSXTagName } },
});
defineShape<ts.ClassStaticBlockDeclaration>(SK.ClassStaticBlockDeclaration, {
	type: 'StaticBlock',
	slots: {
		body: { tsField: 'body', via: (block, parent) => convertChildren(block.statements, parent) },
	},
	defaults: { decorators: EMPTY_ARRAY },
});

// --- Round 2 migrations (statements, control flow, JSX leaves) -----------
defineShape<ts.CatchClause>(SK.CatchClause, {
	type: 'CatchClause',
	slots: {
		param: { tsField: 'variableDeclaration', via: (decl, parent) => convertChild((decl as ts.VariableDeclaration).name, parent) },
		body: { tsField: 'block' },
	},
});
defineShape<ts.ForInStatement>(SK.ForInStatement, {
	type: 'ForInStatement',
	slots: {
		left: { tsField: 'initializer', via: 'convertChildAsPattern' },
		right: { tsField: 'expression' },
		body: { tsField: 'statement' },
	},
});
defineShape<ts.ForOfStatement>(SK.ForOfStatement, {
	type: 'ForOfStatement',
	consts: tn => ({ await: !!tn.awaitModifier }),
	slots: {
		left: { tsField: 'initializer', via: 'convertChildAsPattern' },
		right: { tsField: 'expression' },
		body: { tsField: 'statement' },
	},
});
defineShape<ts.SwitchStatement>(SK.SwitchStatement, {
	type: 'SwitchStatement',
	slots: {
		discriminant: { tsField: 'expression' },
		cases: { tsField: 'caseBlock', via: (cb, parent) => convertChildren((cb as ts.CaseBlock).clauses, parent) },
	},
});
defineShape<ts.CaseClause>(SK.CaseClause, {
	type: 'SwitchCase',
	slots: {
		test: { tsField: 'expression' },
		consequent: { tsField: 'statements', via: 'convertChildren' },
	},
});
defineShape<ts.DefaultClause>(SK.DefaultClause, {
	type: 'SwitchCase',
	defaults: { test: null },
	slots: {
		consequent: { tsField: 'statements', via: 'convertChildren' },
	},
});
defineShape<ts.BreakStatement>(SK.BreakStatement, {
	type: 'BreakStatement',
	slots: { label: { tsField: 'label' } },
});
defineShape<ts.ContinueStatement>(SK.ContinueStatement, {
	type: 'ContinueStatement',
	slots: { label: { tsField: 'label' } },
});
defineShape<ts.NewExpression>(SK.NewExpression, {
	type: 'NewExpression',
	defaults: { typeParameters: undefined },
	slots: {
		callee: { tsField: 'expression' },
		arguments: { tsField: 'arguments', via: (args, parent) => convertChildren(args ?? [], parent) },
		typeArguments: { tsField: 'typeArguments', via: convertTypeArguments, whenAbsent: 'undefined' },
	},
});
defineShape<ts.TaggedTemplateExpression>(SK.TaggedTemplateExpression, {
	type: 'TaggedTemplateExpression',
	slots: {
		tag: { tsField: 'tag' },
		quasi: { tsField: 'template' },
		typeArguments: { tsField: 'typeArguments', via: convertTypeArguments, whenAbsent: 'undefined' },
	},
});
defineShape<ts.JsxAttribute>(SK.JsxAttribute, {
	type: 'JSXAttribute',
	slots: {
		name: { tsField: 'name', via: (n, parent) => convertJSXNamespaceOrIdentifier(n, parent) },
		value: { tsField: 'initializer' },
	},
});
defineShape<ts.JsxFragment>(SK.JsxFragment, {
	type: 'JSXFragment',
	slots: {
		openingFragment: { tsField: 'openingFragment' },
		closingFragment: { tsField: 'closingFragment' },
		children: { tsField: 'children', via: 'convertChildren' },
	},
});
defineShape<ts.JsxNamespacedName>(SK.JsxNamespacedName, {
	type: 'JSXNamespacedName',
	slots: {
		namespace: { tsField: 'namespace', via: (ns, parent) => new JSXIdentifierNode(ns, parent, (ns as ts.Identifier).text) },
		name: { tsField: 'name', via: (nm, parent) => new JSXIdentifierNode(nm, parent, (nm as ts.Identifier).text) },
	},
});
defineShape<ts.ImportSpecifier>(SK.ImportSpecifier, {
	type: 'ImportSpecifier',
	consts: tn => ({ importKind: tn.isTypeOnly ? 'type' : 'value' }),
	slots: {
		local: { tsField: 'name' },
		// `import { foo }` → imported and local both wrap the same TS
		// Identifier. `import { foo as bar }` → imported wraps propertyName,
		// local wraps name. convertChild's cache shares the instance when
		// they refer to the same TS node.
		imported: { tsField: 'name', via: (_v, parent) => {
			const ts_ = (parent as unknown as { _ts: ts.ImportSpecifier })._ts;
			return convertChild(ts_.propertyName ?? ts_.name, parent);
		} },
	},
});
defineShape<ts.ExportSpecifier>(SK.ExportSpecifier, {
	type: 'ExportSpecifier',
	consts: tn => ({ exportKind: tn.isTypeOnly ? 'type' : 'value' }),
	slots: {
		exported: { tsField: 'name' },
		local: { tsField: 'name', via: (_v, parent) => {
			const ts_ = (parent as unknown as { _ts: ts.ExportSpecifier })._ts;
			return convertChild(ts_.propertyName ?? ts_.name, parent);
		} },
	},
});
defineShape<ts.ShorthandPropertyAssignment>(SK.ShorthandPropertyAssignment, {
	type: 'Property',
	defaults: { kind: 'init', method: false, optional: false, shorthand: true, computed: false },
	slots: {
		key: { tsField: 'name' },
	},
	// Eager: `value` aliases `key` for shorthand properties.
	init: (instance) => {
		Object.defineProperty(instance, 'value', { get() { return this.key; }, configurable: true });
	},
});
defineShape<ts.NamedTupleMember>(SK.NamedTupleMember, {
	type: 'TSNamedTupleMember',
	consts: tn => ({ optional: tn.questionToken != null }),
	slots: {
		label: { tsField: 'name' },
		elementType: { tsField: 'type' },
	},
});
defineShape<ts.RegularExpressionLiteral>(SK.RegularExpressionLiteral, {
	type: 'Literal',
	slots: {},
	consts: tn => {
		const m = /^\/(.+)\/([gimsuy]*)$/.exec(tn.text);
		const pattern = m?.[1] ?? '';
		const flags = m?.[2] ?? '';
		return { raw: tn.text, regex: { pattern, flags } };
	},
	init: (instance, tn) => {
		// `value` is a getter — `new RegExp(pattern, flags)` is paid only when
		// the rule actually evaluates the regex (rare; most read .regex.*).
		let computed = false;
		let cached: RegExp | null = null;
		Object.defineProperty(instance, 'value', {
			get() {
				if (computed) return cached;
				computed = true;
				try {
					cached = new RegExp((this as any).regex.pattern, (this as any).regex.flags);
				}
				catch {
					cached = null;
				}
				return cached;
			},
			configurable: true,
		});
		// Suppress unused-tsNode warning.
		void tn;
	},
});
defineShape<ts.PropertySignature>(SK.PropertySignature, {
	type: 'TSPropertySignature',
	defaults: { accessibility: undefined, static: false },
	consts: tn => ({
		computed: tn.name.kind === SK.ComputedPropertyName,
		optional: !!tn.questionToken,
		readonly: !!tn.modifiers?.some(m => m.kind === SK.ReadonlyKeyword),
	}),
	slots: {
		key: { tsField: 'name' },
		typeAnnotation: { tsField: 'type', via: convertTypeAnnotation, whenAbsent: 'undefined' },
	},
});
defineShape<ts.MethodSignature>(SK.MethodSignature, {
	type: 'TSMethodSignature',
	defaults: { accessibility: undefined, kind: 'method', static: false },
	consts: tn => ({
		computed: tn.name.kind === SK.ComputedPropertyName,
		optional: !!tn.questionToken,
		readonly: !!tn.modifiers?.some(m => m.kind === SK.ReadonlyKeyword),
	}),
	slots: {
		key: { tsField: 'name' },
		params: { tsField: 'parameters', via: 'convertChildren' },
		returnType: { tsField: 'type', via: convertTypeAnnotation, whenAbsent: 'undefined' },
		typeParameters: { tsField: 'typeParameters', via: convertTypeParameters, whenAbsent: 'undefined' },
	},
});
defineShape<ts.FunctionTypeNode>(SK.FunctionType, {
	type: 'TSFunctionType',
	slots: {
		params: { tsField: 'parameters', via: 'convertChildren' },
		returnType: { tsField: 'type', via: convertTypeAnnotation, whenAbsent: 'undefined' },
		typeParameters: { tsField: 'typeParameters', via: convertTypeParameters, whenAbsent: 'undefined' },
	},
});
defineShape<ts.ConstructorTypeNode>(SK.ConstructorType, {
	type: 'TSConstructorType',
	consts: tn => ({ abstract: !!tn.modifiers?.some(m => m.kind === SK.AbstractKeyword) }),
	slots: {
		params: { tsField: 'parameters', via: 'convertChildren' },
		returnType: { tsField: 'type', via: convertTypeAnnotation, whenAbsent: 'undefined' },
		typeParameters: { tsField: 'typeParameters', via: convertTypeParameters, whenAbsent: 'undefined' },
	},
});
defineShape<ts.CallSignatureDeclaration>(SK.CallSignature, {
	type: 'TSCallSignatureDeclaration',
	slots: {
		params: { tsField: 'parameters', via: 'convertChildren' },
		returnType: { tsField: 'type', via: convertTypeAnnotation, whenAbsent: 'undefined' },
		typeParameters: { tsField: 'typeParameters', via: convertTypeParameters, whenAbsent: 'undefined' },
	},
});
defineShape<ts.ConstructSignatureDeclaration>(SK.ConstructSignature, {
	type: 'TSConstructSignatureDeclaration',
	slots: {
		params: { tsField: 'parameters', via: 'convertChildren' },
		returnType: { tsField: 'type', via: convertTypeAnnotation, whenAbsent: 'undefined' },
		typeParameters: { tsField: 'typeParameters', via: convertTypeParameters, whenAbsent: 'undefined' },
	},
});
defineShape<ts.MappedTypeNode>(SK.MappedType, {
	type: 'TSMappedType',
	consts: tn => ({
		readonly: tn.readonlyToken
			? (tn.readonlyToken.kind === SK.PlusToken ? '+' : tn.readonlyToken.kind === SK.MinusToken ? '-' : true)
			: undefined,
		optional: tn.questionToken
			? (tn.questionToken.kind === SK.PlusToken ? '+' : tn.questionToken.kind === SK.MinusToken ? '-' : true)
			: false,
	}),
	slots: {
		key: { tsField: 'typeParameter', via: (tp, parent) => convertChild((tp as ts.TypeParameterDeclaration).name, parent) },
		constraint: { tsField: 'typeParameter', via: (tp, parent) => convertChild((tp as ts.TypeParameterDeclaration).constraint, parent) },
		nameType: { tsField: 'nameType', via: (n, parent) => convertChild(n, parent) ?? null },
		typeAnnotation: { tsField: 'type' },
	},
});
defineShape<ts.TypePredicateNode>(SK.TypePredicate, {
	type: 'TSTypePredicate',
	consts: tn => ({ asserts: tn.assertsModifier != null }),
	slots: {
		parameterName: { tsField: 'parameterName' },
		typeAnnotation: { tsField: 'type', via: (t, parent) => {
			const wrapper = convertTypeAnnotation(t, parent);
			// Eager line 1908 strips the colon-prefixed range — predicate's
			// typeAnnotation range matches the inner type, not the wrapper.
			const inner = wrapper.typeAnnotation as { range: [number, number] } | null;
			if (inner) {
				(wrapper as unknown as { range: [number, number] }).range = inner.range;
			}
			return wrapper;
		}, whenAbsent: 'null' },
	},
});

// Export forms — typescript-estree picks ExportNamedDeclaration vs
// ExportAllDeclaration vs ExportDefaultDeclaration vs TSExportAssignment
// based on the structure. Two underlying shapes for each TS kind, picked
// at dispatch time via defineShapeRouter.
const exportNamedShape = makeShapeClass<ts.ExportDeclaration>({
	type: 'ExportNamedDeclaration',
	defaults: { declaration: null, attributes: EMPTY_ARRAY, assertions: EMPTY_ARRAY },
	consts: tn => ({ exportKind: tn.isTypeOnly ? 'type' : 'value' }),
	slots: {
		source: { tsField: 'moduleSpecifier' },
		specifiers: { tsField: 'exportClause', via: (cl, parent) =>
			cl && (cl as ts.NamedExports).kind === SK.NamedExports
				? convertChildren((cl as ts.NamedExports).elements, parent)
				: [] },
	},
});
const exportAllShape = makeShapeClass<ts.ExportDeclaration>({
	type: 'ExportAllDeclaration',
	defaults: { attributes: EMPTY_ARRAY, assertions: EMPTY_ARRAY },
	consts: tn => ({ exportKind: tn.isTypeOnly ? 'type' : 'value' }),
	slots: {
		exported: { tsField: 'exportClause', via: (cl, parent) =>
			cl && (cl as ts.NamespaceExport).kind === SK.NamespaceExport
				? convertChild((cl as ts.NamespaceExport).name, parent)
				: null },
		source: { tsField: 'moduleSpecifier' },
	},
});
defineShapeRouter(SK.ExportDeclaration, (tsNode, parent) => {
	const ed = tsNode as ts.ExportDeclaration;
	const Cls = ed.exportClause?.kind === SK.NamedExports ? exportNamedShape : exportAllShape;
	return new Cls(tsNode, parent);
});
const exportDefaultDeclShape = makeShapeClass<ts.ExportAssignment>({
	type: 'ExportDefaultDeclaration',
	defaults: { exportKind: 'value' },
	slots: {
		declaration: { tsField: 'expression' },
	},
});
const tsExportAssignmentShape = makeShapeClass<ts.ExportAssignment>({
	type: 'TSExportAssignment',
	slots: {
		expression: { tsField: 'expression' },
	},
});
defineShapeRouter(SK.ExportAssignment, (tsNode, parent) => {
	const ea = tsNode as ts.ExportAssignment;
	return new (ea.isExportEquals ? tsExportAssignmentShape : exportDefaultDeclShape)(tsNode, parent);
});

// --- Round 3 migrations -----------------------------------------------
defineShape<ts.TypeOperatorNode>(SK.TypeOperator, {
	type: 'TSTypeOperator',
	consts: tn => ({
		operator: tn.operator === SK.KeyOfKeyword ? 'keyof'
			: tn.operator === SK.UniqueKeyword ? 'unique'
			: 'readonly',
	}),
	slots: { typeAnnotation: { tsField: 'type' } },
});
defineShape<ts.ArrayBindingPattern>(SK.ArrayBindingPattern, {
	type: 'ArrayPattern',
	defaults: { decorators: EMPTY_ARRAY, optional: false, typeAnnotation: undefined },
	slots: {
		elements: { tsField: 'elements', via: (els, parent) =>
			els.map((e: ts.ArrayBindingElement) => e.kind === SK.OmittedExpression ? null : convertChild(e, parent)) },
	},
});
defineShape<ts.VariableDeclarationList>(SK.VariableDeclarationList, {
	type: 'VariableDeclaration',
	defaults: { declare: false },
	consts: tn => {
		const flags = tn.flags;
		const kind = (flags & ts.NodeFlags.AwaitUsing) === ts.NodeFlags.AwaitUsing
			? 'await using'
			: (flags & ts.NodeFlags.Using) === ts.NodeFlags.Using
			? 'using'
			: flags & ts.NodeFlags.Const
			? 'const'
			: flags & ts.NodeFlags.Let
			? 'let'
			: 'var';
		return { kind };
	},
	slots: {
		declarations: { tsField: 'declarations', via: 'convertChildren' },
	},
});
defineShape<ts.Block>(SK.Block, {
	type: 'BlockStatement',
	slots: {
		body: { tsField: 'statements', via: (statements, parent) => {
			const pk = (parent as unknown as { _ts: ts.Node })._ts.parent?.kind;
			const allowsDirectives = pk === SK.FunctionDeclaration
				|| pk === SK.FunctionExpression
				|| pk === SK.ArrowFunction
				|| pk === SK.MethodDeclaration
				|| pk === SK.Constructor
				|| pk === SK.GetAccessor
				|| pk === SK.SetAccessor;
			return allowsDirectives
				? convertBodyWithDirectives(statements, parent)
				: convertChildren(statements, parent);
		} },
	},
});
defineShape<ts.EnumDeclaration>(SK.EnumDeclaration, {
	type: 'TSEnumDeclaration',
	consts: tn => ({
		const: !!tn.modifiers?.some(m => m.kind === SK.ConstKeyword),
		declare: !!tn.modifiers?.some(m => m.kind === SK.DeclareKeyword),
	}),
	slots: {
		id: { tsField: 'name' },
		body: { tsField: 'members', via: (_members, parent) => {
			const tn = (parent as unknown as { _ts: ts.EnumDeclaration })._ts;
			return new TSEnumBodyNode(tn, parent, [tn.members.pos - 1, tn.end]);
		} },
		members: { tsField: 'members', via: 'convertChildren' },
	},
});
defineShape<ts.InterfaceDeclaration>(SK.InterfaceDeclaration, {
	type: 'TSInterfaceDeclaration',
	consts: tn => ({
		declare: !!tn.modifiers?.some(m => m.kind === SK.DeclareKeyword),
	}),
	slots: {
		id: { tsField: 'name' },
		// `tsField: 'name'` is always present so the via callback always
		// runs, even when there are no heritageClauses. The factory's
		// null-short-circuit would skip a heritageClauses-keyed slot
		// when the field is absent (yielding null instead of [], which
		// breaks parity).
		extends: { tsField: 'name', via: (_n, parent) => {
			const tn = (parent as unknown as { _ts: ts.InterfaceDeclaration })._ts;
			const clauses = tn.heritageClauses;
			if (!clauses) return [];
			return clauses
				.filter(h => h.token === SK.ExtendsKeyword)
				.flatMap(h => h.types.map(t => convertChild(t, parent)));
		} },
		typeParameters: { tsField: 'typeParameters', via: convertTypeParameters, whenAbsent: 'undefined' },
		body: { tsField: 'name', via: (_n, parent) => {
			const tn = (parent as unknown as { _ts: ts.InterfaceDeclaration })._ts;
			return new TSInterfaceBodyNode(tn, parent, [tn.members.pos - 1, tn.end]);
		} },
	},
});
defineShape<ts.NoSubstitutionTemplateLiteral>(SK.NoSubstitutionTemplateLiteral, {
	type: 'TemplateLiteral',
	defaults: { expressions: EMPTY_ARRAY },
	slots: {},
	init: (instance, tn) => {
		// `quasis` is a single TemplateElement spanning the whole literal.
		// Lazy: build on first access (rules typically read .type / .expressions
		// rather than the synthesized quasi).
		let cached: object[] | undefined;
		Object.defineProperty(instance, 'quasis', {
			get() {
				if (cached) return cached;
				const ast = (this as { _ctx: ConvertContext })._ctx.ast;
				return cached = [{
					type: 'TemplateElement',
					tail: true,
					range: this.range,
					loc: this.loc,
					value: { cooked: tn.text, raw: tn.getText(ast).slice(1, -1) },
				}];
			},
			configurable: true,
		});
	},
});
// --- Round 4 migrations -----------------------------------------------
defineShape<ts.NumericLiteral>(SK.NumericLiteral, {
	type: 'Literal',
	consts: tn => ({ value: Number(tn.text) }),
	slots: {},
	init: (instance) => {
		// `raw` lazily reads getText (scanner trivia walk) — most rules
		// only read .value/.type, so defer.
		let cached: string | undefined;
		Object.defineProperty(instance, 'raw', {
			get(this: { _ts: ts.LiteralExpression; _ctx: ConvertContext }) {
				return cached ??= this._ts.getText(this._ctx.ast);
			},
			configurable: true,
		});
	},
});
defineShape<ts.StringLiteral>(SK.StringLiteral, {
	type: 'Literal',
	consts: (tn, instance) => {
		// JSX attribute string values get HTML entity decoding (eager
		// runs `unescapeStringLiteralText`); other contexts use the raw
		// text. Parent's _ts is set in super() before consts runs, so
		// the kind check is reliable.
		const parentKind = (instance.parent as { _ts: ts.Node } | null)?._ts.kind;
		const value = parentKind === SK.JsxAttribute
			? unescapeJsxText(tn.text)
			: tn.text;
		return { value };
	},
	slots: {},
	init: (instance) => {
		let cached: string | undefined;
		Object.defineProperty(instance, 'raw', {
			get(this: { _ts: ts.LiteralExpression; _ctx: ConvertContext }) {
				return cached ??= this._ts.getText(this._ctx.ast);
			},
			configurable: true,
		});
	},
});
defineShape<ts.TrueLiteral>(SK.TrueKeyword, {
	type: 'Literal',
	slots: {},
	defaults: { value: true, raw: 'true' },
});
defineShape<ts.FalseLiteral>(SK.FalseKeyword, {
	type: 'Literal',
	slots: {},
	defaults: { value: false, raw: 'false' },
});

// Pattern-context dispatch — TS doesn't tag literal/spread/object as
// pattern; eager carries an `allowPattern` boolean while traversing
// destructuring positions. Routers consult the module-level state.
const arrayExpressionShape = makeShapeClass<ts.ArrayLiteralExpression>({
	type: 'ArrayExpression',
	slots: {
		elements: { tsField: 'elements', via: (els, parent) =>
			els.map((e: ts.Expression) => e.kind === SK.OmittedExpression ? null : convertChild(e, parent)) },
	},
});
const arrayPatternFromLiteralShape = makeShapeClass<ts.ArrayLiteralExpression>({
	type: 'ArrayPattern',
	defaults: { decorators: EMPTY_ARRAY, optional: false, typeAnnotation: undefined },
	slots: {
		elements: { tsField: 'elements', via: (els, parent) =>
			els.map((e: ts.Expression) => e.kind === SK.OmittedExpression ? null : convertChildAsPattern(e, parent)) },
	},
});
defineShapeRouter(SK.ArrayLiteralExpression, (tsNode, parent) =>
	new (allowPattern ? arrayPatternFromLiteralShape : arrayExpressionShape)(tsNode, parent));

const objectExpressionShape = makeShapeClass<ts.ObjectLiteralExpression>({
	type: 'ObjectExpression',
	slots: { properties: { tsField: 'properties', via: 'convertChildren' } },
});
const objectPatternFromLiteralShape = makeShapeClass<ts.ObjectLiteralExpression>({
	type: 'ObjectPattern',
	defaults: { decorators: EMPTY_ARRAY, optional: false, typeAnnotation: undefined },
	slots: {
		properties: { tsField: 'properties', via: (props, parent) =>
			props.map((p: ts.ObjectLiteralElementLike) => convertChildAsPattern(p, parent)) },
	},
});
defineShapeRouter(SK.ObjectLiteralExpression, (tsNode, parent) =>
	new (allowPattern ? objectPatternFromLiteralShape : objectExpressionShape)(tsNode, parent));

const spreadElementShape = makeShapeClass<ts.SpreadElement | ts.SpreadAssignment>({
	type: 'SpreadElement',
	slots: { argument: { tsField: 'expression' } },
});
const restElementFromSpreadShape = makeShapeClass<ts.SpreadElement | ts.SpreadAssignment>({
	type: 'RestElement',
	defaults: { decorators: EMPTY_ARRAY, optional: false, value: undefined, typeAnnotation: undefined },
	slots: { argument: { tsField: 'expression', via: 'convertChildAsPattern' } },
});
defineShapeRouter(SK.SpreadElement, (tsNode, parent) =>
	new (allowPattern ? restElementFromSpreadShape : spreadElementShape)(tsNode, parent));
defineShapeRouter(SK.SpreadAssignment, (tsNode, parent) =>
	new (allowPattern ? restElementFromSpreadShape : spreadElementShape)(tsNode, parent));

// `[name: T]` becomes TSNamedTupleMember; `[...name: T]` wraps in TSRestType.
const tsNamedTupleMemberShape = makeShapeClass<ts.NamedTupleMember>({
	type: 'TSNamedTupleMember',
	consts: tn => ({ optional: tn.questionToken != null }),
	slots: {
		label: { tsField: 'name' },
		elementType: { tsField: 'type' },
	},
});
const tsRestNamedTupleShape = makeShapeClass<ts.NamedTupleMember>({
	type: 'TSRestType',
	slots: {
		// Build the inner TSNamedTupleMember + strip the leading `...` from
		// its range (eager line 2173).
		typeAnnotation: { tsField: 'name', via: (_n, parent) => {
			const tn = (parent as unknown as { _ts: ts.NamedTupleMember })._ts;
			const inner = new tsNamedTupleMemberShape(tn, parent) as unknown as { range: [number, number]; label: { range: [number, number] } | null };
			if (inner.label) {
				inner.range = [inner.label.range[0], inner.range[1]];
			}
			return inner as unknown as LazyNode;
		} },
	},
});
defineShapeRouter(SK.NamedTupleMember, (tsNode, parent) =>
	new ((tsNode as ts.NamedTupleMember).dotDotDotToken ? tsRestNamedTupleShape : tsNamedTupleMemberShape)(tsNode, parent));

// --- Round 5 migrations -----------------------------------------------
defineShape<ts.Identifier>(SK.Identifier, {
	type: 'Identifier',
	defaults: { decorators: EMPTY_ARRAY, optional: false, typeAnnotation: undefined },
	consts: tn => ({ name: tn.text }),
	slots: {},
});
defineShape<ts.VariableStatement>(SK.VariableStatement, {
	type: 'VariableDeclaration',
	consts: tn => {
		const flags = tn.declarationList.flags;
		const kind = (flags & ts.NodeFlags.AwaitUsing) === ts.NodeFlags.AwaitUsing
			? 'await using'
			: (flags & ts.NodeFlags.Using) === ts.NodeFlags.Using
			? 'using'
			: flags & ts.NodeFlags.Const
			? 'const'
			: flags & ts.NodeFlags.Let
			? 'let'
			: 'var';
		return {
			kind,
			declare: !!tn.modifiers?.some(m => m.kind === SK.DeclareKeyword),
		};
	},
	slots: {
		declarations: { tsField: 'declarationList', via: (list, parent) =>
			convertChildren((list as ts.VariableDeclarationList).declarations, parent) },
	},
});
defineShape<ts.VariableDeclaration>(SK.VariableDeclaration, {
	type: 'VariableDeclarator',
	consts: tn => ({ definite: !!tn.exclamationToken }),
	slots: {
		// `id` carries the typeAnnotation. Build the inner Identifier (or
		// destructuring pattern) and, if there's a TS `.type`, attach the
		// TSTypeAnnotation wrapper + extend its range to cover the
		// annotation (eager line 2155 / fixParentLocation).
		id: { tsField: 'name', via: (name, parent) => {
			const idNode = convertChild(name, parent);
			const tn = (parent as unknown as { _ts: ts.VariableDeclaration })._ts;
			if (idNode && tn.type) {
				const annotation = convertTypeAnnotation(tn.type, idNode);
				(idNode as { typeAnnotation?: LazyNode | null }).typeAnnotation = annotation;
				(idNode as unknown as { _extendRange: (r: [number, number]) => void })._extendRange(annotation.range);
			}
			return idNode;
		} },
		init: { tsField: 'initializer' },
	},
});
defineShape<ts.PrefixUnaryExpression>(SK.PrefixUnaryExpression, {
	type: tn => unaryOperatorOf(tn.operator) === '++' || unaryOperatorOf(tn.operator) === '--'
		? 'UpdateExpression'
		: 'UnaryExpression',
	defaults: { prefix: true },
	consts: tn => ({ operator: unaryOperatorOf(tn.operator) }),
	slots: { argument: { tsField: 'operand' } },
});
defineShape<ts.PostfixUnaryExpression>(SK.PostfixUnaryExpression, {
	type: tn => unaryOperatorOf(tn.operator) === '++' || unaryOperatorOf(tn.operator) === '--'
		? 'UpdateExpression'
		: 'UnaryExpression',
	defaults: { prefix: false },
	consts: tn => ({ operator: unaryOperatorOf(tn.operator) }),
	slots: { argument: { tsField: 'operand' } },
});

// `null` literal in type position — eager exposes a bare TSNullKeyword
// (no TSLiteralType wrapper). Other LiteralType cases keep the wrapper.
const tsLiteralTypeShape = makeShapeClass<ts.LiteralTypeNode>({
	type: 'TSLiteralType',
	slots: { literal: { tsField: 'literal' } },
});
defineShapeRouter(SK.LiteralType, (tsNode, parent) => {
	const lit = tsNode as ts.LiteralTypeNode;
	if (lit.literal.kind === SK.NullKeyword) {
		const node = new TypeKeywordNode('TSNullKeyword', lit.literal, parent!);
		// Eager registers BOTH the inner NullKeyword AND the outer
		// LiteralType under the same ESTree node — without the outer
		// entry, Parameter.type's wrapper-route post-check throws on
		// `function f(x: null = null)`.
		parent!._ctx.maps.tsNodeToESTreeNodeMap.set(tsNode, node);
		return node;
	}
	return new tsLiteralTypeShape(tsNode, parent);
});

// `typeof import('x')` — wraps a TSImportType in a synthetic
// TSTypeQuery (the wrapping class re-points the cache to itself).
const tsImportTypeShape = makeShapeClass<ts.ImportTypeNode>({
	type: 'TSImportType',
	defaults: { options: null },
	range: (tn, ctx) => {
		// Eager strips the leading `typeof ` from the range when isTypeOf;
		// otherwise default getStart/getEnd. The generic LazyNode range
		// would include `typeof ` for the latter case.
		if (!tn.isTypeOf) return [tn.getStart(ctx.ast), tn.end];
		const start = tn.getStart(ctx.ast);
		const text = ctx.ast.text;
		let cursor = start + 'typeof'.length;
		while (cursor < text.length && /\s/.test(text[cursor])) cursor++;
		return [cursor, tn.end];
	},
	slots: {
		// `argument` and `source` both expose the inner StringLiteral
		// directly (eager flattens the LiteralType wrapper around it).
		// Store under one key to share the instance.
		argument: { tsField: 'argument', via: (arg, parent) => {
			if (arg.kind === SK.LiteralType) {
				return convertChild((arg as ts.LiteralTypeNode).literal, parent);
			}
			return convertChild(arg, parent);
		} },
		qualifier: { tsField: 'qualifier' },
		typeArguments: { tsField: 'typeArguments', via: (args, parent) =>
			convertTypeArguments(args, parent) ?? null, whenAbsent: 'null' },
	},
	init: (instance) => {
		Object.defineProperty(instance, 'source', {
			get(this: { argument: LazyNode | null }) { return this.argument; },
			configurable: true,
		});
	},
});
defineShapeRouter(SK.ImportType, (tsNode, parent) => {
	const it = tsNode as ts.ImportTypeNode;
	const inner = new tsImportTypeShape(it, parent);
	if (it.isTypeOf) return new TSTypeQueryWrappingNode(it, parent!, inner);
	return inner;
});

defineShape<ts.MetaProperty>(SK.MetaProperty, {
	type: 'MetaProperty',
	slots: { property: { tsField: 'name' } },
	init: (instance, tn) => {
		// `meta` is a synthesized Identifier for the keyword (`new` /
		// `import`) — TS only stores the keyword token. Plain object
		// (eager does the same) with parent re-pointed.
		const ctx = (instance as { _ctx: ConvertContext })._ctx;
		const keywordStart = tn.getStart(ctx.ast);
		const keywordEnd = keywordStart + (tn.keywordToken === SK.NewKeyword ? 3 : 6);
		const range: [number, number] = [keywordStart, keywordEnd];
		(instance as { meta: object }).meta = {
			type: 'Identifier',
			name: tn.keywordToken === SK.NewKeyword ? 'new' : 'import',
			decorators: [],
			optional: false,
			range,
			loc: getLocFor(ctx.ast, range[0], range[1]),
			parent: instance,
		};
	},
});

// Unary operator → string mapping (shared between PrefixUnary and
// PostfixUnary defineShape entries above).
function unaryOperatorOf(tokenKind: ts.SyntaxKind): string {
	return tokenKind === SK.PlusPlusToken ? '++'
		: tokenKind === SK.MinusMinusToken ? '--'
		: tokenKind === SK.PlusToken ? '+'
		: tokenKind === SK.MinusToken ? '-'
		: tokenKind === SK.ExclamationToken ? '!'
		: tokenKind === SK.TildeToken ? '~'
		: '?';
}

// --- Round 6 migrations -----------------------------------------------
// `${expr}` template parts produce TemplateElement plain objects (no
// children getters; eager does the same). Shared between TemplateLiteral
// and TSTemplateLiteralType.
function buildTemplateQuasis(
	head: ts.TemplateHead,
	templateSpans: ReadonlyArray<{ literal: ts.TemplateMiddle | ts.TemplateTail }>,
	ast: ts.SourceFile,
): object[] {
	const out: object[] = [];
	const headRange: [number, number] = [head.getStart(ast), head.getEnd()];
	out.push({
		type: 'TemplateElement',
		tail: false,
		range: headRange,
		loc: getLocFor(ast, headRange[0], headRange[1]),
		value: { cooked: head.text, raw: head.getText(ast).slice(1, -2) },
	});
	for (const span of templateSpans) {
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
	return out;
}
defineShape<ts.TemplateExpression>(SK.TemplateExpression, {
	type: 'TemplateLiteral',
	slots: {
		expressions: { tsField: 'templateSpans', via: (spans, parent) =>
			(spans as ts.NodeArray<ts.TemplateSpan>).map(s => convertChild(s.expression, parent)) },
	},
	init: (instance) => {
		let cached: object[] | undefined;
		Object.defineProperty(instance, 'quasis', {
			get(this: { _ts: ts.TemplateExpression; _ctx: ConvertContext }) {
				return cached ??= buildTemplateQuasis(this._ts.head, this._ts.templateSpans, this._ctx.ast);
			},
			configurable: true,
		});
	},
});
defineShape<ts.TemplateLiteralTypeNode>(SK.TemplateLiteralType, {
	type: 'TSTemplateLiteralType',
	slots: {
		types: { tsField: 'templateSpans', via: (spans, parent) =>
			(spans as ts.NodeArray<ts.TemplateLiteralTypeSpan>).map(s => convertChild(s.type, parent)) },
	},
	init: (instance) => {
		let cached: object[] | undefined;
		Object.defineProperty(instance, 'quasis', {
			get(this: { _ts: ts.TemplateLiteralTypeNode; _ctx: ConvertContext }) {
				return cached ??= buildTemplateQuasis(this._ts.head, this._ts.templateSpans, this._ctx.ast);
			},
			configurable: true,
		});
	},
});

// `import('x')` call → ImportExpression vs CallExpression. CallExpression
// also runs through wrapChainIfNeeded for optional-chain links.
const importExpressionShape = makeShapeClass<ts.CallExpression>({
	type: 'ImportExpression',
	defaults: { attributes: EMPTY_ARRAY },
	slots: {
		source: { tsField: 'arguments', via: (args, parent) =>
			convertChild((args as ts.NodeArray<ts.Expression>)[0], parent) },
		options: { tsField: 'arguments', via: (args, parent) =>
			convertChild((args as ts.NodeArray<ts.Expression>)[1], parent) },
	},
});
const callExpressionShape = makeShapeClass<ts.CallExpression>({
	type: 'CallExpression',
	defaults: { typeParameters: undefined },
	consts: tn => ({ optional: !!tn.questionDotToken }),
	slots: {
		callee: { tsField: 'expression' },
		arguments: { tsField: 'arguments', via: 'convertChildren' },
		typeArguments: { tsField: 'typeArguments', via: convertTypeArguments, whenAbsent: 'undefined' },
	},
});
defineShapeRouter(SK.CallExpression, (tsNode, parent) => {
	const ce = tsNode as ts.CallExpression;
	if (ce.expression.kind === SK.ImportKeyword) {
		return new importExpressionShape(ce, parent);
	}
	return wrapChainIfNeeded(new callExpressionShape(ce, parent), ce, parent!);
});

// MemberExpression — both PropertyAccess and ElementAccess flow through
// the same shape; chain wrapping lives in wrapChainIfNeeded.
const memberExpressionShape = makeShapeClass<ts.PropertyAccessExpression | ts.ElementAccessExpression>({
	type: 'MemberExpression',
	consts: tn => ({
		computed: tn.kind === SK.ElementAccessExpression,
		optional: !!tn.questionDotToken,
	}),
	slots: {
		object: { tsField: 'expression' },
		property: { tsField: 'expression', via: (_e, parent) => {
			const tn = (parent as unknown as { _ts: ts.PropertyAccessExpression | ts.ElementAccessExpression })._ts;
			if (tn.kind === SK.ElementAccessExpression) {
				return convertChild((tn as ts.ElementAccessExpression).argumentExpression, parent);
			}
			return convertChild((tn as ts.PropertyAccessExpression).name, parent);
		} },
	},
});
defineShapeRouter(SK.PropertyAccessExpression, (tsNode, parent) =>
	wrapChainIfNeeded(new memberExpressionShape(tsNode, parent), tsNode as ts.PropertyAccessExpression, parent!));
defineShapeRouter(SK.ElementAccessExpression, (tsNode, parent) =>
	wrapChainIfNeeded(new memberExpressionShape(tsNode, parent), tsNode as ts.ElementAccessExpression, parent!));

// Binary operator dispatch — comma → SequenceExpression, others →
// BinaryExpression / LogicalExpression / AssignmentExpression.
const sequenceExpressionShape = makeShapeClass<ts.BinaryExpression>({
	type: 'SequenceExpression',
	slots: {
		expressions: { tsField: 'left', via: (_l, parent) => {
			const be = (parent as unknown as { _ts: ts.BinaryExpression })._ts;
			const out: (LazyNode | null)[] = [];
			const left = convertChild(be.left, parent);
			// Flatten only when the user didn't parenthesize the left; eager
			// preserves user grouping by treating ParenthesizedExpression on
			// the left as a single nested SequenceExpression entry.
			if (
				left
				&& left.type === 'SequenceExpression'
				&& be.left.kind !== SK.ParenthesizedExpression
			) {
				for (const e of (left as unknown as { expressions: (LazyNode | null)[] }).expressions) {
					out.push(e);
				}
			}
			else {
				out.push(left);
			}
			out.push(convertChild(be.right, parent));
			return out;
		} },
	},
});
const binaryLikeShape = makeShapeClass<ts.BinaryExpression>({
	type: tn => {
		const k = tn.operatorToken.kind;
		if (LOGICAL_OP_KINDS.has(k)) return 'LogicalExpression';
		if (ASSIGN_OP_KINDS.has(k)) return 'AssignmentExpression';
		return 'BinaryExpression';
	},
	consts: tn => ({ operator: ts.tokenToString(tn.operatorToken.kind)! }),
	slots: {
		left: { tsField: 'left', via: (left, parent) => {
			const be = (parent as unknown as { _ts: ts.BinaryExpression; type: string })._ts;
			// Assignment-style: LHS in pattern position.
			if (ASSIGN_OP_KINDS.has(be.operatorToken.kind)) {
				return convertChildAsPattern(left, parent);
			}
			return convertChild(left, parent);
		} },
		right: { tsField: 'right' },
	},
});
defineShapeRouter(SK.BinaryExpression, (tsNode, parent) => {
	const be = tsNode as ts.BinaryExpression;
	if (be.operatorToken.kind === SK.CommaToken) {
		return new sequenceExpressionShape(be, parent);
	}
	return new binaryLikeShape(be, parent);
});

defineShape<ts.JsxText>(SK.JsxText, {
	type: 'JSXText',
	range: tn => [tn.getFullStart(), tn.getEnd()],
	consts: (tn, instance) => {
		const ast = (instance as { _ctx: ConvertContext })._ctx.ast;
		const start = tn.getFullStart();
		const end = tn.getEnd();
		const text = ast.text.slice(start, end);
		return { raw: text, value: unescapeJsxText(text) };
	},
	slots: {},
});

// JsxExpression: `{...x}` → JSXSpreadChild, `{x}` or `{}` → JSXExpressionContainer.
const jsxExpressionContainerShape = makeShapeClass<ts.JsxExpression>({
	type: 'JSXExpressionContainer',
	slots: {
		expression: { tsField: 'expression', via: (_expr, parent) => {
			const tn = (parent as unknown as { _ts: ts.JsxExpression })._ts;
			if (tn.expression) {
				return convertChild(tn.expression, parent);
			}
			return new JSXEmptyExpressionNode(tn, parent);
		}, whenAbsent: 'null' },
	},
	// Force expression evaluation at access time even when TS .expression
	// is undefined — the via callback synthesizes JSXEmptyExpression.
	init: (instance, tn) => {
		if (!tn.expression) {
			// Override the slot getter to build the synthetic empty
			// (the slot's tsValue == null short-circuit would otherwise
			// return null/absent before via runs).
			let cached: LazyNode | undefined;
			Object.defineProperty(instance, 'expression', {
				get() {
					return cached ??= new JSXEmptyExpressionNode(tn, instance);
				},
				configurable: true,
			});
		}
	},
});
const jsxSpreadChildShape = makeShapeClass<ts.JsxExpression>({
	type: 'JSXSpreadChild',
	slots: { expression: { tsField: 'expression' } },
});
defineShapeRouter(SK.JsxExpression, (tsNode, parent) => {
	const je = tsNode as ts.JsxExpression;
	return new (je.dotDotDotToken ? jsxSpreadChildShape : jsxExpressionContainerShape)(je, parent);
});

// --- Round 7 migrations -----------------------------------------------
defineShape<ts.ImportClause>(SK.ImportClause, {
	type: 'ImportDefaultSpecifier',
	range: (tn, ctx) => {
		// Eager narrows the range to the local name's range.
		if (tn.name) return [tn.name.getStart(ctx.ast), tn.name.getEnd()];
		return [tn.getStart(ctx.ast), tn.end];
	},
	slots: { local: { tsField: 'name' } },
});

// Function-likes — mechanical except for the type discriminator on
// FunctionDeclaration (FunctionDeclaration vs TSDeclareFunction when
// body is absent) and the `expression` flag on ArrowFunction (`() => x`
// vs `() => { x }`).
defineShape<ts.FunctionDeclaration>(SK.FunctionDeclaration, {
	type: tn => tn.body ? 'FunctionDeclaration' : 'TSDeclareFunction',
	defaults: { expression: false },
	consts: tn => ({
		async: !!tn.modifiers?.some(m => m.kind === SK.AsyncKeyword),
		declare: !!tn.modifiers?.some(m => m.kind === SK.DeclareKeyword),
		generator: !!tn.asteriskToken,
	}),
	slots: {
		id: { tsField: 'name' },
		typeParameters: { tsField: 'typeParameters', via: convertTypeParameters, whenAbsent: 'undefined' },
		params: { tsField: 'parameters', via: 'convertChildren' },
		body: { tsField: 'body', whenAbsent: 'undefined' },
		returnType: { tsField: 'type', via: convertTypeAnnotation, whenAbsent: 'undefined' },
	},
});
defineShape<ts.FunctionExpression>(SK.FunctionExpression, {
	type: 'FunctionExpression',
	defaults: { declare: false, expression: false },
	consts: tn => ({
		async: !!tn.modifiers?.some(m => m.kind === SK.AsyncKeyword),
		generator: !!tn.asteriskToken,
	}),
	slots: {
		id: { tsField: 'name' },
		typeParameters: { tsField: 'typeParameters', via: convertTypeParameters, whenAbsent: 'undefined' },
		params: { tsField: 'parameters', via: 'convertChildren' },
		body: { tsField: 'body' },
		returnType: { tsField: 'type', via: convertTypeAnnotation, whenAbsent: 'undefined' },
	},
});
defineShape<ts.ArrowFunction>(SK.ArrowFunction, {
	type: 'ArrowFunctionExpression',
	defaults: { generator: false, id: null },
	consts: tn => ({
		async: !!tn.modifiers?.some(m => m.kind === SK.AsyncKeyword),
		// `() => x` is expression-bodied; `() => { x }` is not.
		expression: tn.body.kind !== SK.Block,
	}),
	slots: {
		typeParameters: { tsField: 'typeParameters', via: convertTypeParameters, whenAbsent: 'undefined' },
		params: { tsField: 'parameters', via: 'convertChildren' },
		body: { tsField: 'body' },
		returnType: { tsField: 'type', via: convertTypeAnnotation, whenAbsent: 'undefined' },
	},
});

// Class declarations / expressions share a shape; type discriminator
// picks Declaration vs Expression at dispatch.
const classImplementsShape = makeShapeClass<ts.ExpressionWithTypeArguments>({
	type: 'TSClassImplements',
	slots: {
		expression: { tsField: 'expression' },
		typeArguments: { tsField: 'typeArguments', via: convertTypeArguments, whenAbsent: 'undefined' },
	},
});
const classShape = (type: 'ClassDeclaration' | 'ClassExpression') =>
	makeShapeClass<ts.ClassDeclaration | ts.ClassExpression>({
		type,
		defaults: { superTypeParameters: undefined },
		consts: tn => ({
			abstract: !!tn.modifiers?.some(m => m.kind === SK.AbstractKeyword),
			declare: !!tn.modifiers?.some(m => m.kind === SK.DeclareKeyword),
		}),
		// Use `members` (always defined as a NodeArray) for slots that
		// derive from heritageClauses / modifiers, so the factory's
		// null-short-circuit doesn't bypass the via callback when those
		// fields are absent.
		slots: {
			id: { tsField: 'name' },
			typeParameters: { tsField: 'typeParameters', via: convertTypeParameters, whenAbsent: 'undefined' },
			superClass: { tsField: 'members', via: (_m, parent) => {
				const tn = (parent as unknown as { _ts: ts.ClassDeclaration | ts.ClassExpression })._ts;
				const ext = tn.heritageClauses?.find(c => c.token === SK.ExtendsKeyword);
				return ext ? convertChild(ext.types[0]?.expression, parent) : null;
			} },
			superTypeArguments: { tsField: 'members', via: (_m, parent) => {
				const tn = (parent as unknown as { _ts: ts.ClassDeclaration | ts.ClassExpression })._ts;
				const ext = tn.heritageClauses?.find(c => c.token === SK.ExtendsKeyword);
				const args = ext?.types[0]?.typeArguments;
				return args ? convertTypeArguments(args, parent) : undefined;
			} },
			implements: { tsField: 'members', via: (_m, parent) => {
				const tn = (parent as unknown as { _ts: ts.ClassDeclaration | ts.ClassExpression })._ts;
				const impl = tn.heritageClauses?.find(c => c.token === SK.ImplementsKeyword);
				if (!impl) return [];
				return impl.types.map(t => new classImplementsShape(t, parent));
			} },
			decorators: { tsField: 'members', via: (_m, parent) =>
				convertDecorators((parent as unknown as { _ts: ts.Node })._ts, parent) },
			body: { tsField: 'members', via: (_m, parent) => {
				const tn = (parent as unknown as { _ts: ts.ClassDeclaration | ts.ClassExpression })._ts;
				return new ClassBodyNode(tn, parent, [tn.members.pos - 1, tn.end]);
			} },
		},
	});
const classDeclarationShape = classShape('ClassDeclaration');
const classExpressionShape = classShape('ClassExpression');
defineShapeRouter(SK.ClassDeclaration, (tsNode, parent) => new classDeclarationShape(tsNode, parent));
defineShapeRouter(SK.ClassExpression, (tsNode, parent) => new classExpressionShape(tsNode, parent));

defineShape<ts.ImportDeclaration>(SK.ImportDeclaration, {
	type: 'ImportDeclaration',
	consts: tn => ({ importKind: tn.importClause?.isTypeOnly ? 'type' : 'value' }),
	slots: {
		source: { tsField: 'moduleSpecifier' },
		// `tsField: 'moduleSpecifier'` always present so the via runs even
		// without an importClause; mirrors original ImportDeclarationNode's
		// flow.
		specifiers: { tsField: 'moduleSpecifier', via: (_v, parent) => {
			const tn = (parent as unknown as { _ts: ts.ImportDeclaration })._ts;
			const out: (LazyNode | null)[] = [];
			const clause = tn.importClause;
			if (!clause) return out;
			if (clause.name) {
				out.push(convertChild(clause, parent));
			}
			if (clause.namedBindings) {
				if (clause.namedBindings.kind === SK.NamespaceImport) {
					out.push(convertChild(clause.namedBindings, parent));
				}
				else if (clause.namedBindings.kind === SK.NamedImports) {
					for (const el of clause.namedBindings.elements) {
						out.push(convertChild(el, parent));
					}
				}
			}
			return out;
		} },
		attributes: { tsField: 'moduleSpecifier', via: (_v, parent) => {
			const tn = (parent as unknown as { _ts: ts.ImportDeclaration & {
				attributes?: { elements?: ReadonlyArray<ts.Node> };
				assertClause?: { elements?: ReadonlyArray<ts.Node> };
			} })._ts;
			const attrs = tn.attributes ?? tn.assertClause;
			return attrs?.elements ? convertChildren(attrs.elements, parent) : [];
		} },
	},
	// `assertions` is the deprecated alias for `attributes`. Define on
	// the prototype as a getter so it shares the cached value.
	init: (instance) => {
		Object.defineProperty(instance, 'assertions', {
			get() { return this.attributes; },
			configurable: true,
		});
	},
});

function convertChildInner(child: ts.Node, parent: LazyNode): LazyNode | null {
	const dispatch = SHAPE_CLASSES.get(child.kind);
	if (dispatch) {
		if ('route' in dispatch) {
			const result = dispatch.route(child, parent);
			if (result) return result;
		}
		else {
			return new dispatch.cls(child, parent);
		}
	}
	switch (child.kind) {
		case SK.SourceFile:
			return new ProgramNode(child as ts.SourceFile, parent);
		case SK.Parameter:
			return convertParameter(child as ts.ParameterDeclaration, parent);
		case SK.ParenthesizedType:
			return convertChild((child as ts.ParenthesizedTypeNode).type, parent);
		case SK.ParenthesizedExpression:
			return convertChild((child as ts.ParenthesizedExpression).expression, parent);
		case SK.ComputedPropertyName:
			return convertChild((child as ts.ComputedPropertyName).expression, parent);
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
		case SK.HeritageClause:
			return null; // handled inline by ClassNode
		case SK.JsxElement:
		case SK.JsxSelfClosingElement:
			return new JSXElementNode(child, parent);
		case SK.JsxOpeningElement:
			return new JSXOpeningElementNode(child as ts.JsxOpeningElement, parent);
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
	// Type is dynamic: 'TS' + ts.SyntaxKind[kind]. Most produced types
	// (e.g. 'TSEnumDeclaration', 'TSImportType') are valid KnownEstreeType
	// members; some are NOT (e.g. 'TSJsxAttributes', 'TSEndOfFileToken')
	// and represent the "synthetic fallback" for kinds that don't have
	// a real ESTree counterpart. The phantom-types invariant test in
	// lazy-estree.test asserts these never reach a position rules can
	// observe — they exist only as transient objects on the bottom-up
	// walk before being shadowed by a real subclass. Cast the field
	// type to KnownEstreeType to satisfy the LazyNode constraint; the
	// runtime invariant is the actual gate.
	readonly type: KnownEstreeType;
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
		this.type = ('TS' + ts.SyntaxKind[tsNode.kind]) as KnownEstreeType;
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
	result: LazyNode,
	tsNode: ts.PropertyAccessExpression | ts.ElementAccessExpression | ts.CallExpression,
	parent: LazyNode,
): LazyNode {
	const r = result as unknown as { type: string; object?: LazyNode; callee?: LazyNode; optional?: boolean };
	const isMember = r.type === 'MemberExpression';
	const child = isMember ? r.object : r.callee;
	const isOptional = !!r.optional;
	const isChildChain = (child as { type?: string } | null | undefined)?.type === 'ChainExpression'
		&& (tsNode as ts.PropertyAccessExpression).expression?.kind !== SK.ParenthesizedExpression;
	if (!isChildChain && !isOptional) return result;
	if (isChildChain) {
		// Unwrap: pull out child.expression, point us at it instead.
		const inner = (child as unknown as { expression: LazyNode }).expression;
		const tsChildField = isMember
			? (tsNode as ts.PropertyAccessExpression | ts.ElementAccessExpression).expression
			: (tsNode as ts.CallExpression).expression;
		parent._ctx.maps.tsNodeToESTreeNodeMap.set(tsChildField, inner);
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
class ChainExpressionWrappingNode extends SyntheticLazyNode {
	readonly type = 'ChainExpression' as const;
	readonly expression: LazyNode;
	constructor(tsNode: ts.Node, parent: LazyNode, expression: LazyNode) {
		super(tsNode, parent);
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

class TSTypeParameterDeclarationNode extends SyntheticLazyNode {
	readonly type = 'TSTypeParameterDeclaration' as const;
	private _params?: (LazyNode | null)[];
	private _typeParams: ts.NodeArray<ts.TypeParameterDeclaration>;
	constructor(typeParams: ts.NodeArray<ts.TypeParameterDeclaration>, parent: LazyNode) {
		const host = typeParams[0].parent;
		super(host, parent);
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

class TSTypeParameterInstantiationNode extends SyntheticLazyNode {
	readonly type = 'TSTypeParameterInstantiation' as const;
	private _params?: (LazyNode | null)[];
	private _typeArgs: ts.NodeArray<ts.TypeNode>;
	constructor(typeArgs: ts.NodeArray<ts.TypeNode>, parent: LazyNode) {
		const host = typeArgs[0].parent;
		super(host, parent);
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

class TSTypeAnnotationNode extends SyntheticLazyNode {
	readonly type = 'TSTypeAnnotation' as const;
	private _typeAnnotation?: LazyNode | null;

	constructor(tsTypeNode: ts.Node, parent: LazyNode, range: [number, number]) {
		super(tsTypeNode, parent);
		this.range = range;
	}

	get typeAnnotation() {
		return this._typeAnnotation ??= convertChild(this._ts, this);
	}
}

// Type-position keywords (`any`, `number`, `string`, …). All have the same
// shape — just `type: 'TSXxxKeyword'`. Group them under one class to avoid
// 13 near-identical declarations.
// Type-keyword union — narrowed from KnownEstreeType to the keyword
// subset so the constructor's `type` parameter can't accept a
// non-keyword name by mistake.
type TypeKeyword =
	| 'TSAnyKeyword'
	| 'TSBigIntKeyword'
	| 'TSBooleanKeyword'
	| 'TSIntrinsicKeyword'
	| 'TSNeverKeyword'
	| 'TSNullKeyword'
	| 'TSNumberKeyword'
	| 'TSObjectKeyword'
	| 'TSStringKeyword'
	| 'TSSymbolKeyword'
	| 'TSUndefinedKeyword'
	| 'TSUnknownKeyword'
	| 'TSVoidKeyword';
class TypeKeywordNode extends LazyNode {
	readonly type: TypeKeyword;
	constructor(type: TypeKeyword, tsNode: ts.Node, parent: LazyNode) {
		super(tsNode, parent);
		this.type = type;
	}
}

// Type-position nodes — direct 1:1 with typescript-estree's cases.

// LiteralType has a special case for `null`: TS 4.0+ wraps NullKeyword in
// a LiteralType node, but we expose the bare TSNullKeyword to match eager.
// `typeof import('x')` produces a TSTypeQuery whose exprName is a
// TSImportType. The wrapper takes the same TS node identity (matching
// eager line 1962).
class TSTypeQueryWrappingNode extends SyntheticLazyNode {
	readonly type = 'TSTypeQuery' as const;
	readonly typeArguments = undefined;
	readonly exprName: LazyNode;
	constructor(tsNode: ts.ImportTypeNode, parent: LazyNode, exprName: LazyNode) {
		super(tsNode, parent);
		// Re-point the TS node map to the outer wrapper.
		this._ctx.maps.tsNodeToESTreeNodeMap.set(tsNode, this);
		(exprName as { parent: LazyNode }).parent = this;
		this.exprName = exprName;
	}
}

// VariableDeclarationList appears in for-loop initializers (`for (let i = 0;...)`).
// typescript-estree converts it to a VariableDeclaration with no `declare`.
// Classes — typescript-estree assembles `body` from the class members
// filtered through `isESTreeClassMember`. MVP just passes them through;
// HeritageClause folded into superClass / implements via inline scan.

class ClassBodyNode extends SyntheticLazyNode {
	readonly type = 'ClassBody' as const;
	private _body?: (LazyNode | null)[];
	constructor(classTsNode: ts.ClassDeclaration | ts.ClassExpression, parent: LazyNode, range: [number, number]) {
		super(classTsNode, parent);
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
class MethodFunctionExpressionNode extends SyntheticLazyNode {
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
		super(tsNode, parent);
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
class ConstructorKeyIdentifierNode extends SyntheticLazyNode {
	readonly type = 'Identifier' as const;
	readonly name = 'constructor' as const;
	readonly decorators: never[] = EMPTY_ARRAY;
	readonly optional = false;
	readonly typeAnnotation = undefined;
	constructor(tsNode: ts.ConstructorDeclaration, parent: LazyNode) {
		super(tsNode, parent);
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

// Used when `[a = 1] = ...` and `{ b: c = 2 } = ...` — wraps the inner
// pattern with a default value. typescript-estree's range covers from
// the binding NAME (not the BindingElement's outer start, which would
// include the property key in the object case) through the initializer.
class BindingAssignmentPatternNode extends SyntheticLazyNode {
	readonly type = 'AssignmentPattern' as const;
	readonly decorators: never[] = EMPTY_ARRAY;
	readonly optional = false;
	readonly typeAnnotation = undefined;
	readonly left: LazyNode;
	private _right?: LazyNode | null;
	constructor(tsNode: ts.BindingElement, parent: LazyNode, left: LazyNode) {
		super(tsNode, parent);
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
class TSEnumBodyNode extends SyntheticLazyNode {
	readonly type = 'TSEnumBody' as const;
	private _members?: (LazyNode | null)[];
	constructor(enumTsNode: ts.EnumDeclaration, parent: LazyNode, range: [number, number]) {
		super(enumTsNode, parent);
		this.range = range;
	}
	get members() {
		return this._members ??= convertChildren((this._ts as ts.EnumDeclaration).members, this);
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
// NamedTupleMember: with `...` becomes TSRestType wrapping the member.
// Template literal types (`` `hello ${T}` `` in type position). Like
// TemplateLiteralNode but the spans interleave with TYPE nodes (not
// expressions). typescript-estree shape:
//   { type: 'TSTemplateLiteralType', quasis: TemplateElement[], types: TypeNode[] }
// `` tag`hello ${x}` `` — function call with template literal as argument.
// typescript-estree shape: { type: 'TaggedTemplateExpression', tag, quasi,
// typeArguments? }. quasi is the TemplateLiteral itself (re-using the
// existing TemplateLiteralNode / NoSubstitutionTemplateNode classes).
// NoSubstitutionTemplateLiteral: backtick string with no `${}`. Maps to a
// TemplateLiteral with a single quasi.
// Prefix/postfix unary expressions: ++/-- become UpdateExpression, others
// become UnaryExpression (matches typescript-estree's split at line 2188).
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
class ExportNamedWrappingNode extends SyntheticLazyNode {
	readonly type = 'ExportNamedDeclaration' as const;
	readonly attributes: never[] = EMPTY_ARRAY;
	readonly assertions: never[] = EMPTY_ARRAY;
	readonly source = null;
	readonly specifiers: never[] = EMPTY_ARRAY;
	readonly exportKind: 'value' | 'type';
	readonly declaration: LazyNode;
	constructor(tsNode: ts.Node, parent: LazyNode, declaration: LazyNode, range: [number, number]) {
		super(tsNode, parent);
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

class ExportDefaultWrappingNode extends SyntheticLazyNode {
	readonly type = 'ExportDefaultDeclaration' as const;
	readonly exportKind: 'value' = 'value';
	readonly declaration: LazyNode;
	constructor(tsNode: ts.Node, parent: LazyNode, declaration: LazyNode, range: [number, number]) {
		super(tsNode, parent);
		this.range = range;
		(declaration as { parent: LazyNode }).parent = this;
		this._ctx.maps.tsNodeToESTreeNodeMap.set(tsNode, this);
		this.declaration = declaration;
	}
}

// CallSignature + ConstructSignature share a shape — params + returnType +
// typeParameters. typescript-estree picks the type literal at construction.
// Interface — `body` is wrapped in a synthetic TSInterfaceBody whose range
// starts one char before the first member (the `{`). MVP skips
// heritageClauses + typeParameters (the `extends` and generics array).
class TSInterfaceBodyNode extends SyntheticLazyNode {
	readonly type = 'TSInterfaceBody' as const;
	private _body?: (LazyNode | null)[];

	constructor(interfaceTsNode: ts.InterfaceDeclaration, parent: LazyNode, range: [number, number]) {
		// Synthetic — body is the same `{` block as the interface, no
		// independent TS node, so don't pollute the maps.
		super(interfaceTsNode, parent);
		this.range = range;
	}
	get body() {
		return this._body ??= convertChildren((this._ts as ts.InterfaceDeclaration).members, this);
	}
}
// Imports — typescript-estree assembles ImportDeclaration.specifiers from
// the import clause / named bindings / namespace import; we replicate.
// ImportClause maps to ImportDefaultSpecifier in ESTree (when it has a name).
// Function-like declarations share a shape — id (sometimes), params,
// body, returnType, generator/async/declare modifiers. typescript-estree
// flattens this into per-kind cases (FunctionDeclaration, FunctionExpression,
// ArrowFunction); we do the same to keep `this.type` literal.

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
		// Re-point the wrapped binding name — without this, the inner's
		// parent stays as the function passed to convertParameter, so
		// bottom-up materialise of the binding identifier sees
		// `parent.type === 'FunctionDeclaration'` instead of the
		// AssignmentPattern wrapper. Same pattern as
		// BindingAssignmentPatternNode.
		(left as { parent: LazyNode }).parent = this;
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
// `class C { static { ... } }` — class static initialiser block.
// `new.target` and `import.meta`. typescript-estree emits
// MetaProperty { meta: Identifier, property: Identifier } where the
// `meta` Identifier is synthetic (TS has only the keyword tokens).
// `true` / `false` keyword literals. typescript-estree maps them to
// `Literal { value: true|false, raw: 'true'|'false' }`.
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
			return this._openingElement = new JSXOpeningElementNode(t as ts.JsxSelfClosingElement, this);
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

// Hybrid: a real ESTree node when wrapping a ts.JsxOpeningElement, but
// synthetic when wrapping a ts.JsxSelfClosingElement (the outer JSXElement
// owns that TS slot). The `_registersInMaps` override below picks the
// right behavior from the wrapped TS kind, so both call sites use the
// same constructor.
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
	) {
		super(tsNode, parent);
		this.selfClosing = tsNode.kind === SK.JsxSelfClosingElement;
	}

	protected override _registersInMaps(): boolean {
		return this._ts.kind !== SK.JsxSelfClosingElement;
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
class JSXEmptyExpressionNode extends SyntheticLazyNode {
	readonly type = 'JSXEmptyExpression' as const;
	constructor(tsNode: ts.JsxExpression, parent: LazyNode) {
		// Synthetic — the JsxExpression TS slot is owned by JSXExpressionContainerNode.
		super(tsNode, parent);
		// Range matches eager: `[start+1, end-1]` to exclude the `{` `}`.
		this.range = [tsNode.getStart(this._ctx.ast) + 1, tsNode.getEnd() - 1];
	}
}

// JSXIdentifier — wraps an Identifier or sub-piece of a JsxNamespacedName.
// Each instance owns its inner ts.Identifier slot (distinct from the
// outer JsxNamespacedName / tag-name owner), so registration is always
// safe.
class JSXIdentifierNode extends LazyNode {
	readonly type = 'JSXIdentifier' as const;
	readonly name: string;
	constructor(
		tsNode: ts.Node,
		parent: LazyNode | null,
		name: string,
		range?: [number, number],
	) {
		super(tsNode, parent);
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
		return this._property = new JSXIdentifierNode(name, this, name.text);
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
		return this._namespace = new JSXIdentifierNode(ns, this, ns.text);
	}
	get name(): JSXIdentifierNode {
		if (this._name) return this._name;
		const nm = (this._ts as ts.JsxNamespacedName).name;
		return this._name = new JSXIdentifierNode(nm, this, nm.text);
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
		return new JSXIdentifierNode(node, parent, 'this');
	}
	const id = node as ts.Identifier;
	return new JSXIdentifierNode(id, parent, id.text);
}

// JSX attribute-name dispatch: a JsxNamespacedName (`<el ns:attr=… />`)
// or a plain ts.Identifier (`<el attr=… />`).
function convertJSXNamespaceOrIdentifier(node: ts.Node, parent: LazyNode): LazyNode {
	if (node.kind === SK.JsxNamespacedName) {
		return new JSXNamespacedNameNode(node, parent);
	}
	const id = node as ts.Identifier;
	return new JSXIdentifierNode(id, parent, id.text);
}

// JsxText / JsxAttribute-string entity decoding. typescript-estree's
// `unescapeStringLiteralText` (lib/node-utils.ts) decodes the full XHTML
// named-entity set + numeric refs. We vendor its `xhtmlEntities` table
// so `&copy;` → `©`, `&nbsp;` → U+00A0 (no-break space, NOT 0x20), etc.
// resolve to the exact code points eager produces. Rules that compare
// `.value` (react/no-unescaped-entities, jsx-a11y accessibility checks,
// whitespace detectors) need this parity — partial decoding silently
// hides real entities behind their `&name;` source form.
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
