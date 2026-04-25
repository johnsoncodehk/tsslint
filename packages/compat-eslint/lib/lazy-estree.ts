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
	// `function f(x: T)` — Parameter.type goes through the Identifier
	// returned by convertParameter, which carries `typeAnnotation`.
	if (tsParent.kind === SK.Parameter && (tsParent as ts.ParameterDeclaration).type === tsNode) {
		return {
			ownerTsNode: tsParent,
			trigger: (owner) => {
				const ta = (owner as unknown as { typeAnnotation?: { typeAnnotation: unknown } }).typeAnnotation;
				if (ta) void ta.typeAnnotation;
			},
		};
	}
	// `function f(): T` / `(): T => ...` — function-like return type goes
	// through the function node's `returnType` getter (a TSTypeAnnotation
	// wrapper).
	if (
		(tsParent.kind === SK.FunctionDeclaration
			|| tsParent.kind === SK.FunctionExpression
			|| tsParent.kind === SK.ArrowFunction)
		&& (tsParent as ts.SignatureDeclaration).type === tsNode
	) {
		return {
			ownerTsNode: tsParent,
			trigger: (owner) => {
				const rt = (owner as unknown as { returnType?: { typeAnnotation: unknown } }).returnType;
				if (rt) void rt.typeAnnotation;
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
		case SK.ExpressionStatement: return new ExpressionStatementNode(child as ts.ExpressionStatement, parent);
		case SK.ReturnStatement: return new ReturnStatementNode(child as ts.ReturnStatement, parent);
		case SK.Block: return new BlockStatementNode(child as ts.Block, parent);
		case SK.IfStatement: return new IfStatementNode(child as ts.IfStatement, parent);
		case SK.BinaryExpression: return new BinaryLikeExpressionNode(child as ts.BinaryExpression, parent);
		case SK.PropertyAccessExpression: return new MemberExpressionNode(child as ts.PropertyAccessExpression, parent);
		case SK.ElementAccessExpression: return new MemberExpressionNode(child as ts.ElementAccessExpression, parent);
		case SK.CallExpression: return new CallExpressionNode(child as ts.CallExpression, parent);
		case SK.TrueKeyword: return new BoolLiteralNode(child as ts.TrueLiteral, parent, true);
		case SK.FalseKeyword: return new BoolLiteralNode(child as ts.FalseLiteral, parent, false);
		case SK.FunctionDeclaration: return new FunctionDeclarationNode(child as ts.FunctionDeclaration, parent);
		case SK.FunctionExpression: return new FunctionExpressionNode(child as ts.FunctionExpression, parent);
		case SK.ArrowFunction: return new ArrowFunctionExpressionNode(child as ts.ArrowFunction, parent);
		case SK.Parameter: return convertParameter(child as ts.ParameterDeclaration, parent);
		case SK.ImportDeclaration: return new ImportDeclarationNode(child as ts.ImportDeclaration, parent);
		case SK.ImportSpecifier: return new ImportSpecifierNode(child as ts.ImportSpecifier, parent);
		case SK.NamespaceImport: return new ImportNamespaceSpecifierNode(child as ts.NamespaceImport, parent);
		case SK.ImportClause: return new ImportDefaultSpecifierNode(child as ts.ImportClause, parent);
		case SK.InterfaceDeclaration: return new TSInterfaceDeclarationNode(child as ts.InterfaceDeclaration, parent);
		case SK.PropertySignature: return new TSPropertySignatureNode(child as ts.PropertySignature, parent);
		case SK.MethodSignature: return new TSMethodSignatureNode(child as ts.MethodSignature, parent);
		case SK.FunctionType: return new TSFunctionTypeNode(child as ts.FunctionTypeNode, parent);
		case SK.UnionType: return new TSUnionTypeNode(child as ts.UnionTypeNode, parent);
		case SK.IntersectionType: return new TSIntersectionTypeNode(child as ts.IntersectionTypeNode, parent);
		case SK.ArrayType: return new TSArrayTypeNode(child as ts.ArrayTypeNode, parent);
		case SK.TypeLiteral: return new TSTypeLiteralNode(child as ts.TypeLiteralNode, parent);
		case SK.TypeQuery: return new TSTypeQueryNode(child as ts.TypeQueryNode, parent);
		case SK.TypeOperator: return new TSTypeOperatorNode(child as ts.TypeOperatorNode, parent);
		case SK.IndexedAccessType: return new TSIndexedAccessTypeNode(child as ts.IndexedAccessTypeNode, parent);
		case SK.LiteralType: return convertLiteralType(child as ts.LiteralTypeNode, parent);
		case SK.ParenthesizedType: return convertChild((child as ts.ParenthesizedTypeNode).type, parent);
		case SK.ImportType: return new TSImportTypeNode(child as ts.ImportTypeNode, parent);
		case SK.QualifiedName: return new TSQualifiedNameNode(child as ts.QualifiedName, parent);
		case SK.CallSignature: return new TSCallishSignatureNode('TSCallSignatureDeclaration', child as ts.CallSignatureDeclaration, parent);
		case SK.ConstructSignature: return new TSCallishSignatureNode('TSConstructSignatureDeclaration', child as ts.ConstructSignatureDeclaration, parent);
		case SK.IndexSignature: return new TSIndexSignatureNode(child as ts.IndexSignatureDeclaration, parent);
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
		return this._body ??= convertChildren((this._ts as ts.Block).statements, this);
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
		return new TypeKeywordNode('TSNullKeyword', tsNode.literal, parent);
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

class TSImportTypeNode extends LazyNode {
	readonly type = 'TSImportType' as const;
	readonly options = null;
	readonly typeArguments = null;
	private _argument?: LazyNode | null;
	private _qualifier?: LazyNode | null;
	get argument() {
		return this._argument ??= convertChild((this._ts as ts.ImportTypeNode).argument, this);
	}
	get qualifier() {
		return this._qualifier ??= convertChild((this._ts as ts.ImportTypeNode).qualifier, this);
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

// CallSignature + ConstructSignature share a shape — params + returnType +
// typeParameters. typescript-estree picks the type literal at construction.
class TSCallishSignatureNode extends LazyNode {
	readonly type: 'TSCallSignatureDeclaration' | 'TSConstructSignatureDeclaration';
	readonly typeParameters = undefined;
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
	get params() {
		return this._params ??= convertChildren((this._ts as ts.SignatureDeclarationBase).parameters!, this);
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
	readonly extends: never[] = [];
	readonly typeParameters = undefined;
	private _body?: TSInterfaceBodyNode;
	private _id?: LazyNode | null;

	constructor(tsNode: ts.InterfaceDeclaration, parent: LazyNode) {
		super(tsNode, parent);
		this.declare = !!tsNode.modifiers?.some(m => m.kind === SK.DeclareKeyword);
	}
	get id() {
		return this._id ??= convertChild((this._ts as ts.InterfaceDeclaration).name, this);
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
		this.loc = getLocFor(this._ctx.ast, range[0], range[1]);
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
	readonly typeParameters = undefined;
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
	readonly typeParameters = undefined;
	private _params?: (LazyNode | null)[];
	private _returnType?: LazyNode | null | undefined;

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
	readonly attributes: never[] = [];
	readonly assertions: never[] = [];
	private _source?: LazyNode | null;
	private _specifiers?: (LazyNode | null)[];

	constructor(tsNode: ts.ImportDeclaration, parent: LazyNode) {
		super(tsNode, parent);
		this.importKind = tsNode.importClause?.isTypeOnly ? 'type' : 'value';
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
				this.loc = getLocFor(this._ctx.ast, this.range[0], this.range[1]);
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
	readonly typeParameters = undefined;
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
	readonly typeParameters = undefined;
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
	readonly typeParameters = undefined;
	readonly expression: boolean;
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
	get body() {
		return this._body ??= convertChild((this._ts as ts.ArrowFunction).body, this);
	}
	get returnType() {
		if (this._returnType !== undefined) return this._returnType;
		const t = (this._ts as ts.ArrowFunction).type;
		return this._returnType = t ? convertTypeAnnotation(t, this) : undefined;
	}
}

// Parameter doesn't have its own ESTree type for the simple case — the
// underlying Identifier is returned with `typeAnnotation` attached. Mirrors
// typescript-estree's Parameter case (line 1156). MVP: simple identifier
// only; rest/default/modifiers/optional throw.
function convertParameter(tsNode: ts.ParameterDeclaration, parent: LazyNode): LazyNode | null {
	if (tsNode.dotDotDotToken) {
		throw new Error('lazy-estree: rest parameter not yet supported');
	}
	if (tsNode.initializer) {
		throw new Error('lazy-estree: parameter with default value not yet supported');
	}
	if (tsNode.modifiers?.length) {
		throw new Error('lazy-estree: parameter modifiers (TSParameterProperty) not yet supported');
	}
	const idNode = convertChild(tsNode.name, parent);
	if (!idNode) return null;
	if (tsNode.type) {
		const annotation = convertTypeAnnotation(tsNode.type, idNode);
		(idNode as { typeAnnotation?: LazyNode | null }).typeAnnotation = annotation;
		(idNode as unknown as { _extendRange: (r: [number, number]) => void })._extendRange(annotation.range);
	}
	if (tsNode.questionToken) {
		(idNode as { optional?: boolean }).optional = true;
		// typescript-estree extends the parameter's range to cover the `?`.
		if (tsNode.questionToken.end > idNode.range[1]) {
			(idNode as unknown as { _extendRange: (r: [number, number]) => void })
				._extendRange([idNode.range[0], tsNode.questionToken.end]);
		}
	}
	// Map the Parameter TS node to the Identifier — typescript-estree does
	// this implicitly via converter()→registerTSNodeInNodeMap.
	parent._ctx.maps.tsNodeToESTreeNodeMap.set(tsNode, idNode);
	return idNode;
}

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
		const op = tsNode.operatorToken.getText(this._ctx.ast);
		this.operator = op;
		if (op === '&&' || op === '||' || op === '??') {
			this.type = 'LogicalExpression';
		}
		else if (op.endsWith('=') && op !== '==' && op !== '===' && op !== '!=' && op !== '!==' && op !== '<=' && op !== '>=') {
			this.type = 'AssignmentExpression';
		}
		else {
			this.type = 'BinaryExpression';
		}
	}

	get left() {
		return this._left ??= convertChild((this._ts as ts.BinaryExpression).left, this);
	}

	get right() {
		return this._right ??= convertChild((this._ts as ts.BinaryExpression).right, this);
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
	readonly typeArguments = undefined;
	readonly typeParameters = undefined;
	private _callee?: LazyNode | null;
	private _arguments?: (LazyNode | null)[];

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
