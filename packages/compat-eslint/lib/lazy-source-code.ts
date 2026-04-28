// A self-contained `SourceCode` replacement for the compat-eslint pipeline.
//
// ESLint's `SourceCode` constructor does ~5 chunks of eager work that we
// don't need until (and unless) a rule actually queries them — and on the
// TypeScript repo profile they account for ~30 MB heap and ~3 % wall:
//
//  - `createIndexMap(tokens, comments)` (TokenStore)         28 MB heap
//  - `text.split(linebreak)` building `lines`                10–20 MB heap
//  - `lineStartIndices = [...]` (duplicates ts.SourceFile)
//  - `sortedMerge(tokens, comments)` building tokensAndComments
//  - shebang regex match across the whole text
//
// Plus the entire `Object.freeze(this)` graph that follows.
//
// Strategy: provide every public method ESLint rules call on `sourceCode`,
// driven off lazy `_*` fields. Token / comment queries use binary search
// directly over the (already sorted) `ast.tokens` / `ast.comments` arrays
// rather than maintaining an `indexMap`. Position lookups (`getLocFromIndex`,
// `getIndexFromLoc`) reuse `ts.SourceFile`'s lineMap — same data ESLint's
// `lineStartIndices` would hold, computed once by the TS scanner already.
//
// API surface mirrors what ESLint rules actually read (counted via grep on
// eslint/lib/rules + @typescript-eslint plugin rules — all methods with
// non-zero use sites are implemented). If a future rule reaches for a
// method that's missing here, throw a clear error rather than silently
// returning undefined.

import * as ts from 'typescript';
import { buildCommentObject, walkInnerCommentsOf } from './tokens';

const SK = ts.SyntaxKind;

// ─── Types ──────────────────────────────────────────────────────────────────

interface Loc {
	line: number;
	column: number;
}
interface SourceLoc {
	start: Loc;
	end: Loc;
}

interface Token {
	type: string;
	value: string;
	range: [number, number];
	loc: SourceLoc;
}
interface Comment {
	type: 'Line' | 'Block' | 'Shebang';
	value: string;
	range: [number, number];
	loc: SourceLoc;
}
type AnyToken = Token | Comment;

// ESLint's `getTokenBefore` etc. accept three option shapes:
//   - a number (treated as `{ skip: n }`)
//   - a function (treated as `{ filter: fn }`)
//   - an object with any of `{ skip, filter, includeComments, count }`
type TokenFilter = (token: AnyToken) => boolean;
type TokenOption =
	| number
	| TokenFilter
	| {
		skip?: number;
		filter?: TokenFilter;
		includeComments?: boolean;
		count?: number;
	}
	| undefined
	| null;

interface NormOpts {
	skip: number;
	filter: TokenFilter | null;
	includeComments: boolean;
	count: number; // -1 = unlimited
}

function normOpts(options: TokenOption): NormOpts {
	if (options == null) return { skip: 0, filter: null, includeComments: false, count: -1 };
	if (typeof options === 'number') return { skip: options, filter: null, includeComments: false, count: -1 };
	if (typeof options === 'function') return { skip: 0, filter: options, includeComments: false, count: -1 };
	return {
		skip: options.skip ?? 0,
		filter: options.filter ?? null,
		includeComments: !!options.includeComments,
		count: options.count == null ? -1 : options.count,
	};
}

interface NodeOrTokenLike {
	range: [number, number];
	type?: string;
	loc?: SourceLoc;
}

// ─── Binary searches over a sorted token/comment array ──────────────────────

// Returns the index of the first token whose `range[0]` is >= `loc`.
// If none, returns `tokens.length`.
function searchFirstAtOrAfter(tokens: AnyToken[], loc: number): number {
	let lo = 0;
	let hi = tokens.length;
	while (lo < hi) {
		const mid = (lo + hi) >>> 1;
		if (tokens[mid].range[0] < loc) lo = mid + 1;
		else hi = mid;
	}
	return lo;
}

