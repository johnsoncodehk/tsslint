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
	return buildToken(token, start, end, ast);
}

function buildToken(token: ts.Node, start: number, end: number, ast: ts.SourceFile): Token {
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

// Walk the AST emitting every leaf token + the punctuator trivia tokens
// (`;` / `,` / `=` / `(` / `)` / `{` / `}` / etc.) that sit between AST
// siblings. `forEachChild` visits AST children but skips these inter-child
// punctuators (they're not standalone AST nodes). The earlier impl used
// `node.getChildren(ast)` to surface them, but `getChildren` lazily runs
// `ts.Scanner` over each non-leaf node's full range — overlapping ranges
// at every nesting level had `convertTokens` dominated by repeated scanner
// work (~75% of `computeLineAndCharacterOfPosition` ticks per the CPU
// profile, gap-filled by `ts.Scanner.scan` frames in the timeline).
//
// Replace with one linear scanner sweep keyed by `forEachChild` walk
// position. Scanner advances monotonically through the file, emitting
// tokens between AST leaves; total scanner work = O(file_size), not
// O(file_size × tree_depth).
export function convertTokens(ast: ts.SourceFile): Token[] {
	const result: Token[] = [];
	const text = ast.text;
	const scanner = ts.createScanner(
		ast.languageVersion,
		/*skipTrivia*/ true,
		ast.languageVariant,
	);
	scanner.setText(text);
	let pos = 0;

	function emitScanned(targetEnd: number): void {
		while (pos < targetEnd) {
			scanner.setTextPos(pos);
			const k = scanner.scan();
			if (k === SK.EndOfFileToken) break;
			const start = scanner.getTokenStart();
			if (start >= targetEnd) break;
			pos = scanner.getTokenEnd();
			// Build via buildToken with explicit start/end (synthetic
			// POJO has no ts.Node methods like getStart/getEnd). Parent
			// context isn't available for trivia tokens, but the only
			// classifications that depend on parent (JSX*) don't apply
			// to punctuators / keywords sitting between AST nodes.
			const synthetic: ts.Node = { kind: k, pos: start, end: pos } as ts.Node;
			result.push(buildToken(synthetic, start, pos, ast));
		}
		if (pos < targetEnd) pos = targetEnd;
	}

	const walk = (node: ts.Node): void => {
		if (isComment(node) || isJSDocComment(node)) return;
		const nodeStart = node.kind === SK.JsxText ? node.getFullStart() : node.getStart(ast);
		// Scanner sweeps through trivia / punctuators preceding this node.
		emitScanned(nodeStart);
		if (isToken(node) && node.kind !== SK.EndOfFileToken) {
			result.push(convertToken(node, ast));
			pos = node.getEnd();
			return;
		}
		ts.forEachChild(node, walk);
	};
	walk(ast);
	// Trailing punctuators (e.g. final `;` after the last statement).
	emitScanned(ast.end);
	return result;
}

// Comments: AST-driven gap scan.
//
// Every comment in the source sits in some "trivia gap" — the bytes
// between two adjacent ts.Nodes (or between a node's last child and its
// own end). The AST is already parsed, so we know exactly where every
// gap is; for each one, `ts.forEachLeadingCommentRange(text, prevEnd)`
// scans forward through whitespace + comments and stops at the next
// non-trivia character (which is either the next sibling's start or
// the parent's closing punctuator). That single scan call emits every
// comment in the gap exactly once, no dedupe needed.
//
// Why this works where a whole-file `skipTrivia:false` scanner sweep
// drifts: scanner mode transitions (template `${}`, regex `/`, JSX `<`)
// only happen across non-trivia tokens. Inside a trivia gap there's
// only whitespace + `//`/`/*` — no mode changes possible, no drift
// possible. By delegating gap iteration to TS's `iterateCommentRanges`
// (which is mode-stateless and stops on the first non-trivia char) we
// get the only-source-truth correctness of an AST walk plus the cheap
// linear-scan speed of a comment-only iterator.
//
// This avoids three things the previous `getChildren` +
// `forEachLeading/TrailingCommentRange` per-leaf walk paid for:
//   1. `getChildren()` lazily ran ts.Scanner over each non-leaf range
//      (overlapping at every nesting level) just to materialise child
//      tokens; `forEachChild` is pure AST traversal.
//   2. Each leaf paid a leading + trailing scan, with the trailing of
//      one leaf scanning the same trivia bytes as the leading of the
//      next — covered by a `seen` Set dedupe.
//   3. The result needed sorting because trailing-then-next-leading
//      ordering wasn't guaranteed monotonic.
// The new pass produces output already sorted by range[0] and never
// scans the same byte twice.
// Trivia gap layout (each ts.Node `n`):
//   n.pos                  ← fullStart (leading trivia of `n`)
//   ... leading trivia ...
//   n.getStart()           ← first non-trivia char of `n`
//   ... n's open token ...
//   firstChildOrTail.pos   ← either firstChild.pos OR n.end
//   ... children + sibling gaps ...
//   lastChild.end
//   ... inner trailing trivia ...
//   n.end                  ← past close token
//
// `child.pos === prevSibling.end` (TS invariant), so each child's
// leading trivia covers everything between the previous content and
// that child's first non-trivia char. `walkInnerCommentsOf` scans
// every sibling gap (= every non-first child's leading) and every
// node's "tail" (between last child end and node.end), but
// intentionally skips the FIRST child's leading: that range is
// identical to the node's own leading and the caller (= node's
// parent's per-child gap scan) is responsible for it.
//
// Tail handling has three cases:
//   - leaf (isToken): no inner trivia possible, skip.
//   - non-leaf with children: tail starts at lastChild.end.
//   - non-leaf without children (empty `{ /* a */ }`, empty array,
//     etc.): need inner-start position past the open token. Lex
//     one token from `node.getStart()` to find it. Empty containers
//     are rare, so the scanner cost is bounded.
//
// Per-gap scanning runs `forEachTrailingCommentRange`
// (covers same-line comments after `scanFrom`, stops at first
// newline) followed by `forEachLeadingCommentRange` (covers comments
// after the first newline; `collecting` starts false so same-line
// ones are skipped). The two emit sets are complementary — no dedupe
// needed. `pos === 0` is a special case for leading: it sets
// `collecting = true` upfront, so we skip the trailing pass to avoid
// double-emit at the file head.
//
// Helper exported so `LazySourceCode.getCommentsInside` can drive the
// same per-node walk without touching the full `convertComments`
// array.
export function walkInnerCommentsOf(
	node: ts.Node,
	ast: ts.SourceFile,
	scanner: ts.Scanner,
	emitCommentsFrom: (scanFrom: number) => void,
): void {
	if (isComment(node) || isJSDocComment(node)) return;
	if (isToken(node) && node.kind !== SK.EndOfFileToken) return;
	let firstSeen = false;
	let lastEnd = -1;
	ts.forEachChild(node, child => {
		if (firstSeen) {
			emitCommentsFrom(child.pos);
		}
		firstSeen = true;
		walkInnerCommentsOf(child, ast, scanner, emitCommentsFrom);
		lastEnd = child.end;
	});
	let tailFrom: number;
	if (lastEnd >= 0) {
		tailFrom = lastEnd;
	}
	else {
		const start = node.getStart(ast);
		if (start >= node.end) return;
		scanner.setTextPos(start);
		scanner.scan();
		tailFrom = scanner.getTokenEnd();
	}
	if (tailFrom < node.end) {
		emitCommentsFrom(tailFrom);
	}
}

export function buildCommentObject(text: string, pos: number, end: number, kind: ts.CommentKind, ast: ts.SourceFile): Comment {
	const isLine = kind === SK.SingleLineCommentTrivia;
	const raw = text.slice(pos, end);
	const value = isLine ? raw.slice(2) : raw.slice(2, -2);
	const range: [number, number] = [pos, end];
	return { type: isLine ? 'Line' : 'Block', value, range, loc: getLocFor(range, ast) };
}

export function convertComments(ast: ts.SourceFile): Comment[] {
	const out: Comment[] = [];
	const text = ast.text;
	const shebangLen = (ts.getShebang(text) ?? '').length;
	const collect = (pos: number, end: number, kind: ts.CommentKind): void => {
		out.push(buildCommentObject(text, pos, end, kind, ast));
	};
	const scanner = ts.createScanner(
		ast.languageVersion,
		/*skipTrivia*/ true,
		ast.languageVariant,
	);
	scanner.setText(text);
	const emitCommentsFrom = (scanFrom: number): void => {
		if (scanFrom > 0) {
			ts.forEachTrailingCommentRange(text, scanFrom, collect);
		}
		ts.forEachLeadingCommentRange(text, scanFrom, collect);
	};
	// SourceFile has no parent to emit its leading trivia for it; do
	// it once here so the file-header comments aren't lost when the
	// walk skips ast's first child's leading scan (= same range).
	emitCommentsFrom(shebangLen);
	walkInnerCommentsOf(ast, ast, scanner, emitCommentsFrom);
	return out;
}
