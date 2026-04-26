// Token / comment converters mirroring @typescript-eslint/typescript-estree's
// `convertTokens` (node-utils.ts) and `convertComments` (convert-comments.ts).
// Driven directly off ts.SourceFile so we don't need typescript-estree's
// astConverter machinery — only the leaf-token walk and ts.Scanner.
//
// Output shape matches ESTree's `Token` / `Comment` exactly: every rule that
// reads `sourceCode.tokens` / `sourceCode.comments` / `getTokenAfter` /
// `getTokenBefore` etc. gets the same data ESLint+typescript-estree would
// produce.

import * as ts from 'typescript';

const SK = ts.SyntaxKind;

export type TokenType =
	| 'Boolean' | 'Null' | 'Identifier' | 'Keyword' | 'Numeric' | 'Punctuator'
	| 'String' | 'RegularExpression' | 'Template' | 'JSXText' | 'JSXIdentifier'
	| 'PrivateIdentifier';

export interface Token {
	type: TokenType;
	value: string;
	range: [number, number];
	loc: { start: { line: number; column: number }; end: { line: number; column: number } };
	regex?: { pattern: string; flags: string };
}

export interface Comment {
	type: 'Line' | 'Block';
	value: string;
	range: [number, number];
	loc: { start: { line: number; column: number }; end: { line: number; column: number } };
}

function getLineAndCharacter(pos: number, ast: ts.SourceFile) {
	const lc = ast.getLineAndCharacterOfPosition(pos);
	return { line: lc.line + 1, column: lc.character };
}
function getLocFor(range: [number, number], ast: ts.SourceFile) {
	return { start: getLineAndCharacter(range[0], ast), end: getLineAndCharacter(range[1], ast) };
}

function isToken(node: ts.Node): boolean {
	return node.kind >= SK.FirstToken && node.kind <= SK.LastToken;
}
function isComment(node: ts.Node): boolean {
	return node.kind === SK.SingleLineCommentTrivia || node.kind === SK.MultiLineCommentTrivia;
}
function isJSDocComment(node: ts.Node): boolean {
	// JSDocComment was added in TS 4.7; alias as JSDoc for older versions.
	return node.kind === SK.JSDocComment || (node as { kind: number }).kind === (SK as unknown as { JSDoc?: number }).JSDoc;
}
function isJSXToken(node: ts.Node): boolean {
	return node.kind >= SK.JsxElement && node.kind <= SK.JsxAttribute;
}
function hasJSXAncestor(node: ts.Node): boolean {
	let p: ts.Node | undefined = node.parent;
	while (p) {
		if (isJSXToken(p)) return true;
		p = p.parent;
	}
	return false;
}

// Mirrors typescript-estree's getTokenType (node-utils.ts:410). The branches
// follow the source order — same fall-through structure for the two Identifier
// JSX checks. Keep in sync if upstream adds new SyntaxKind classifications.
function getTokenType(token: ts.Node): TokenType {
	if (token.kind === SK.NullKeyword) return 'Null';
	if (token.kind >= SK.FirstKeyword && token.kind <= SK.LastFutureReservedWord) {
		if (token.kind === SK.FalseKeyword || token.kind === SK.TrueKeyword) return 'Boolean';
		return 'Keyword';
	}
	if (token.kind >= SK.FirstPunctuation && token.kind <= SK.LastPunctuation) return 'Punctuator';
	if (token.kind >= SK.NoSubstitutionTemplateLiteral && token.kind <= SK.TemplateTail) return 'Template';
	switch (token.kind) {
		case SK.NumericLiteral:
		case SK.BigIntLiteral:
			return 'Numeric';
		case SK.PrivateIdentifier:
			return 'PrivateIdentifier';
		case SK.JsxText:
			return 'JSXText';
		case SK.StringLiteral:
			if (token.parent && (token.parent.kind === SK.JsxAttribute || token.parent.kind === SK.JsxElement)) {
				return 'JSXText';
			}
			return 'String';
		case SK.RegularExpressionLiteral:
			return 'RegularExpression';
	}
	if (token.kind === SK.Identifier) {
		if (token.parent && isJSXToken(token.parent)) return 'JSXIdentifier';
		if (token.parent?.kind === SK.PropertyAccessExpression && hasJSXAncestor(token)) {
			return 'JSXIdentifier';
		}
	}
	return 'Identifier';
}

