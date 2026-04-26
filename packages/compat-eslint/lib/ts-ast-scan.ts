// Phase B+: TS-AST-driven scan.
//
// Phase B (selectorAwareTraverse) walks the lazy ESTree, paying for one
// LazyNode per visited node — even ones rules don't care about. For rule
// sets with narrow trigger types (e.g. only TSAsExpression), most of those
// builds are wasted: the rule never reads the node, but we materialised it
// to learn its `.type` for selector dispatch.
//
// Smarter approach: walk the TS AST directly. TS nodes are plain objects
// (TS compiler created them), no getters, no allocation. For each TS node,
// check `ts.SyntaxKind` against an "ESTree-type → predicate" table; only
// when a predicate matches do we call `materialize()` to build the ESTree
// counterpart and dispatch listeners.
//
// Result: a file with thousands of TS nodes but only a handful of trigger
// matches builds only a handful of LazyNodes. Bottom-up `materialize`
// already lazy-builds the parent chain when a rule reads `.parent`, so we
// don't pre-build ancestors either.

import * as ts from 'typescript';

const SK = ts.SyntaxKind;
// `import * as ts` lowers to a namespace object guarded by a getter on
// each access. Caching this once avoids the getter per visit (~2% hot path).
const tsForEachChild = ts.forEachChild;

// VisitNodeStep constructor (re-resolved here so this module doesn't
// depend on the index.ts wiring).
const pluginKitPath = require.resolve('@eslint/plugin-kit', {
	paths: [require.resolve('eslint/package.json')],
});
const { VisitNodeStep } = require(pluginKitPath) as {
	VisitNodeStep: new (init: { target: unknown; phase: 1 | 2; args: unknown[] }) => unknown;
};

type Predicate = (n: ts.Node) => boolean;

// --- Operator buckets ------------------------------------------------