// Returns the index of the last token whose `range[1]` is <= `loc`.
// If none, returns -1.
function searchLastEndingAtOrBefore(tokens: AnyToken[], loc: number): number {
	let lo = 0;
	let hi = tokens.length;
	while (lo < hi) {
		const mid = (lo + hi) >>> 1;
		if (tokens[mid].range[1] <= loc) lo = mid + 1;
		else hi = mid;
	}
	return lo - 1;
}

// ─── LazySourceCode ─────────────────────────────────────────────────────────

interface LazyConfig {
	text: string;
	ast: any; // LazyESTree Program
	tsFile: ts.SourceFile;
	scopeManager: any;
	parserServices: any;
	visitorKeys: any;
}

export class LazySourceCode {
	readonly text: string;
	readonly ast: any;
	readonly scopeManager: any;
	readonly parserServices: any;
	readonly visitorKeys: any;
	readonly hasBOM: boolean;
	readonly isESTree: boolean = true;

	private readonly _tsFile: ts.SourceFile;

	private _tokens?: Token[];
	private _comments?: Comment[];
	private _tokensAndComments?: AnyToken[];
	private _lines?: string[];
	private _lineStartIndices?: number[];
	private _scopeCache?: WeakMap<object, any>;

	constructor(config: LazyConfig) {
		this.text = config.text;
		this.ast = config.ast;
		this._tsFile = config.tsFile;
		this.scopeManager = config.scopeManager ?? null;
		this.parserServices = config.parserServices ?? {};
		this.visitorKeys = config.visitorKeys;
		this.hasBOM = config.text.charCodeAt(0) === 0xfeff;
	}

	// ─── Lazy collections ──────────────────────────────────────────────────

	get tokens(): Token[] {
		return this._tokens ??= this.ast.tokens;
	}
	get comments(): Comment[] {
		return this._comments ??= this.ast.comments;
	}
	get tokensAndComments(): AnyToken[] {
		return this._tokensAndComments ??= mergeSorted(this.tokens, this.comments);
	}

	get lineStartIndices(): number[] {
		// ts.SourceFile.getLineStarts() returns the same data ESLint's
		// `lineStartIndices` holds (offset of each 1-indexed line). The TS
		// scanner already built it during parse; reusing it here saves a
		// full-text regex split.
		return this._lineStartIndices ??= Array.from(this._tsFile.getLineStarts());
	}

	get lines(): string[] {
		if (this._lines) return this._lines;
		const text = this.text;
		const starts = this.lineStartIndices;
		const out: string[] = new Array(starts.length);
		for (let i = 0; i < starts.length - 1; i++) {
			// ESLint's `lines[i]` excludes the trailing line break. Walk
			// back from the next line's start to drop \n and optional
			// preceding \r.
			let end = starts[i + 1];
			if (end > starts[i] && text.charCodeAt(end - 1) === 0x0a) end--;
			if (end > starts[i] && text.charCodeAt(end - 1) === 0x0d) end--;
			out[i] = text.slice(starts[i], end);
		}
		out[starts.length - 1] = text.slice(starts[starts.length - 1]);
		return this._lines = out;
	}

	// ─── Text / lines ──────────────────────────────────────────────────────

	getText(node?: NodeOrTokenLike, beforeCount = 0, afterCount = 0): string {
		if (!node) return this.text;
		const start = Math.max(0, node.range[0] - beforeCount);
		const end = Math.min(this.text.length, node.range[1] + afterCount);
		return this.text.slice(start, end);
	}

	getLines(): string[] {
		return this.lines;
	}

	// ─── Position conversions ──────────────────────────────────────────────

	getLocFromIndex(index: number): Loc {
		if (typeof index !== 'number') throw new TypeError('Expected `index` to be a number.');
		if (index < 0 || index > this.text.length) {
			throw new RangeError(
				`Index out of range (requested index ${index}, but source text has length ${this.text.length}).`,
			);
		}
		// `ast.getLineAndCharacterOfPosition(index)` returns 0-indexed
		// line/col; ESLint's loc convention is 1-indexed line, 0-indexed
		// column. End-of-text edge case mirrors ESLint's behaviour.
		if (index === this.text.length) {
			const lines = this.lines;
			return { line: lines.length, column: lines[lines.length - 1].length };
		}
		const lc = this._tsFile.getLineAndCharacterOfPosition(index);
		return { line: lc.line + 1, column: lc.character };
	}