function convertToken(token: ts.Node, ast: ts.SourceFile): Token {
	const start = token.kind === SK.JsxText ? token.getFullStart() : token.getStart(ast);
	const end = token.getEnd();
	const value = ast.text.slice(start, end);
	const tokenType = getTokenType(token);
	const range: [number, number] = [start, end];
	const loc = getLocFor(range, ast);
	if (tokenType === 'RegularExpression') {
		const lastSlash = value.lastIndexOf('/');
		return {
			type: tokenType,
			loc, range,
			regex: { flags: value.slice(lastSlash + 1), pattern: value.slice(1, lastSlash) },
			value,
		};
	}
	if (tokenType === 'PrivateIdentifier') {
		// ESLint's PrivateIdentifier token strips the leading `#`.
		return { type: tokenType, loc, range, value: value.slice(1) };
	}
	return { type: tokenType, loc, range, value };
}

// Walk the AST, picking up every leaf token. ts.Node has no built-in iterator
// over child tokens — `getChildren(ast)` returns both ts.Node children AND
// the boundary tokens (`;`, `=`, …) that don't appear in `forEachChild`. We
// recurse manually, skipping the EOF sentinel and any comment-trivia subtrees
// (the latter only show up under JSDoc-bearing nodes).
export function convertTokens(ast: ts.SourceFile): Token[] {
	const result: Token[] = [];
	const walk = (node: ts.Node): void => {
		if (isComment(node) || isJSDocComment(node)) return;
		if (isToken(node) && node.kind !== SK.EndOfFileToken) {
			result.push(convertToken(node, ast));
			return;
		}
		const children = node.getChildren(ast);
		for (let i = 0; i < children.length; i++) walk(children[i]);
	};
	walk(ast);
	return result;
}

// Comments: walk each token once (same recursion as `convertTokens`, but
// without skipping JSDoc subtrees so trivia inside them is reachable) and
// collect both leading and trailing comment ranges via TS's helpers. A naive
// `createScanner(skipTrivia=false)` walk misses comments hidden inside
// JSDoc / template / type-annotation spans — `forEachLeading/TrailingCommentRange`
// is what typescript-estree uses (via ts-api-utils.iterateComments).
export function convertComments(ast: ts.SourceFile): Comment[] {
	const out: Comment[] = [];
	const text = ast.text;
	const seen = new Set<number>(); // dedupe by start position
	const collect = (pos: number, end: number, kind: ts.CommentKind): void => {
		if (seen.has(pos)) return;
		seen.add(pos);
		const isLine = kind === SK.SingleLineCommentTrivia;
		const raw = text.slice(pos, end);
		const value = isLine ? raw.slice(2) : raw.slice(2, -2);
		const range: [number, number] = [pos, end];
		out.push({ type: isLine ? 'Line' : 'Block', value, range, loc: getLocFor(range, ast) });
	};
	const shebang = ts.getShebang(text) ?? '';
	const visitToken = (token: ts.Node): void => {
		if (token.pos === token.end) return;
		// Leading: ts.forEachLeadingCommentRange skips its starting offset's
		// comment if we don't pass past the shebang (scanner treats it as
		// trivia at position 0 only).
		const startPos = token.pos === 0 ? shebang.length : token.pos;
		ts.forEachLeadingCommentRange(text, startPos, collect);
		ts.forEachTrailingCommentRange(text, token.end, collect);
	};
	const walk = (node: ts.Node): void => {
		if (isComment(node)) return;
		if (isToken(node)) {
			visitToken(node);
			return;
		}
		const children = node.getChildren(ast);
		for (let i = 0; i < children.length; i++) walk(children[i]);
	};
	walk(ast);
	out.sort((a, b) => a.range[0] - b.range[0]);
	return out;
}