// typescript-estree splits a single SK.BinaryExpression into
// BinaryExpression / LogicalExpression / AssignmentExpression based on
// `operatorToken.kind`. Predicates filter accordingly.
const LOGICAL_OPS = new Set<ts.SyntaxKind>([
	SK.AmpersandAmpersandToken,
	SK.BarBarToken,
	SK.QuestionQuestionToken,
]);
const ASSIGN_OPS = new Set<ts.SyntaxKind>([
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

// --- Helpers ---------------------------------------------------------

function isUnaryOp(op: ts.SyntaxKind): boolean {
	return op === SK.PlusToken || op === SK.MinusToken
		|| op === SK.TildeToken || op === SK.ExclamationToken;
}
function isUpdateOp(op: ts.SyntaxKind): boolean {
	return op === SK.PlusPlusToken || op === SK.MinusMinusToken;
}

// ChainExpression detection. typescript-estree wraps the OUTERMOST node
// of an optional-chain in ChainExpression — the inner accesses end up as
// plain MemberExpression / CallExpression. Predicate only fires on the
// outermost: a chain-shaped node (PropertyAccess / ElementAccess / Call)
// where (a) some descendant in the chain has `?.`, and (b) the parent
// doesn't extend this chain via `.expression` / `.callee`.
function chainHasQuestionDot(n: ts.Node): boolean {
	if (n.kind === SK.PropertyAccessExpression || n.kind === SK.ElementAccessExpression) {
		const acc = n as ts.PropertyAccessExpression | ts.ElementAccessExpression;
		if (acc.questionDotToken) return true;
		return chainHasQuestionDot(acc.expression);
	}
	if (n.kind === SK.CallExpression) {
		const ce = n as ts.CallExpression;
		if (ce.questionDotToken) return true;
		return chainHasQuestionDot(ce.expression);
	}
	if (n.kind === SK.NonNullExpression) {
		return chainHasQuestionDot((n as ts.NonNullExpression).expression);
	}
	return false;
}
function parentExtendsChainOf(parent: ts.Node, child: ts.Node): boolean {
	if (parent.kind === SK.PropertyAccessExpression
		|| parent.kind === SK.ElementAccessExpression) {
		return (parent as ts.PropertyAccessExpression | ts.ElementAccessExpression).expression === child;
	}
	if (parent.kind === SK.CallExpression) {
		return (parent as ts.CallExpression).expression === child;
	}
	if (parent.kind === SK.NonNullExpression) {
		return (parent as ts.NonNullExpression).expression === child;
	}
	return false;
}
function isOutermostOptionalChain(n: ts.Node): boolean {
	if (n.kind !== SK.PropertyAccessExpression
		&& n.kind !== SK.ElementAccessExpression
		&& n.kind !== SK.CallExpression) {
		return false;
	}
	if (!chainHasQuestionDot(n)) return false;
	if (n.parent && parentExtendsChainOf(n.parent, n)) return false;
	return true;
}

function hasModifier(n: ts.Node, kind: ts.SyntaxKind): boolean {
	return !!(n as { modifiers?: ReadonlyArray<ts.ModifierLike> }).modifiers
		?.some(m => m.kind === kind);
}

function hasExportModifier(n: ts.Node): boolean {
	return hasModifier(n, SK.ExportKeyword);
}
function hasDefaultModifier(n: ts.Node): boolean {
	return hasModifier(n, SK.DefaultKeyword);
}
function hasAbstractModifier(n: ts.Node): boolean {
	return hasModifier(n, SK.AbstractKeyword);
}
function hasAccessorModifier(n: ts.Node): boolean {
	return hasModifier(n, SK.AccessorKeyword);
}

// Class-constructor parameter property modifiers (`constructor(public x)`).
function hasParameterPropertyModifier(n: ts.Node): boolean {
	const ms = (n as { modifiers?: ReadonlyArray<ts.ModifierLike> }).modifiers;
	if (!ms) return false;
	for (const m of ms) {
		if (m.kind === SK.PublicKeyword || m.kind === SK.PrivateKeyword
			|| m.kind === SK.ProtectedKeyword || m.kind === SK.ReadonlyKeyword
			|| m.kind === SK.OverrideKeyword) {
			return true;
		}
	}
	return false;
}

// Set of TS kinds that lazy-estree's fixExports can wrap into
// ExportNamedDeclaration / ExportDefaultDeclaration.
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

// True when `tsNode` sits in a position where typescript-estree converts
// expression-shaped TS nodes (ArrayLiteralExpression, ObjectLiteralExpression,
// SpreadElement / SpreadAssignment) as their PATTERN counterparts (ArrayPattern,
// ObjectPattern, RestElement). Walk up through pattern-transparent containers
// (literals, spreads, property assignments, parens) until we hit the
// determining ancestor: assignment LHS or for-of/for-in initializer.
function isInPatternPosition(tsNode: ts.Node): boolean {
	let cur: ts.Node = tsNode;
	while (cur.parent) {
		const p = cur.parent;
		// Pattern-transparent: keep walking up. The shape of `cur` may
		// itself be a literal/spread that hasn't yet decided whether it's
		// expression or pattern — its ancestors decide.
		if (p.kind === SK.ArrayLiteralExpression
			|| p.kind === SK.ObjectLiteralExpression
			|| p.kind === SK.SpreadElement
			|| p.kind === SK.SpreadAssignment
			|| p.kind === SK.PropertyAssignment
			|| p.kind === SK.ShorthandPropertyAssignment
			|| p.kind === SK.ParenthesizedExpression) {
			cur = p;
			continue;
		}
		if (p.kind === SK.BinaryExpression) {
			const be = p as ts.BinaryExpression;
			if (be.operatorToken.kind === SK.EqualsToken && be.left === cur) {
				return true;
			}
			// `=` RHS or non-`=` operator: not pattern. Stop walking.
			return false;
		}
		if (p.kind === SK.ForInStatement || p.kind === SK.ForOfStatement) {
			return (p as ts.ForInStatement | ts.ForOfStatement).initializer === cur;
		}
		return false;
	}
	return false;
}

// --- Predicate registry ---------------------------------------------

const PREDICATES: Record<string, Predicate> = {
	// --- Program root --------------------------------------------------
	'Program': n => n.kind === SK.SourceFile,

	// --- Statements ----------------------------------------------------
	'ExpressionStatement': n => n.kind === SK.ExpressionStatement,
	'BlockStatement': n => n.kind === SK.Block,
	'IfStatement': n => n.kind === SK.IfStatement,
	'WhileStatement': n => n.kind === SK.WhileStatement,
	'DoWhileStatement': n => n.kind === SK.DoStatement,
	'ForStatement': n => n.kind === SK.ForStatement,
	'ForInStatement': n => n.kind === SK.ForInStatement,
	'ForOfStatement': n => n.kind === SK.ForOfStatement,
	'ReturnStatement': n => n.kind === SK.ReturnStatement,
	'ThrowStatement': n => n.kind === SK.ThrowStatement,
	'TryStatement': n => n.kind === SK.TryStatement,
	'CatchClause': n => n.kind === SK.CatchClause,
	'SwitchStatement': n => n.kind === SK.SwitchStatement,
	'SwitchCase': n => n.kind === SK.CaseClause || n.kind === SK.DefaultClause,
	'BreakStatement': n => n.kind === SK.BreakStatement,
	'ContinueStatement': n => n.kind === SK.ContinueStatement,
	'LabeledStatement': n => n.kind === SK.LabeledStatement,
	'EmptyStatement': n => n.kind === SK.EmptyStatement,
	'DebuggerStatement': n => n.kind === SK.DebuggerStatement,

	// --- Variables -----------------------------------------------------
	'VariableDeclaration': n => n.kind === SK.VariableStatement, // ESTree flips the names
	'VariableDeclarator': n => n.kind === SK.VariableDeclaration,

	// --- Functions / Classes ------------------------------------------
	'FunctionDeclaration': n => n.kind === SK.FunctionDeclaration && (n as ts.FunctionDeclaration).body !== undefined,
	// `declare function foo();` — body-less. lazy-estree's
	// FunctionDeclarationNode emits TSDeclareFunction in this case.
	'TSDeclareFunction': n => n.kind === SK.FunctionDeclaration && (n as ts.FunctionDeclaration).body === undefined,
	'FunctionExpression': n => n.kind === SK.FunctionExpression,
	'ArrowFunctionExpression': n => n.kind === SK.ArrowFunction,
	'ClassDeclaration': n => n.kind === SK.ClassDeclaration,
	'ClassExpression': n => n.kind === SK.ClassExpression,
	// ClassBody is a synthetic ESTree wrapper around a class's members
	// (no own TS kind). Predicate fires for the class itself; unwrapChain
	// pulls the materialised ClassNode's `.body` into the dispatch chain
	// so a ClassBody listener fires after the class enters but before its
	// members are visited.
	'ClassBody': n => n.kind === SK.ClassDeclaration || n.kind === SK.ClassExpression,
	// `class C { static {} }` — class static initialiser block.
	'StaticBlock': n => n.kind === SK.ClassStaticBlockDeclaration,
	// `new.target`, `import.meta`.
	'MetaProperty': n => n.kind === SK.MetaProperty,
	// MethodDeclaration / Constructor / GetAccessor / SetAccessor outside
	// an object literal materialise as MethodDefinition; inside an object
	// literal they become Property{method:true} or Property{kind:'get'/'set'}.
	'MethodDefinition': n => (
		n.kind === SK.MethodDeclaration || n.kind === SK.Constructor
		|| n.kind === SK.GetAccessor || n.kind === SK.SetAccessor
	) && n.parent?.kind !== SK.ObjectLiteralExpression
		&& !hasModifier(n, SK.AbstractKeyword),
	// `abstract foo();` (body-less abstract method) materialises as
	// TSAbstractMethodDefinition.
	'TSAbstractMethodDefinition': n => (
		n.kind === SK.MethodDeclaration || n.kind === SK.GetAccessor || n.kind === SK.SetAccessor
	) && n.parent?.kind !== SK.ObjectLiteralExpression
		&& hasModifier(n, SK.AbstractKeyword),

	// PropertyDeclaration without abstract/accessor modifiers materialises
	// as PropertyDefinition. With modifiers it splits into AccessorProperty,
	// TSAbstractPropertyDefinition, TSAbstractAccessorProperty.
	'PropertyDefinition': n => n.kind === SK.PropertyDeclaration
		&& !hasAbstractModifier(n) && !hasAccessorModifier(n),
	'AccessorProperty': n => n.kind === SK.PropertyDeclaration
		&& hasAccessorModifier(n) && !hasAbstractModifier(n),
	'TSAbstractPropertyDefinition': n => n.kind === SK.PropertyDeclaration
		&& hasAbstractModifier(n) && !hasAccessorModifier(n),
	'TSAbstractAccessorProperty': n => n.kind === SK.PropertyDeclaration
		&& hasAbstractModifier(n) && hasAccessorModifier(n),

	// Class-constructor parameter properties (`constructor(public x: number)`)
	// wrap the parameter into TSParameterProperty.
	'TSParameterProperty': n => n.kind === SK.Parameter
		&& hasParameterPropertyModifier(n),

	// --- Decorators ---------------------------------------------------
	'Decorator': n => n.kind === SK.Decorator,

	// --- Expressions --------------------------------------------------
	'BinaryExpression': n => n.kind === SK.BinaryExpression
		&& !LOGICAL_OPS.has((n as ts.BinaryExpression).operatorToken.kind)
		&& !ASSIGN_OPS.has((n as ts.BinaryExpression).operatorToken.kind),
	'LogicalExpression': n => n.kind === SK.BinaryExpression
		&& LOGICAL_OPS.has((n as ts.BinaryExpression).operatorToken.kind),
	// `=`-style assignment in expression position only — `=` inside a pattern
	// destructure is AssignmentPattern, not AssignmentExpression. Compound
	// assignments (`+=`, `||=`, …) are always AssignmentExpression — they
	// don't appear in pattern position.
	'AssignmentExpression': n => n.kind === SK.BinaryExpression
		&& ASSIGN_OPS.has((n as ts.BinaryExpression).operatorToken.kind),
	// PrefixUnaryExpression with !/+/-/~  AND  TypeOfExpression /
	// DeleteExpression / VoidExpression all collapse to UnaryExpression in
	// ESTree. The latter three are their own SyntaxKinds in TS AST.
	'UnaryExpression': n => (n.kind === SK.PrefixUnaryExpression
			&& isUnaryOp((n as ts.PrefixUnaryExpression).operator))
		|| n.kind === SK.TypeOfExpression
		|| n.kind === SK.DeleteExpression
		|| n.kind === SK.VoidExpression,
	'UpdateExpression': n => (n.kind === SK.PrefixUnaryExpression
		&& isUpdateOp((n as ts.PrefixUnaryExpression).operator))
		|| n.kind === SK.PostfixUnaryExpression,
	// Plain function call. Dynamic `import('x')` is also SK.CallExpression
	// but lazy-estree converts it to ImportExpression — predicate matches
	// either way; dispatchFast filters by `target.type` so a CallExpression
	// listener won't fire on an ImportExpression node.
	'CallExpression': n => n.kind === SK.CallExpression
		&& (n as ts.CallExpression).expression.kind !== SK.ImportKeyword,
	// Dynamic `import('x')` as expression — SK.CallExpression with
	// ImportKeyword as expression.
	'ImportExpression': n => n.kind === SK.CallExpression
		&& (n as ts.CallExpression).expression.kind === SK.ImportKeyword,
	// Outermost optional-chain root (lazy-estree wraps only the outermost).
	'ChainExpression': isOutermostOptionalChain,
	'NewExpression': n => n.kind === SK.NewExpression,
	'MemberExpression': n => n.kind === SK.PropertyAccessExpression || n.kind === SK.ElementAccessExpression,
	'ConditionalExpression': n => n.kind === SK.ConditionalExpression,
	'AwaitExpression': n => n.kind === SK.AwaitExpression,
	'YieldExpression': n => n.kind === SK.YieldExpression,
	'ThisExpression': n => n.kind === SK.ThisKeyword,
	'Super': n => n.kind === SK.SuperKeyword,
	'TemplateLiteral': n => n.kind === SK.TemplateExpression || n.kind === SK.NoSubstitutionTemplateLiteral,
	'TaggedTemplateExpression': n => n.kind === SK.TaggedTemplateExpression,

	// SpreadElement vs RestElement: same TS kinds (SK.SpreadElement /
	// SpreadAssignment), split by pattern context. SpreadElement only in
	// expression position; RestElement only in pattern position.
	'SpreadElement': n => (n.kind === SK.SpreadElement || n.kind === SK.SpreadAssignment)
		&& !isInPatternPosition(n),

	// --- Array / Object — context-sensitive ---------------------------
	// ArrayExpression / ObjectExpression: literal in expression position.
	// ArrayPattern / ObjectPattern: BindingPattern (always pattern), or
	// literal in pattern position.
	'ArrayExpression': n => n.kind === SK.ArrayLiteralExpression && !isInPatternPosition(n),
	'ObjectExpression': n => n.kind === SK.ObjectLiteralExpression && !isInPatternPosition(n),
	'ArrayPattern': n => n.kind === SK.ArrayBindingPattern
		|| (n.kind === SK.ArrayLiteralExpression && isInPatternPosition(n)),
	'ObjectPattern': n => n.kind === SK.ObjectBindingPattern
		|| (n.kind === SK.ObjectLiteralExpression && isInPatternPosition(n)),

	// Property: PropertyAssignment / ShorthandPropertyAssignment / methods
	// inside object literal / BindingElement inside ObjectBindingPattern
	// (for `{a, b}` destructuring patterns).
	'Property': n => n.kind === SK.PropertyAssignment
		|| n.kind === SK.ShorthandPropertyAssignment
		|| ((n.kind === SK.MethodDeclaration || n.kind === SK.GetAccessor || n.kind === SK.SetAccessor)
			&& n.parent?.kind === SK.ObjectLiteralExpression)
		|| (n.kind === SK.BindingElement && n.parent?.kind === SK.ObjectBindingPattern
			&& !(n as ts.BindingElement).dotDotDotToken),

	// AssignmentPattern: parameter with default value, and array-binding
	// element with default value (`[a = 1] = …`). NOT emitted for
	// destructure with `=` in the binary-expression form — lazy-estree
	// keeps that as AssignmentExpression (existing parity gap).
	'AssignmentPattern': n =>
		(n.kind === SK.Parameter && (n as ts.ParameterDeclaration).initializer !== undefined
			&& (n as ts.ParameterDeclaration).dotDotDotToken === undefined)
		|| (n.kind === SK.BindingElement && n.parent?.kind === SK.ArrayBindingPattern
			&& (n as ts.BindingElement).initializer !== undefined
			&& !(n as ts.BindingElement).dotDotDotToken),

	// RestElement: rest parameter, rest-style binding element in any
	// binding pattern, and `...x` in pattern position.
	'RestElement': n =>
		(n.kind === SK.Parameter && (n as ts.ParameterDeclaration).dotDotDotToken !== undefined)
		|| (n.kind === SK.BindingElement && (n as ts.BindingElement).dotDotDotToken !== undefined)
		|| ((n.kind === SK.SpreadElement || n.kind === SK.SpreadAssignment)
			&& isInPatternPosition(n)),

	// --- Literals -----------------------------------------------------
	// typescript-estree collapses these TS kinds into Literal.
	'Literal': n =>
		n.kind === SK.NumericLiteral
		|| n.kind === SK.StringLiteral
		|| n.kind === SK.RegularExpressionLiteral
		|| n.kind === SK.BigIntLiteral
		|| n.kind === SK.NullKeyword
		|| n.kind === SK.TrueKeyword
		|| n.kind === SK.FalseKeyword,

	// --- Identifiers --------------------------------------------------
	'Identifier': n => n.kind === SK.Identifier,
	'PrivateIdentifier': n => n.kind === SK.PrivateIdentifier,

	// --- Imports / Exports -------------------------------------------
	'ImportDeclaration': n => n.kind === SK.ImportDeclaration,
	'ImportSpecifier': n => n.kind === SK.ImportSpecifier,
	// ImportClause becomes ImportDefaultSpecifier ONLY when it has a
	// `name` (i.e. `import a from 'x'`). Named-only `import { a } from 'x'`
	// has no name on the clause — typescript-estree wouldn't emit one.
	'ImportDefaultSpecifier': n => n.kind === SK.ImportClause && (n as ts.ImportClause).name !== undefined,
	'ImportNamespaceSpecifier': n => n.kind === SK.NamespaceImport,
	'ImportAttribute': n => n.kind === SK.ImportAttribute,
	'ExportSpecifier': n => n.kind === SK.ExportSpecifier,

	// ExportNamedDeclaration sources:
	//   - SK.ExportDeclaration with `NamedExports` clause
	//     (`export { foo }`, `export { foo } from 'x'`)
	//   - top-level decl with `export` (and not `default`) — fixExports
	//     wraps; materialize returns ExportNamedWrappingNode (handled by
	//     unwrapChain below)
	'ExportNamedDeclaration': n =>
		(n.kind === SK.ExportDeclaration
			&& (n as ts.ExportDeclaration).exportClause?.kind === SK.NamedExports)
		|| (EXPORTABLE_KINDS.has(n.kind) && hasExportModifier(n) && !hasDefaultModifier(n)),
	// ExportAllDeclaration: SK.ExportDeclaration with `*` —
	// `export * from 'x'` (no exportClause) or
	// `export * as ns from 'x'` (NamespaceExport clause).
	'ExportAllDeclaration': n => {
		if (n.kind !== SK.ExportDeclaration) return false;
		const clause = (n as ts.ExportDeclaration).exportClause;
		return !clause || clause.kind === SK.NamespaceExport;
	},
	// ExportDefaultDeclaration sources:
	//   - SK.ExportAssignment (`export default <expr>` AND `export = <expr>`
	//     — the latter materializes as TSExportAssignment, so guard here)
	//   - top-level decl with `export default` (FunctionDeclaration,
	//     ClassDeclaration, etc.)
	'ExportDefaultDeclaration': n =>
		(n.kind === SK.ExportAssignment && !(n as ts.ExportAssignment).isExportEquals)
		|| (EXPORTABLE_KINDS.has(n.kind) && hasExportModifier(n) && hasDefaultModifier(n)),

	// --- TS leaf keyword types (all 1:1) -------------------------------
	'TSAnyKeyword': n => n.kind === SK.AnyKeyword,
	'TSStringKeyword': n => n.kind === SK.StringKeyword,
	'TSNumberKeyword': n => n.kind === SK.NumberKeyword,
	'TSBooleanKeyword': n => n.kind === SK.BooleanKeyword,
	'TSBigIntKeyword': n => n.kind === SK.BigIntKeyword,
	'TSNullKeyword': n => n.kind === SK.NullKeyword,
	'TSUndefinedKeyword': n => n.kind === SK.UndefinedKeyword,
	'TSVoidKeyword': n => n.kind === SK.VoidKeyword,
	'TSNeverKeyword': n => n.kind === SK.NeverKeyword,
	'TSUnknownKeyword': n => n.kind === SK.UnknownKeyword,
	'TSObjectKeyword': n => n.kind === SK.ObjectKeyword,
	'TSSymbolKeyword': n => n.kind === SK.SymbolKeyword,
	'TSIntrinsicKeyword': n => n.kind === SK.IntrinsicKeyword,
	'TSThisType': n => n.kind === SK.ThisType,

	// --- TS expression-flavored types (1:1) ----------------------------
	'TSAsExpression': n => n.kind === SK.AsExpression,
	'TSTypeAssertion': n => n.kind === SK.TypeAssertionExpression,
	'TSNonNullExpression': n => n.kind === SK.NonNullExpression,
	'TSSatisfiesExpression': n => n.kind === SK.SatisfiesExpression,

	// --- TS type composites (1:1, with one wrapper case) --------------
	'TSTypeReference': n => n.kind === SK.TypeReference,
	'TSUnionType': n => n.kind === SK.UnionType,
	'TSIntersectionType': n => n.kind === SK.IntersectionType,
	'TSArrayType': n => n.kind === SK.ArrayType,
	'TSTupleType': n => n.kind === SK.TupleType,
	'TSConditionalType': n => n.kind === SK.ConditionalType,
	'TSMappedType': n => n.kind === SK.MappedType,
	'TSIndexedAccessType': n => n.kind === SK.IndexedAccessType,
	'TSInferType': n => n.kind === SK.InferType,
	'TSTypeOperator': n => n.kind === SK.TypeOperator,
	// TSTypeQuery: regular `typeof X` — and lazy-estree wraps
	// `typeof import('x')` in TSTypeQuery as well (TSImportType inner).
	// Match both ts.SyntaxKinds; unwrapChain expands the wrapping case so
	// listeners on the inner TSImportType still fire.
	'TSTypeQuery': n => n.kind === SK.TypeQuery
		|| (n.kind === SK.ImportType && (n as ts.ImportTypeNode).isTypeOf),
	'TSImportType': n => n.kind === SK.ImportType,
	'TSLiteralType': n => n.kind === SK.LiteralType,
	'TSFunctionType': n => n.kind === SK.FunctionType,
	'TSConstructorType': n => n.kind === SK.ConstructorType,
	'TSTemplateLiteralType': n => n.kind === SK.TemplateLiteralType,
	'TSTypePredicate': n => n.kind === SK.TypePredicate,
	'TSTypeLiteral': n => n.kind === SK.TypeLiteral,
	'TSQualifiedName': n => n.kind === SK.QualifiedName,
	'TSOptionalType': n => n.kind === SK.OptionalType,
	'TSRestType': n => n.kind === SK.RestType,
	'TSTypeParameter': n => n.kind === SK.TypeParameter,

	// --- TS declarations (1:1, exportable) ----------------------------
	'TSInterfaceDeclaration': n => n.kind === SK.InterfaceDeclaration,
	'TSTypeAliasDeclaration': n => n.kind === SK.TypeAliasDeclaration,
	'TSEnumDeclaration': n => n.kind === SK.EnumDeclaration,
	'TSEnumMember': n => n.kind === SK.EnumMember,
	'TSModuleDeclaration': n => n.kind === SK.ModuleDeclaration,
	'TSImportEqualsDeclaration': n => n.kind === SK.ImportEqualsDeclaration,
	// TSExportAssignment: only `export = <expr>` (NOT `export default`).
	'TSExportAssignment': n => n.kind === SK.ExportAssignment
		&& !!(n as ts.ExportAssignment).isExportEquals,
	'TSExternalModuleReference': n => n.kind === SK.ExternalModuleReference,
	'TSNamespaceExportDeclaration': n => n.kind === SK.NamespaceExportDeclaration,

	// --- TS interface members ------------------------------------------
	'TSPropertySignature': n => n.kind === SK.PropertySignature,
	'TSMethodSignature': n => n.kind === SK.MethodSignature,
	'TSCallSignatureDeclaration': n => n.kind === SK.CallSignature,
	'TSConstructSignatureDeclaration': n => n.kind === SK.ConstructSignature,
	'TSIndexSignature': n => n.kind === SK.IndexSignature,
};

// Sidecar table: ESTree types whose predicate is EXACTLY a TS-kind check
// (no operator filter, modifier check, ancestor check, etc.). The hot
// path can replace 1+ function calls with a single `Set.has(node.kind)`
// when every trigger type lives in this table. Types missing from here
// fall back to their PREDICATES entry (still correct, just slower).
const SIMPLE_KINDS: Record<string, ts.SyntaxKind[]> = {
	'Program': [SK.SourceFile],
	'ExpressionStatement': [SK.ExpressionStatement],
	'BlockStatement': [SK.Block],
	'IfStatement': [SK.IfStatement],
	'WhileStatement': [SK.WhileStatement],
	'DoWhileStatement': [SK.DoStatement],
	'ForStatement': [SK.ForStatement],
	'ForInStatement': [SK.ForInStatement],
	'ForOfStatement': [SK.ForOfStatement],
	'ReturnStatement': [SK.ReturnStatement],
	'ThrowStatement': [SK.ThrowStatement],
	'TryStatement': [SK.TryStatement],
	'CatchClause': [SK.CatchClause],
	'SwitchStatement': [SK.SwitchStatement],
	'SwitchCase': [SK.CaseClause, SK.DefaultClause],
	'BreakStatement': [SK.BreakStatement],
	'ContinueStatement': [SK.ContinueStatement],
	'LabeledStatement': [SK.LabeledStatement],
	'EmptyStatement': [SK.EmptyStatement],
	'DebuggerStatement': [SK.DebuggerStatement],
	'VariableDeclaration': [SK.VariableStatement],
	'VariableDeclarator': [SK.VariableDeclaration],
	'FunctionExpression': [SK.FunctionExpression],
	'ArrowFunctionExpression': [SK.ArrowFunction],
	'ClassDeclaration': [SK.ClassDeclaration],
	'ClassExpression': [SK.ClassExpression],
	'NewExpression': [SK.NewExpression],
	'MemberExpression': [SK.PropertyAccessExpression, SK.ElementAccessExpression],
	'ConditionalExpression': [SK.ConditionalExpression],
	'AwaitExpression': [SK.AwaitExpression],
	'YieldExpression': [SK.YieldExpression],
	'ThisExpression': [SK.ThisKeyword],
	'Super': [SK.SuperKeyword],
	'TemplateLiteral': [SK.TemplateExpression, SK.NoSubstitutionTemplateLiteral],
	'TaggedTemplateExpression': [SK.TaggedTemplateExpression],
	'Literal': [
		SK.NumericLiteral, SK.StringLiteral, SK.RegularExpressionLiteral,
		SK.BigIntLiteral, SK.NullKeyword, SK.TrueKeyword, SK.FalseKeyword,
	],
	'Identifier': [SK.Identifier],
	'PrivateIdentifier': [SK.PrivateIdentifier],
	'ImportDeclaration': [SK.ImportDeclaration],
	'ImportSpecifier': [SK.ImportSpecifier],
	'ImportNamespaceSpecifier': [SK.NamespaceImport],
	'ImportAttribute': [SK.ImportAttribute],
	'ExportSpecifier': [SK.ExportSpecifier],
	'Decorator': [SK.Decorator],
	'StaticBlock': [SK.ClassStaticBlockDeclaration],
	'MetaProperty': [SK.MetaProperty],
	'ClassBody': [SK.ClassDeclaration, SK.ClassExpression],
	// All TS leaf-keyword types — pure 1:1 with TS kinds.
	'TSAnyKeyword': [SK.AnyKeyword],
	'TSStringKeyword': [SK.StringKeyword],
	'TSNumberKeyword': [SK.NumberKeyword],
	'TSBooleanKeyword': [SK.BooleanKeyword],
	'TSBigIntKeyword': [SK.BigIntKeyword],
	'TSNullKeyword': [SK.NullKeyword],
	'TSUndefinedKeyword': [SK.UndefinedKeyword],
	'TSVoidKeyword': [SK.VoidKeyword],
	'TSNeverKeyword': [SK.NeverKeyword],
	'TSUnknownKeyword': [SK.UnknownKeyword],
	'TSObjectKeyword': [SK.ObjectKeyword],
	'TSSymbolKeyword': [SK.SymbolKeyword],
	'TSIntrinsicKeyword': [SK.IntrinsicKeyword],
	'TSThisType': [SK.ThisType],
	'TSAsExpression': [SK.AsExpression],
	'TSTypeAssertion': [SK.TypeAssertionExpression],
	'TSNonNullExpression': [SK.NonNullExpression],
	'TSSatisfiesExpression': [SK.SatisfiesExpression],
	'TSTypeReference': [SK.TypeReference],
	'TSUnionType': [SK.UnionType],
	'TSIntersectionType': [SK.IntersectionType],
	'TSArrayType': [SK.ArrayType],
	'TSTupleType': [SK.TupleType],
	'TSConditionalType': [SK.ConditionalType],
	'TSMappedType': [SK.MappedType],
	'TSIndexedAccessType': [SK.IndexedAccessType],
	'TSInferType': [SK.InferType],
	'TSTypeOperator': [SK.TypeOperator],
	'TSImportType': [SK.ImportType],
	'TSLiteralType': [SK.LiteralType],
	'TSFunctionType': [SK.FunctionType],
	'TSConstructorType': [SK.ConstructorType],
	'TSTemplateLiteralType': [SK.TemplateLiteralType],
	'TSTypePredicate': [SK.TypePredicate],
	'TSTypeLiteral': [SK.TypeLiteral],
	'TSQualifiedName': [SK.QualifiedName],
	'TSOptionalType': [SK.OptionalType],
	'TSRestType': [SK.RestType],
	'TSTypeParameter': [SK.TypeParameter],
	'TSInterfaceDeclaration': [SK.InterfaceDeclaration],
	'TSTypeAliasDeclaration': [SK.TypeAliasDeclaration],
	'TSEnumDeclaration': [SK.EnumDeclaration],
	'TSEnumMember': [SK.EnumMember],
	'TSModuleDeclaration': [SK.ModuleDeclaration],
	'TSImportEqualsDeclaration': [SK.ImportEqualsDeclaration],
	'TSExternalModuleReference': [SK.ExternalModuleReference],
	'TSNamespaceExportDeclaration': [SK.NamespaceExportDeclaration],
	'TSPropertySignature': [SK.PropertySignature],
	'TSMethodSignature': [SK.MethodSignature],
	'TSCallSignatureDeclaration': [SK.CallSignature],
	'TSConstructSignatureDeclaration': [SK.ConstructSignature],
	'TSIndexSignature': [SK.IndexSignature],
};

// Returns null if any of the requested ESTree types lacks a predicate —
// caller must fall back. Otherwise, returns a predicate that fires true
// for any ts.Node that materialises to one of the requested types.
//
// Fast path: when ALL requested types are simple kind matches (most are),
// build a Uint8Array bitmap indexed by ts.SyntaxKind and check
// `bitmap[node.kind]` per visit — single array access, faster than Set.has
// for the integer-keyed lookup.
const SK_BITMAP_SIZE = 400; // ts.SyntaxKind max is currently ~360; round up.
export function predicateForTriggerSet(estreeTypes: Iterable<string>): Predicate | null {
	const simpleBitmap = new Uint8Array(SK_BITMAP_SIZE);
	let simpleCount = 0;
	const conditional: Predicate[] = [];
	for (const t of estreeTypes) {
		if (!PREDICATES[t]) return null;
		const kinds = SIMPLE_KINDS[t];
		if (kinds) {
			for (const k of kinds) {
				if (!simpleBitmap[k]) { simpleBitmap[k] = 1; simpleCount++; }
			}
		} else {
			conditional.push(PREDICATES[t]);
		}
	}
	if (simpleCount === 0 && conditional.length === 0) return () => false;
	if (conditional.length === 0) {
		// Pure simple-kind path — bitmap[kind] is truthy when kind triggers.
		return n => simpleBitmap[n.kind] === 1;
	}
	if (simpleCount === 0) {
		// All conditional — no bitmap fast path.
		if (conditional.length === 1) return conditional[0];
		return n => {
			for (let i = 0; i < conditional.length; i++) if (conditional[i](n)) return true;
			return false;
		};
	}
	// Hybrid — bitmap hit short-circuits; otherwise try the conditionals.
	return n => {
		if (simpleBitmap[n.kind] === 1) return true;
		for (let i = 0; i < conditional.length; i++) if (conditional[i](n)) return true;
		return false;
	};
}

// Returns whether the given ESTree type has a TS predicate.
export function hasPredicate(estreeType: string): boolean {
	return PREDICATES[estreeType] !== undefined;
}

// Walks the TS AST in source order. For each ts.Node where `match`
// returns true, materialise its ESTree counterpart and emit
// VisitNodeStep enter/leave events around the recursive descent.
//
// This is a drop-in eventQueue producer for the existing dispatchFast
// loop in index.ts.
export function tsScanTraverse(
	source: ts.SourceFile,
	match: Predicate,
	materialize: (n: ts.Node) => unknown,
): unknown[] {
	const steps: unknown[] = [];
	const visit = (node: ts.Node): void => {
		const hit = match(node);
		let chain: unknown[] | null = null;
		if (hit) {
			chain = unwrapChain(materialize(node));
			// Outer-first enter (mirrors ESLint's pre-order: parent before children).
			for (let i = 0; i < chain.length; i++) {
				const t = chain[i];
				steps.push(new VisitNodeStep({ target: t, phase: 1, args: [t] }));
			}
		}
		tsForEachChild(node, visit);
		if (chain) {
			// Inner-first leave.
			for (let i = chain.length - 1; i >= 0; i--) {
				const t = chain[i];
				steps.push(new VisitNodeStep({ target: t, phase: 2, args: [t] }));
			}
		}
	};
	visit(source);
	return steps;
}

// Lazy-estree wraps certain materialised nodes:
//   - ExportNamedWrappingNode / ExportDefaultWrappingNode wrap an exported
//     declaration via `.declaration`. The wrapper's constructor overwrites
//     the inner's `tsNodeToESTreeNodeMap` entry, so `materialize()` on an
//     exported declaration's ts.Node returns the wrapper, not the inner.
//   - ChainExpressionWrappingNode wraps the outermost optional chain via
//     `.expression`.
//   - TSParameterPropertyNode wraps a class-constructor parameter
//     property (`constructor(public x)`) via `.parameter`.
//   - TSTypeQueryWrappingNode wraps a `typeof import('x')` TSImportType
//     via `.exprName` — only when the inner is a TSImportType (regular
//     `typeof X` doesn't have this nesting).
//
// ESLint's full walk fires enter/leave for every layer (the wrapper, then
// the inner). To match that, expand the materialised result into the full
// layer chain so dispatchFast can fire each listener it has registered.
function unwrapChain(node: unknown): unknown[] {
	const chain: unknown[] = [];
	let cur: unknown = node;
	while (cur) {
		chain.push(cur);
		const t = (cur as { type?: string }).type;
		if (t === 'ExportNamedDeclaration' || t === 'ExportDefaultDeclaration') {
			cur = (cur as { declaration?: unknown }).declaration;
		} else if (t === 'ChainExpression') {
			cur = (cur as { expression?: unknown }).expression;
		} else if (t === 'TSParameterProperty') {
			cur = (cur as { parameter?: unknown }).parameter;
		} else if (t === 'TSTypeQuery') {
			const inner = (cur as { exprName?: { type?: string } }).exprName;
			// Only the typeof-import wrapper case has TSImportType inside.
			if (inner && inner.type === 'TSImportType') {
				cur = inner;
			} else {
				break;
			}
		} else if (t === 'ClassDeclaration' || t === 'ClassExpression') {
			// Drill into the synthetic ClassBody child slot. ClassBody has
			// no own TS kind — it only exists as a wrapper around the
			// class's members. Adding it to the chain lets a ClassBody
			// listener fire between class enter and member visits.
			cur = (cur as { body?: unknown }).body;
		} else {
			break;
		}
	}
	return chain;
}