	getIndexFromLoc(loc: Loc): number {
		if (loc == null || typeof loc !== 'object') throw new TypeError('Expected `loc` to be an object.');
		if (typeof loc.line !== 'number' || typeof loc.column !== 'number') {
			throw new TypeError('Expected `loc` to have numeric `line` and `column` properties.');
		}
		const starts = this.lineStartIndices;
		if (loc.line < 1 || loc.line > starts.length) {
			throw new RangeError(`Line ${loc.line} out of range.`);
		}
		const lineStart = starts[loc.line - 1];
		const lineEnd = loc.line < starts.length ? starts[loc.line] : this.text.length + 1;
		const idx = lineStart + loc.column;
		if (idx < lineStart || idx >= lineEnd) {
			throw new RangeError(`Column ${loc.column} out of range on line ${loc.line}.`);
		}
		return idx;
	}

	getLoc(nodeOrToken: NodeOrTokenLike): SourceLoc | undefined {
		return nodeOrToken.loc;
	}
	getRange(nodeOrToken: NodeOrTokenLike): [number, number] {
		return nodeOrToken.range;
	}

	// ─── Single-token queries ──────────────────────────────────────────────

	getTokenByRangeStart(offset: number, options?: { includeComments?: boolean }): AnyToken | null {
		const includeComments = !!options?.includeComments;
		const arr = includeComments ? this.tokensAndComments : this.tokens;
		const i = searchFirstAtOrAfter(arr, offset);
		const t = arr[i];
		return t && t.range[0] === offset ? t : null;
	}

	getFirstToken(node: NodeOrTokenLike, options?: TokenOption): AnyToken | null {
		const o = normOpts(options);
		const arr = o.includeComments ? this.tokensAndComments : this.tokens;
		const i = searchFirstAtOrAfter(arr, node.range[0]);
		return advanceForward(arr, i, node.range[1], o, /*matchOne*/ true) as AnyToken | null;
	}

	getLastToken(node: NodeOrTokenLike, options?: TokenOption): AnyToken | null {
		const o = normOpts(options);
		const arr = o.includeComments ? this.tokensAndComments : this.tokens;
		// Last token strictly inside [node.range[0], node.range[1]] —
		// `searchLastEndingAtOrBefore` returns the one whose range[1] <= end.
		const i = searchLastEndingAtOrBefore(arr, node.range[1]);
		return advanceBackward(arr, i, node.range[0], o, /*matchOne*/ true) as AnyToken | null;
	}

	getTokenBefore(nodeOrToken: NodeOrTokenLike, options?: TokenOption): AnyToken | null {
		const o = normOpts(options);
		const arr = o.includeComments ? this.tokensAndComments : this.tokens;
		// Strictly before `nodeOrToken.range[0]` — i.e. range[1] <= start.
		const i = searchLastEndingAtOrBefore(arr, nodeOrToken.range[0]);
		return advanceBackward(arr, i, -Infinity, o, /*matchOne*/ true) as AnyToken | null;
	}

	getTokenAfter(nodeOrToken: NodeOrTokenLike, options?: TokenOption): AnyToken | null {
		const o = normOpts(options);
		const arr = o.includeComments ? this.tokensAndComments : this.tokens;
		const i = searchFirstAtOrAfter(arr, nodeOrToken.range[1]);
		return advanceForward(arr, i, Infinity, o, /*matchOne*/ true) as AnyToken | null;
	}

	getFirstTokenBetween(left: NodeOrTokenLike, right: NodeOrTokenLike, options?: TokenOption): AnyToken | null {
		const o = normOpts(options);
		const arr = o.includeComments ? this.tokensAndComments : this.tokens;
		const i = searchFirstAtOrAfter(arr, left.range[1]);
		return advanceForward(arr, i, right.range[0], o, /*matchOne*/ true) as AnyToken | null;
	}

