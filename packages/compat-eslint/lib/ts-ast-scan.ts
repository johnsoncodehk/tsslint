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
//
// Limitation: the predicate table must cover every ESTree type a rule
// could trigger on. Caller probes via `predicateFor()`; if any trigger
// type lacks a predicate, falls back to the existing selectorAware path.

import * as ts from 'typescript';

const SK = ts.SyntaxKind;

// VisitNodeStep constructor (re-resolved here so this module doesn't
// depend on the index.ts wiring).
const pluginKitPath = require.resolve('@eslint/plugin-kit', {
	paths: [require.resolve('eslint/package.json')],
});
const { VisitNodeStep } = require(pluginKitPath) as {
	VisitNodeStep: new (init: { target: unknown; phase: 1 | 2; args: unknown[] }) => unknown;
};

type Predicate = (n: ts.Node) => boolean;

// Pre-compiled binary-operator buckets — typescript-estree splits a single
// `BinaryExpression` TS kind into BinaryExpression / LogicalExpression /
// AssignmentExpression based on `operatorToken.kind`. Predicates for these
// three need to filter accordingly.
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
	'FunctionExpression': n => n.kind === SK.FunctionExpression,
	'ArrowFunctionExpression': n => n.kind === SK.ArrowFunction,
	'ClassDeclaration': n => n.kind === SK.ClassDeclaration,
	'ClassExpression': n => n.kind === SK.ClassExpression,
	'MethodDefinition': n => (
		n.kind === SK.MethodDeclaration || n.kind === SK.Constructor
		|| n.kind === SK.GetAccessor || n.kind === SK.SetAccessor
	) && n.parent?.kind !== SK.ObjectLiteralExpression,
	'PropertyDefinition': n => n.kind === SK.PropertyDeclaration,

	// --- Expressions ---------------------------------------------------
	'BinaryExpression': n => n.kind === SK.BinaryExpression
		&& !LOGICAL_OPS.has((n as ts.BinaryExpression).operatorToken.kind)
		&& !ASSIGN_OPS.has((n as ts.BinaryExpression).operatorToken.kind),
	'LogicalExpression': n => n.kind === SK.BinaryExpression
		&& LOGICAL_OPS.has((n as ts.BinaryExpression).operatorToken.kind),
	'AssignmentExpression': n => n.kind === SK.BinaryExpression
		&& ASSIGN_OPS.has((n as ts.BinaryExpression).operatorToken.kind),
	'UnaryExpression': n => n.kind === SK.PrefixUnaryExpression
		&& isUnaryOp((n as ts.PrefixUnaryExpression).operator),
	'UpdateExpression': n => (n.kind === SK.PrefixUnaryExpression
		&& isUpdateOp((n as ts.PrefixUnaryExpression).operator))
		|| n.kind === SK.PostfixUnaryExpression,
	'CallExpression': n => n.kind === SK.CallExpression,
	'NewExpression': n => n.kind === SK.NewExpression,
	'MemberExpression': n => n.kind === SK.PropertyAccessExpression || n.kind === SK.ElementAccessExpression,
	'ConditionalExpression': n => n.kind === SK.ConditionalExpression,
	'AwaitExpression': n => n.kind === SK.AwaitExpression,
	'YieldExpression': n => n.kind === SK.YieldExpression,
	'ThisExpression': n => n.kind === SK.ThisKeyword,
	'Super': n => n.kind === SK.SuperKeyword,
	'TemplateLiteral': n => n.kind === SK.TemplateExpression || n.kind === SK.NoSubstitutionTemplateLiteral,
	'TaggedTemplateExpression': n => n.kind === SK.TaggedTemplateExpression,
	'SpreadElement': n => n.kind === SK.SpreadElement || n.kind === SK.SpreadAssignment,

	// --- Literals (typescript-estree collapses many TS kinds → Literal) -
	'Literal': n =>
		n.kind === SK.NumericLiteral
		|| n.kind === SK.StringLiteral
		|| n.kind === SK.RegularExpressionLiteral
		|| n.kind === SK.BigIntLiteral
		|| n.kind === SK.NullKeyword
		|| n.kind === SK.TrueKeyword
		|| n.kind === SK.FalseKeyword,

	// --- Identifiers ---------------------------------------------------
	'Identifier': n => n.kind === SK.Identifier,
	'PrivateIdentifier': n => n.kind === SK.PrivateIdentifier,

	// --- Object/Array literals + patterns ------------------------------
	// These predicates can't distinguish "literal" vs "pattern" without
	// ancestor context; covering both shapes would require a side-channel.
	// Skip them in v1 — falls back to selectorAware traverse.

	// --- Imports / Exports --------------------------------------------
	'ImportDeclaration': n => n.kind === SK.ImportDeclaration,
	'ImportSpecifier': n => n.kind === SK.ImportSpecifier,
	'ImportDefaultSpecifier': n => n.kind === SK.ImportClause,
	'ImportNamespaceSpecifier': n => n.kind === SK.NamespaceImport,
	'ImportAttribute': n => n.kind === SK.ImportAttribute,
	'ExportSpecifier': n => n.kind === SK.ExportSpecifier,

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

	// --- TS type composites (1:1) -------------------------------------
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
	'TSTypeQuery': n => n.kind === SK.TypeQuery,
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

	// --- TS declarations (1:1) ----------------------------------------
	'TSInterfaceDeclaration': n => n.kind === SK.InterfaceDeclaration,
	'TSTypeAliasDeclaration': n => n.kind === SK.TypeAliasDeclaration,
	'TSEnumDeclaration': n => n.kind === SK.EnumDeclaration,
	'TSEnumMember': n => n.kind === SK.EnumMember,
	'TSModuleDeclaration': n => n.kind === SK.ModuleDeclaration,
	'TSImportEqualsDeclaration': n => n.kind === SK.ImportEqualsDeclaration,
	'TSExportAssignment': n => n.kind === SK.ExportAssignment,
	'TSExternalModuleReference': n => n.kind === SK.ExternalModuleReference,
	'TSNamespaceExportDeclaration': n => n.kind === SK.NamespaceExportDeclaration,

	// --- TS interface members ------------------------------------------
	'TSPropertySignature': n => n.kind === SK.PropertySignature,
	'TSMethodSignature': n => n.kind === SK.MethodSignature,
	'TSCallSignatureDeclaration': n => n.kind === SK.CallSignature,
	'TSConstructSignatureDeclaration': n => n.kind === SK.ConstructSignature,
	'TSIndexSignature': n => n.kind === SK.IndexSignature,
};

