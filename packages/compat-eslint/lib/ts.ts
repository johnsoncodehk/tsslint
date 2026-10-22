// The TypeScript surface compat-eslint is written against: the public
// TypeScript 7 AST module plus a few helpers the classic `typescript`
// namespace used to provide, rebuilt on top of the public node API.
import * as ast from 'typescript/ast';

export * from 'typescript/ast';

// TS 7 materializes nodes that have no source text of their own (JSDoc
// type annotations in JS files, the implicit `export` on the inner
// declarations of `namespace A.B {}`) and marks them `Reparsed`. ESTree
// has no counterpart for them, so every traversal here skips them.
export function isReparsed(node: ast.Node): boolean {
	return (node.flags & ast.NodeFlags.Reparsed) !== 0;
}

export function forEachChild<T>(
	node: ast.Node,
	cbNode: (node: ast.Node) => T,
	cbNodes?: (nodes: ast.NodeArray<ast.Node>) => T,
): T | undefined {
	return node.forEachChild(
		child => isReparsed(child) ? undefined : cbNode(child),
		cbNodes
			? nodes => cbNodes(nodes.some(isReparsed) ? filterNodeArray(nodes) : nodes)
			: undefined,
	);
}

function filterNodeArray<T extends ast.Node>(nodes: ast.NodeArray<T>): ast.NodeArray<T> {
	const filtered = nodes.filter(n => !isReparsed(n)) as T[] & { pos?: number; end?: number };
	filtered.pos = nodes.pos;
	filtered.end = nodes.end;
	return filtered as unknown as ast.NodeArray<T>;
}

export function getModifierLikes(node: ast.Node): readonly ast.ModifierLike[] | undefined {
	const modifiers = (node as { modifiers?: ast.NodeArray<ast.ModifierLike> }).modifiers;
	if (!modifiers?.length) return undefined;
	return modifiers.some(isReparsed) ? modifiers.filter(m => !isReparsed(m)) : modifiers;
}

export function getModifiers(node: ast.Node): ast.Modifier[] | undefined {
	const modifiers = getModifierLikes(node);
	if (!modifiers) return undefined;
	const result = modifiers.filter((m): m is ast.Modifier => m.kind !== ast.SyntaxKind.Decorator);
	return result.length ? result : undefined;
}

export function getDecorators(node: ast.Node): ast.Decorator[] | undefined {
	const modifiers = getModifierLikes(node);
	if (!modifiers) return undefined;
	const result = modifiers.filter(ast.isDecorator);
	return result.length ? result : undefined;
}

export function hasQuestionToken(node: { postfixToken?: ast.Node }): boolean {
	return node.postfixToken?.kind === ast.SyntaxKind.QuestionToken;
}

export function hasExclamationToken(node: { postfixToken?: ast.Node }): boolean {
	return node.postfixToken?.kind === ast.SyntaxKind.ExclamationToken;
}

// `declare global {}` is a ModuleDeclaration whose name is the identifier
// `global` with no `module`/`namespace` keyword written before it.
export function isGlobalAugmentation(node: ast.ModuleDeclaration, sourceText: string): boolean {
	if (node.name.kind !== ast.SyntaxKind.Identifier || node.name.text !== 'global') return false;
	const modifiers = getModifierLikes(node);
	const before = modifiers ? modifiers[modifiers.length - 1].end : node.pos;
	return sourceText.slice(before, node.name.getStart()).trim() === '';
}

// `implements Foo<T>` parses as a TypeReference in TS 7; `extends Foo<T>`
// stays an ExpressionWithTypeArguments.
export function heritageElementExpression(element: ast.HeritageClauseElement): ast.Node {
	return element.kind === ast.SyntaxKind.TypeReference ? element.typeName : element.expression;
}

export function isTypeOnlyImportClause(clause: ast.ImportClause | undefined): boolean {
	return clause?.phaseModifier === ast.SyntaxKind.TypeKeyword;
}

// A TypeReference that is really a heritage clause element
// (`interface I extends A.B<T>`, `class C implements A.B<T>`).
export function isHeritageTypeReference(node: ast.Node): node is ast.TypeReferenceNode {
	return node.kind === ast.SyntaxKind.TypeReference && node.parent?.kind === ast.SyntaxKind.HeritageClause;
}

// A QualifiedName in the entity name of a heritage TypeReference.
// typescript-estree reads heritage elements as expressions, so these
// surface as MemberExpressions rather than TSQualifiedNames.
export function isHeritageQualifiedName(node: ast.Node): node is ast.QualifiedName {
	if (node.kind !== ast.SyntaxKind.QualifiedName) return false;
	let current = node;
	while (current.parent?.kind === ast.SyntaxKind.QualifiedName) current = current.parent;
	return !!current.parent && isHeritageTypeReference(current.parent);
}