	getLastTokenBetween(left: NodeOrTokenLike, right: NodeOrTokenLike, options?: TokenOption): AnyToken | null {
		const o = normOpts(options);
		const arr = o.includeComments ? this.tokensAndComments : this.tokens;
		const i = searchLastEndingAtOrBefore(arr, right.range[0]);
		return advanceBackward(arr, i, left.range[1], o, /*matchOne*/ true) as AnyToken | null;
	}

	// ─── Multi-token queries ───────────────────────────────────────────────

	getTokens(node: NodeOrTokenLike, options?: TokenOption | number, afterCount?: number): AnyToken[] {
		// Two-arg padded-token form: `getTokens(node, beforeCount, afterCount)`.
		if (typeof options === 'number' && typeof afterCount === 'number') {
			const beforeArr = this.getTokensBefore(node, { count: options });
			const insideArr = this.getTokensInside(node, normOpts(undefined));
			const afterArr = this.getTokensAfter(node, { count: afterCount });
			return beforeArr.concat(insideArr, afterArr);
		}
		return this.getTokensInside(node, normOpts(options));
	}

	private getTokensInside(node: NodeOrTokenLike, o: NormOpts): AnyToken[] {
		const arr = o.includeComments ? this.tokensAndComments : this.tokens;
		const i = searchFirstAtOrAfter(arr, node.range[0]);
		return advanceForward(arr, i, node.range[1], o, /*matchOne*/ false) as AnyToken[];
	}

	getTokensBefore(nodeOrToken: NodeOrTokenLike, options?: TokenOption): AnyToken[] {
		const o = normOpts(options);
		const arr = o.includeComments ? this.tokensAndComments : this.tokens;
		const i = searchLastEndingAtOrBefore(arr, nodeOrToken.range[0]);
		const collected = advanceBackward(arr, i, -Infinity, o, /*matchOne*/ false) as AnyToken[];
		return collected.reverse();
	}

	getTokensAfter(nodeOrToken: NodeOrTokenLike, options?: TokenOption): AnyToken[] {
		const o = normOpts(options);
		const arr = o.includeComments ? this.tokensAndComments : this.tokens;
		const i = searchFirstAtOrAfter(arr, nodeOrToken.range[1]);
		return advanceForward(arr, i, Infinity, o, /*matchOne*/ false) as AnyToken[];
	}

	getTokensBetween(left: NodeOrTokenLike, right: NodeOrTokenLike, padding?: TokenOption | number): AnyToken[] {
		const o = normOpts(typeof padding === 'number' ? { skip: padding } : padding);
		const arr = o.includeComments ? this.tokensAndComments : this.tokens;
		const i = searchFirstAtOrAfter(arr, left.range[1]);
		return advanceForward(arr, i, right.range[0], o, /*matchOne*/ false) as AnyToken[];
	}

	getFirstTokens(node: NodeOrTokenLike, options?: TokenOption): AnyToken[] {
		// `count: undefined` → unlimited; common usage passes
		// `{ count: n }` to grab leading n tokens. Same options handling
		// as getFirstToken otherwise.
		return this.getTokensInside(node, normOpts(options));
	}

	getLastTokens(node: NodeOrTokenLike, options?: TokenOption): AnyToken[] {
		const o = normOpts(options);
		const arr = o.includeComments ? this.tokensAndComments : this.tokens;
		const i = searchLastEndingAtOrBefore(arr, node.range[1]);
		const collected = advanceBackward(arr, i, node.range[0], o, /*matchOne*/ false) as AnyToken[];
		return collected.reverse();
	}

	// ─── Comments ──────────────────────────────────────────────────────────

	getAllComments(): Comment[] {
		return this.comments;
	}