function isUnaryOp(op: ts.SyntaxKind): boolean {
	return op === SK.PlusToken
		|| op === SK.MinusToken
		|| op === SK.TildeToken
		|| op === SK.ExclamationToken;
}

function isUpdateOp(op: ts.SyntaxKind): boolean {
	return op === SK.PlusPlusToken || op === SK.MinusMinusToken;
}

// Returns null if any of the requested ESTree types lacks a predicate —
// caller must fall back. Otherwise, returns a predicate that fires true
// for any ts.Node that materialises to one of the requested types.
export function predicateForTriggerSet(estreeTypes: Iterable<string>): Predicate | null {
	const preds: Predicate[] = [];
	for (const t of estreeTypes) {
		const p = PREDICATES[t];
		if (!p) return null;
		preds.push(p);
	}
	if (preds.length === 0) return () => false;
	if (preds.length === 1) return preds[0];
	return n => {
		for (let i = 0; i < preds.length; i++) {
			if (preds[i](n)) return true;
		}
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
		let estreeNode: unknown = null;
		if (hit) {
			estreeNode = materialize(node);
			steps.push(new VisitNodeStep({ target: estreeNode, phase: 1, args: [estreeNode] }));
		}
		ts.forEachChild(node, visit);
		if (hit) {
			steps.push(new VisitNodeStep({ target: estreeNode, phase: 2, args: [estreeNode] }));
		}
	};
	visit(source);
	return steps;
}
