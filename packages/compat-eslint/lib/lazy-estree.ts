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
	esTreeNodeToTSNodeMap: WeakMap<object, ts.Node>;
	tsNodeToESTreeNodeMap: WeakMap<ts.Node, object>;
}

export interface ConvertContext {
	ast: ts.SourceFile;
	maps: LazyAstMaps;
}

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
	range: [number, number];
	loc: ReturnType<typeof getLocFor>;
	_ts: ts.Node;
	// Conversion context shared with descendants. Children created via getter
	// inherit this from the parent — the root sets it from `convertLazy`.
	// Public so the module-level `convertChild` can read it; underscore prefix
	// signals "internal".
	_ctx: ConvertContext;

	constructor(tsNode: ts.Node, parent: LazyNode | null, context?: ConvertContext, registerInMaps = true) {
		this._ts = tsNode;
		this.parent = parent;
		this._ctx = context ?? parent!._ctx;
		this.range = [tsNode.getStart(this._ctx.ast), tsNode.getEnd()];
		this.loc = getLocFor(this._ctx.ast, this.range[0], this.range[1]);
		// Synthetic wrapper nodes (TSTypeAnnotation) shouldn't claim the TS
		// node's map slot — that slot belongs to the inner converted node.
		if (registerInMaps) {
			this._ctx.maps.tsNodeToESTreeNodeMap.set(tsNode, this);
			this._ctx.maps.esTreeNodeToTSNodeMap.set(this, tsNode);
		}
	}

	// Extend this node's range to cover `childRange`. Used by parent nodes
	// that absorb a child's range (e.g. Identifier swallowing its
	// typeAnnotation, matching typescript-estree's `fixParentLocation`).
	protected _extendRange(childRange: [number, number]) {
		if (childRange[0] < this.range[0]) {
			this.range[0] = childRange[0];
		}
		if (childRange[1] > this.range[1]) {
			this.range[1] = childRange[1];
		}
		this.loc = getLocFor(this._ctx.ast, this.range[0], this.range[1]);
	}
}