	// Per-position comment queries — going through TS's
	// `forEachLeadingCommentRange` directly skips the whole-file
	// `convertComments` walk that `this.comments` would otherwise force.
	// Most rules read comments by position (`getCommentsBefore` etc.,
	// ~78 / 95 grep'd call sites in eslint core + ts-eslint plugin) and
	// don't need the full array. As long as the lint pass has at least
	// one rule that reads `sourceCode.comments` / `getAllComments` (e.g.
	// `ban-tslint-comment`), the array still gets built; otherwise we
	// skip `convertComments` entirely.
	//
	// `tsNodeOf` returns the underlying ts.Node for an ESTree node we
	// generated via the lazy converter (esTreeNodeToTSNodeMap is a
	// WeakMap). Plain ESLint `Token` objects (output of `convertTokens`)
	// don't have one — they fall back to a tokens-array binary search,
	// which only forces `convertTokens` (~50 ms cold) instead of
	// `convertComments` (~115 ms cold).
	private tsNodeOf(nodeOrToken: NodeOrTokenLike): ts.Node | undefined {
		const map = this.parserServices?.esTreeNodeToTSNodeMap as WeakMap<object, ts.Node> | undefined;
		return map?.get(nodeOrToken);
	}

	// Per-node WeakMap caches for idempotent queries. Multiple rules often
	// hit the same node with the same query (e.g. consistent-return,
	// no-fallthrough, naming-convention all read `getCommentsBefore` on
	// statement headers). Cache by node identity so the second-and-onward
	// reads short-circuit. Result arrays are read-only by ESLint
	// convention so sharing the same instance is safe.
	private _commentsBeforeCache?: WeakMap<NodeOrTokenLike, Comment[]>;
	private _commentsAfterCache?: WeakMap<NodeOrTokenLike, Comment[]>;
	private _commentsInsideCache?: WeakMap<NodeOrTokenLike, Comment[]>;
	private _declaredVariablesCache?: WeakMap<object, any[]>;

	getCommentsBefore(nodeOrToken: NodeOrTokenLike): Comment[] {
		const cache = this._commentsBeforeCache ??= new WeakMap();
		const cached = cache.get(nodeOrToken);
		if (cached) return cached;
		const out: Comment[] = [];
		// Scan trivia from the position right after the previous token
		// up to the start of this node/token. For ESTree nodes built by
		// the lazy converter, `tsNode.pos` = fullStart (the boundary just
		// after the previous non-trivia token, including leading trivia).
		// For raw tokens we pay one cheap binary search over `tokens`.
		const tsNode = this.tsNodeOf(nodeOrToken);
		let scanStart: number;
		if (tsNode) {
			scanStart = tsNode.pos;
		}
		else {
			const tIdx = searchLastEndingAtOrBefore(this.tokens, nodeOrToken.range[0]);
			scanStart = tIdx >= 0 ? this.tokens[tIdx].range[1] : 0;
		}
		// `convertComments` skips position 0 if a shebang sits there
		// (the scanner reports the shebang as a `SingleLineCommentTrivia`
		// at offset 0); match that for parity.
		if (scanStart === 0) {
			scanStart = (ts.getShebang(this.text) ?? '').length;
		}
		ts.forEachLeadingCommentRange(this.text, scanStart, (pos, end, kind) => {
			if (pos >= nodeOrToken.range[0]) return;
			out.push(buildCommentObject(this.text, pos, end, kind, this._tsFile));
		});
		cache.set(nodeOrToken, out);
		return out;
	}

	getCommentsAfter(nodeOrToken: NodeOrTokenLike): Comment[] {
		const cache = this._commentsAfterCache ??= new WeakMap();
		const cached = cache.get(nodeOrToken);
		if (cached) return cached;
		const out: Comment[] = [];
		const tsNode = this.tsNodeOf(nodeOrToken);
		const endPos = tsNode ? tsNode.end : nodeOrToken.range[1];
		// `forEachLeadingCommentRange(text, endPos)` scans forward from
		// `endPos` through trivia until the next non-trivia token,
		// emitting every comment in between — matches ESLint's
		// "comments after node up to next token" semantics.
		ts.forEachLeadingCommentRange(this.text, endPos, (pos, end, kind) => {
			out.push(buildCommentObject(this.text, pos, end, kind, this._tsFile));
		});
		cache.set(nodeOrToken, out);
		return out;
	}

	private _innerScanner?: ts.Scanner;
	getCommentsInside(node: NodeOrTokenLike): Comment[] {
		const cache = this._commentsInsideCache ??= new WeakMap();
		const cached = cache.get(node);
		if (cached) return cached;
		// AST-driven gap scan: walk the underlying ts.Node, emit each
		// trivia gap's comments via the same `walkInnerCommentsOf`
		// helper `convertComments` uses. No dependency on `this.comments`
		// → no whole-file `convertComments` build is forced just to
		// answer "what's inside this one node".
		const tsNode = this.tsNodeOf(node);
		if (!tsNode) {
			// Plain ESLint Token (no underlying ts.Node). Fall back to
			// the comments array — Tokens are leaves anyway, so they
			// can't contain inner comments worth scanning, but ESLint
			// API has it pass through.
			const fallback = this.commentsInRange(node.range[0], node.range[1]);
			cache.set(node, fallback);
			return fallback;
		}
		const out: Comment[] = [];
		const text = this.text;
		const ast = this._tsFile;
		const scanner = this._innerScanner ??= ts.createScanner(
			ast.languageVersion,
			/*skipTrivia*/ true,
			ast.languageVariant,
		);
		scanner.setText(text);
		const collect = (pos: number, end: number, kind: ts.CommentKind): void => {
			out.push(buildCommentObject(text, pos, end, kind, ast));
		};
		const emitFrom = (scanFrom: number): void => {
			if (scanFrom > 0) ts.forEachTrailingCommentRange(text, scanFrom, collect);
			ts.forEachLeadingCommentRange(text, scanFrom, collect);
		};
		// `walkInnerCommentsOf` skips the entry node's first-child
		// leading trivia (its outer "skip parent's leading" invariant),
		// so we have to emit "the first inner trivia" ourselves. For
		// SourceFile that's `shebangLen`; for any other node it's the
		// position right after the open token (lex one token).
		let innerStart: number;
		if (tsNode.kind === SK.SourceFile) {
			innerStart = (ts.getShebang(text) ?? '').length;
		}
		else {
			const start = tsNode.getStart(ast);
			if (start >= tsNode.end) {
				cache.set(node, out);
				return out;
			}
			scanner.setTextPos(start);
			scanner.scan();
			innerStart = scanner.getTokenEnd();
		}
		if (innerStart < tsNode.end) emitFrom(innerStart);
		walkInnerCommentsOf(tsNode, ast, scanner, emitFrom);
		cache.set(node, out);
		return out;
	}

	commentsExistBetween(left: NodeOrTokenLike, right: NodeOrTokenLike): boolean {
		// Early-return version of `getCommentsAfter(left)` filtered to
		// the `right` boundary. `forEachLeadingCommentRange`'s callback
		// can return a truthy value to terminate the iteration.
		const tsLeft = this.tsNodeOf(left);
		const startPos = tsLeft ? tsLeft.end : left.range[1];
		const rightStart = right.range[0];
		const found = ts.forEachLeadingCommentRange(this.text, startPos, (_pos, end) => {
			return end <= rightStart ? true : undefined;
		});
		return !!found;
	}

	private commentsInRange(start: number, end: number): Comment[] {
		const comments = this.comments;
		const i = searchFirstAtOrAfter(comments, start);
		const out: Comment[] = [];
		for (let j = i; j < comments.length; j++) {
			const c = comments[j];
			if (c.range[1] > end) break;
			out.push(c);
		}
		return out;
	}

	// JSDoc retrieval mirrors ESLint's deprecated semantics: the closest
	// preceding `/** ... */` block comment attached to the node. Most TS
	// rules use parser services for this; provide a minimal fallback.
	getJSDocComment(node: NodeOrTokenLike): Comment | null {
		const before = this.getCommentsBefore(node);
		for (let i = before.length - 1; i >= 0; i--) {
			const c = before[i];
			if (c.type === 'Block' && c.value.startsWith('*')) return c;
		}
		return null;
	}

	// ─── Whitespace check ──────────────────────────────────────────────────