// TS SyntaxKinds that don't map to an ESTree node — they're structural-only
// in the TS AST and get folded away by typescript-estree's converter. When
// walking up the TS parent chain in bottom-up materialisation, skip past
// these to find the nearest ESTree ancestor.
const TS_ONLY_KINDS = new Set<ts.SyntaxKind>([
	SK.VariableDeclarationList,
	SK.SyntaxList,
]);

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
function findWrapperRoute(tsNode: ts.Node):
	| { ownerTsNode: ts.Node; trigger: (owner: LazyNode) => void; }
	| null
{
	const tsParent = tsNode.parent;
	if (!tsParent) return null;
	// `let x: T = ...` — VariableDeclaration.type goes through Identifier.typeAnnotation
	if (tsParent.kind === SK.VariableDeclaration && (tsParent as ts.VariableDeclaration).type === tsNode) {
		return {
			ownerTsNode: tsParent,
			trigger: (owner) => {
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
	return null;
}

// Bottom-up materialisation: given any TS node anywhere in the source, return
// (creating if needed) its ESTree counterpart. Walks up via `tsNode.parent`
// to find / build the ESTree parent chain — at each step the cache lookup
// keyed on TS node identity is what enables sibling reuse: child_b walking
// up hits the same tsParent in the cache that child_a's walk-up registered,
// so both end up with the same parent ESTree instance.
//
// The lookup-on-cache property is what makes top-down (parent.children
// getter calls convertChild per child) and bottom-up (this function) coherent:
// both paths converge on the same instance when they meet at a shared TS node.
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
	// Find the nearest TS ancestor with an ESTree counterpart. Some TS-only
	// shapes (VariableDeclarationList, SyntaxList) have no ESTree node and
	// need to be skipped.
	let walker: ts.Node | undefined = tsNode.parent;
	while (walker && TS_ONLY_KINDS.has(walker.kind)) {
		walker = walker.parent;
	}
	const parent: LazyNode | null = walker ? materialize(walker, ctx) : null;
	if (!parent) {
		throw new Error('lazy-estree: cannot materialise without an ESTree ancestor — did you call materialize() with the SourceFile? convertLazy() handles that.');
	}
	const node = convertChild(tsNode, parent);
	if (!node) {
		throw new Error(`lazy-estree: convertChild returned null for ${SK[tsNode.kind]}`);
	}
	return node;
}

// Dispatch: TS SyntaxKind → lazy ESTree class. Returns null for null/undefined
// (matching typescript-estree's `converter()` early-exit on falsy input).
// Cached: if the same TS node has been converted before (e.g. via a parent's
// child slot then later via getDeclaredVariables), return the same instance.
function convertChild(child: ts.Node | undefined | null, parent: LazyNode): LazyNode | null {
	if (!child) return null;
	const cached = parent._ctx.maps.tsNodeToESTreeNodeMap.get(child);
	if (cached) return cached as LazyNode;
	switch (child.kind) {
		case SK.SourceFile: return new ProgramNode(child as ts.SourceFile, parent);
		case SK.Identifier: return new IdentifierNode(child as ts.Identifier, parent);
		case SK.VariableStatement: return new VariableDeclarationNode(child as ts.VariableStatement, parent);
		case SK.VariableDeclaration: return new VariableDeclaratorNode(child as ts.VariableDeclaration, parent);
		case SK.AsExpression: return new TSAsExpressionNode(child as ts.AsExpression, parent);
		case SK.TypeReference: return new TSTypeReferenceNode(child as ts.TypeReferenceNode, parent);
		case SK.NumericLiteral: return new LiteralNode(child as ts.NumericLiteral, parent);
		case SK.StringLiteral: return new LiteralNode(child as ts.StringLiteral, parent);
		case SK.AnyKeyword: return new TypeKeywordNode('TSAnyKeyword', child, parent);
		case SK.UnknownKeyword: return new TypeKeywordNode('TSUnknownKeyword', child, parent);
		case SK.NumberKeyword: return new TypeKeywordNode('TSNumberKeyword', child, parent);
		case SK.StringKeyword: return new TypeKeywordNode('TSStringKeyword', child, parent);
		case SK.BooleanKeyword: return new TypeKeywordNode('TSBooleanKeyword', child, parent);
		case SK.SymbolKeyword: return new TypeKeywordNode('TSSymbolKeyword', child, parent);
		case SK.NeverKeyword: return new TypeKeywordNode('TSNeverKeyword', child, parent);
		case SK.VoidKeyword: return new TypeKeywordNode('TSVoidKeyword', child, parent);
		case SK.UndefinedKeyword: return new TypeKeywordNode('TSUndefinedKeyword', child, parent);
		case SK.NullKeyword: return new TypeKeywordNode('TSNullKeyword', child, parent);
		case SK.BigIntKeyword: return new TypeKeywordNode('TSBigIntKeyword', child, parent);
		case SK.ObjectKeyword: return new TypeKeywordNode('TSObjectKeyword', child, parent);
		case SK.IntrinsicKeyword: return new TypeKeywordNode('TSIntrinsicKeyword', child, parent);
		default:
			throw new Error(
				`lazy-estree: unsupported SyntaxKind ${SK[child.kind] ?? child.kind} `
					+ `(at ${child.getStart(parent._ctx.ast)}-${child.getEnd()}). `
					+ `Add a case to convertChild() with the corresponding LazyNode subclass.`,
			);
	}
}

function convertChildren(children: ReadonlyArray<ts.Node>, parent: LazyNode): (LazyNode | null)[] {
	return children.map(c => convertChild(c, parent));
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

// --- Per-kind classes ---------------------------------------------------

class ProgramNode extends LazyNode {
	readonly type = 'Program' as const;
	readonly sourceType: 'module' | 'script';
	comments: any[] = [];
	tokens: any[] = [];
	private _body?: (LazyNode | null)[];

	constructor(tsNode: ts.SourceFile, parent: LazyNode | null, context?: ConvertContext) {
		super(tsNode, parent, context);
		// Program range ends at endOfFileToken.end, not source file end.
		this.range = [tsNode.getStart(this._ctx.ast), tsNode.endOfFileToken.end];
		this.loc = getLocFor(this._ctx.ast, this.range[0], this.range[1]);
		this.sourceType = (tsNode as { externalModuleIndicator?: unknown }).externalModuleIndicator ? 'module' : 'script';
	}

	get body() {
		return this._body ??= convertChildren((this._ts as ts.SourceFile).statements, this);
	}
}

class IdentifierNode extends LazyNode {
	readonly type = 'Identifier' as const;
	readonly name: string;
	readonly decorators: never[] = [];
	readonly optional = false;
	readonly typeAnnotation = undefined;

	constructor(tsNode: ts.Identifier, parent: LazyNode | null) {
		super(tsNode, parent);
		this.name = tsNode.text;
	}
}

class VariableDeclarationNode extends LazyNode {
	readonly type = 'VariableDeclaration' as const;
	readonly kind: 'var' | 'let' | 'const';
	readonly declare: boolean;
	private _declarations?: (LazyNode | null)[];

	constructor(tsNode: ts.VariableStatement, parent: LazyNode | null) {
		super(tsNode, parent);
		const list = tsNode.declarationList;
		const flags = list.flags;
		this.kind = flags & ts.NodeFlags.Const ? 'const' : flags & ts.NodeFlags.Let ? 'let' : 'var';
		this.declare = !!tsNode.modifiers?.some(m => m.kind === SK.DeclareKeyword);
	}

	get declarations() {
		return this._declarations ??= convertChildren((this._ts as ts.VariableStatement).declarationList.declarations, this);
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
	private _typeArguments?: LazyNode | null;

	get typeName() {
		return this._typeName ??= convertChild((this._ts as ts.TypeReferenceNode).typeName, this);
	}

	get typeArguments() {
		if (this._typeArguments !== undefined) return this._typeArguments;
		// typescript-estree wraps node.typeArguments in a TSTypeParameterInstantiation
		// node. MVP elides this — return undefined when absent. Add a wrapper class
		// when a rule actually needs it.
		const args = (this._ts as ts.TypeReferenceNode).typeArguments;
		return this._typeArguments = args ? null : null;
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
		this.loc = getLocFor(this._ctx.ast, range[0], range[1]);
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

class LiteralNode extends LazyNode {
	readonly type = 'Literal' as const;
	readonly value: string | number | null;
	readonly raw: string;

	constructor(tsNode: ts.LiteralExpression, parent: LazyNode) {
		super(tsNode, parent);
		this.raw = tsNode.getText(this._ctx.ast);
		if (tsNode.kind === SK.NumericLiteral) {
			this.value = Number(tsNode.text);
		}
		else if (tsNode.kind === SK.StringLiteral) {
			this.value = tsNode.text;
		}
		else {
			this.value = null;
		}
	}
}

// --- Entry point --------------------------------------------------------

export function convertLazy(file: ts.SourceFile): { estree: ProgramNode; astMaps: LazyAstMaps; context: ConvertContext; } {
	const maps: LazyAstMaps = {
		esTreeNodeToTSNodeMap: new WeakMap(),
		tsNodeToESTreeNodeMap: new WeakMap(),
	};
	const context: ConvertContext = { ast: file, maps };
	const estree = new ProgramNode(file, null, context);
	return { estree, astMaps: maps, context };
}