	isSpaceBetween(first: NodeOrTokenLike, second: NodeOrTokenLike): boolean {
		// Rules pass either AST nodes or tokens. Anything strictly between
		// `first.range[1]` and `second.range[0]` that isn't an adjacent
		// token / comment counts as space.
		if (first.range[1] >= second.range[0]) return false;
		// Look at the slice of text between them, ignoring comments.
		// Simple heuristic ESLint also uses: any text after stripping
		// comments?
		const text = this.text.slice(first.range[1], second.range[0]);
		// strip block + line comments
		const stripped = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n\r]*/g, '');
		return /\s/.test(stripped);
	}
	isSpaceBetweenTokens(first: NodeOrTokenLike, second: NodeOrTokenLike): boolean {
		return this.isSpaceBetween(first, second);
	}

	// ─── AST traversal helpers ─────────────────────────────────────────────

	getNodeByRangeIndex(index: number): any | null {
		// First-principles: TS already has a parsed AST with O(log depth)
		// position lookup (`ts.getTokenAtPosition`, internal). Use it
		// instead of running a fresh DFS over the lazy ESTree on every
		// call — that DFS forces wrapper materialisation along every
		// branch it explores, which is the most expensive part.
		if (index < 0 || index >= this.text.length) return null;
		const getTokenAtPosition = (ts as unknown as {
			getTokenAtPosition?: (sf: ts.SourceFile, pos: number) => ts.Node;
		}).getTokenAtPosition;
		if (!getTokenAtPosition) {
			// API not available (older TS). Bail out.
			return null;
		}
		// `getTokenAtPosition` returns a leaf token whose range strictly
		// covers `index`. ESLint's `getNodeByRangeIndex` returns the
		// deepest node whose `[range[0], range[1])` contains `index`.
		// For a leaf token that's the token itself; nodes wrap their
		// leaves so any ancestor whose range still covers `index` is
		// shallower — the leaf is correct.
		const tsNode: ts.Node = getTokenAtPosition(this._tsFile, index);
		if (!tsNode) return null;
		// Convert to ESTree wrapper. ESLint rules expect a node, not a
		// token, so walk up to the first ts.Node that has a registered
		// ESTree counterpart (lazy-estree only registers node-shaped
		// kinds, not punctuator tokens).
		const tsToEstree = this.parserServices?.tsNodeToESTreeNodeMap as
			| WeakMap<ts.Node, any>
			| undefined;
		if (!tsToEstree) return null;
		// Try to materialise via lazy-estree's `materialize` helper —
		// it walks up the TS parent chain to find an already-converted
		// ancestor and builds the path down. The Program node's `_ctx`
		// holds the converter context.
		const ctx = (this.ast as { _ctx?: unknown })._ctx;
		if (!ctx) return null;
		const { materialize } = require('./lazy-estree') as typeof import('./lazy-estree');
		// Walk up to find a ts.Node that has an ESTree wrapper kind.
		// Tokens / SyntaxList / etc. get folded into their parent's
		// ESTree shape, so they don't have their own wrappers.
		let cur: ts.Node | undefined = tsNode;
		while (cur) {
			try {
				const wrapper = materialize(cur, ctx as any);
				if (wrapper) return wrapper;
			}
			catch {
				// `materialize` throws for kinds without an ESTree
				// counterpart (e.g. tokens with no node form). Walk up.
			}
			cur = cur.parent;
		}
		return null;
	}

	getAncestors(node: any): any[] {
		const out: any[] = [];
		let p = node?.parent;
		while (p) {
			out.unshift(p);
			p = p.parent;
		}
		return out;
	}

	// ─── Scope ─────────────────────────────────────────────────────────────

	getScope(currentNode: any): any {
		if (!currentNode) throw new TypeError('Missing required argument: node.');
		const sm = this.scopeManager;
		if (!sm) return null;
		const cache = this._scopeCache ??= new WeakMap();
		const cached = cache.get(currentNode);
		if (cached) return cached;
		// Mirrors ESLint SourceCode#getScope: at the Program node, ask for
		// the outermost scope (globalScope) — `inner=true` would return the
		// module scope under sourceType: module, which has different
		// `through` semantics than no-undef expects. Other nodes want the
		// innermost scope they're in.
		const inner = currentNode.type !== 'Program';
		for (let node = currentNode; node; node = node.parent) {
			const scope = sm.acquire ? sm.acquire(node, inner) : null;
			if (scope) {
				// `function-expression-name` is a tiny scope holding only
				// the named function-expression's own name; rules want the
				// containing function scope, which is its single child.
				if (scope.type === 'function-expression-name') {
					cache.set(currentNode, scope.childScopes[0]);
					return scope.childScopes[0];
				}
				cache.set(currentNode, scope);
				return scope;
			}
		}
		const fallback = sm.scopes?.[0] ?? sm.globalScope ?? null;
		if (fallback) cache.set(currentNode, fallback);
		return fallback;
	}

	getDeclaredVariables(node: any): any[] {
		const cache = this._declaredVariablesCache ??= new WeakMap();
		const cached = cache.get(node);
		if (cached) return cached;
		const sm = this.scopeManager;
		if (!sm || !sm.getDeclaredVariables) return [];
		const result = sm.getDeclaredVariables(node);
		cache.set(node, result);
		return result;
	}

	isGlobalReference(node: any): boolean {
		// Simple variant — true iff the reference resolves to a global-scope
		// variable. Rules that depend on this (e.g. `no-undef` doesn't —
		// it goes through `globalScope.through` directly) are rare.
		const sm = this.scopeManager;
		if (!sm || !sm.globalScope) return false;
		const through = sm.globalScope.through;
		if (!through) return false;
		for (const ref of through) {
			if (ref.identifier === node) return true;
		}
		return false;
	}

	markVariableAsUsed(name: string, refNode: any): boolean {
		const sm = this.scopeManager;
		if (!sm) return false;
		let scope = this.getScope(refNode ?? this.ast);
		while (scope) {
			const v = scope.variables?.find?.((vv: any) => vv.name === name);
			if (v) {
				v.eslintUsed = true;
				return true;
			}
			scope = scope.upper;
		}
		return false;
	}
}

// ─── Token traversal helpers ────────────────────────────────────────────────

// Forward iteration starting at index `i` until either:
//   - we hit a token whose `range[0] >= endLoc` (exclusive boundary), or
//   - we've collected `count` matches (when count >= 0).
// Returns either the first match (matchOne=true) or all matches as an array.
function advanceForward(
	arr: AnyToken[],
	startIdx: number,
	endLoc: number,
	o: NormOpts,
	matchOne: boolean,
): AnyToken | null | AnyToken[] {
	const out: AnyToken[] = matchOne ? null! : [];
	let skip = o.skip;
	let remaining = o.count;
	for (let i = startIdx; i < arr.length; i++) {
		const t = arr[i];
		if (t.range[0] >= endLoc) break;
		if (o.filter && !o.filter(t)) continue;
		if (skip > 0) {
			skip--;
			continue;
		}
		if (matchOne) return t;
		out.push(t);
		if (remaining > 0 && --remaining === 0) break;
	}
	return matchOne ? null : out;
}

function advanceBackward(
	arr: AnyToken[],
	startIdx: number,
	endLoc: number, // exclusive lower bound (range[1] > endLoc to keep)
	o: NormOpts,
	matchOne: boolean,
): AnyToken | null | AnyToken[] {
	const out: AnyToken[] = matchOne ? null! : [];
	let skip = o.skip;
	let remaining = o.count;
	for (let i = startIdx; i >= 0; i--) {
		const t = arr[i];
		if (t.range[1] <= endLoc) break;
		if (o.filter && !o.filter(t)) continue;
		if (skip > 0) {
			skip--;
			continue;
		}
		if (matchOne) return t;
		out.push(t);
		if (remaining > 0 && --remaining === 0) break;
	}
	return matchOne ? null : out;
}

// ─── Sorted merge of tokens + comments ──────────────────────────────────────

function mergeSorted(tokens: AnyToken[], comments: AnyToken[]): AnyToken[] {
	const result: AnyToken[] = new Array(tokens.length + comments.length);
	let i = 0, j = 0, k = 0;
	while (i < tokens.length && j < comments.length) {
		result[k++] = tokens[i].range[0] < comments[j].range[0]
			? tokens[i++]
			: comments[j++];
	}
	while (i < tokens.length) result[k++] = tokens[i++];
	while (j < comments.length) result[k++] = comments[j++];
	return result;
}
