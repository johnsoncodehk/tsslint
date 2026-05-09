import type { Plugin } from '@tsslint/types';
import type * as ts from 'typescript';

interface CommentState {
	used?: boolean;
	commentRange: [number, number];
	startLine: number;
	endLine?: number;
}

interface CachedComment {
	/** First content character (after `//` or `/*`). */
	pos: number;
	/** End of comment content. */
	end: number;
	/** Cached `fullText.substring(pos, end)`. */
	text: string;
}

// Inlined comment-trivia walker. Equivalent to ts-api-utils'
// `forEachComment` but specialized for our needs (no `kind` / `value`
// fields, no generator overhead, no per-token closure for the
// trivia-collector). Algorithm matches upstream:
//
//   1. Iterative DFS over `node.getChildren(sourceFile)` — token-only
//      leaves drive the walk. Realizes the AST tree, but the lint
//      pipeline does this anyway for type-aware rules so the cost is
//      amortized across the whole pass.
//   2. For each token, scan `forEachLeadingCommentRange` (skip shebang
//      at file start) and `forEachTrailingCommentRange`.
//   3. JSX needs special care: `JsxText` tokens can't carry leading
//      trivia, and trailing trivia rules differ for `}` / `>` tokens
//      based on their JSX-element context.
//
// Trivia regions sit BETWEEN tokens — they can't contain string,
// template, or regex literals (those belong to token text). That's
// why driving `ts.createScanner` directly without parser context is
// unsafe (regex / template `${}` interpolation get misclassified) and
// why the AST-driven walk stays correct.
//
// Multiple ignore plugins (one per directive form) share the result via
// a per-SourceFile WeakMap so the second / third callers in a pass pay
// one map lookup instead of another scan.
const sharedFileComments = new WeakMap<ts.SourceFile, CachedComment[]>();

function getFileComments(
	ts: typeof import('typescript'),
	file: ts.SourceFile,
): CachedComment[] {
	let comments = sharedFileComments.get(file);
	if (!comments) {
		comments = [];
		const fullText = file.text;
		const SK = ts.SyntaxKind;
		const notJsx = file.languageVariant !== ts.LanguageVariant.JSX;

		// Iterative DFS: token leaves trigger trivia scans. Single shared
		// callback object instead of allocating a closure per
		// forEachLeading/Trailing call.
		//
		// CRITICAL: TS's `forEachLeading/TrailingCommentRange` stops
		// iterating as soon as the callback returns a truthy value
		// (matches the documented `forEachX` contract — return non-
		// undefined to short-circuit). The callback body MUST NOT
		// implicit-return `array.push(...)` (returns length → truthy →
		// only the first comment per token gets collected).
		const collected = comments;
		const onComment = (pos: number, end: number) => {
			const start = pos + 2; // strip `//` or `/*`
			collected.push({
				pos: start,
				end,
				text: fullText.substring(start, end),
			});
			// no return → undefined → continue iteration
		};

		// `getChildren` array per visit creates the most allocation
		// pressure; we still need it because `forEachChild` skips token
		// kinds. Iterative stack avoids the recursive overhead.
		let stack: ts.Node[] = [file];
		while (stack.length > 0) {
			const node = stack.pop()!;
			if (ts.isTokenKind(node.kind)) {
				if (node.pos === node.end) {
					continue;
				}
				if (node.kind !== SK.JsxText) {
					// Skip the shebang at file position 0; otherwise
					// `forEachLeadingCommentRange` would re-emit it as a
					// line comment.
					const scanFrom = node.pos === 0
						? (ts.getShebang(fullText) ?? '').length
						: node.pos;
					ts.forEachLeadingCommentRange(fullText, scanFrom, onComment);
				}
				if (notJsx || canHaveTrailingTrivia(ts, node)) {
					ts.forEachTrailingCommentRange(fullText, node.end, onComment);
				}
				continue;
			}
			const children = node.getChildren(file);
			// Push in reverse so DFS order matches source order.
			for (let i = children.length - 1; i >= 0; --i) {
				stack.push(children[i]);
			}
		}

		sharedFileComments.set(file, comments);
	}
	return comments;
}

function canHaveTrailingTrivia(
	ts: typeof import('typescript'),
	token: ts.Node,
): boolean {
	const SK = ts.SyntaxKind;
	switch (token.kind) {
		case SK.CloseBraceToken:
			// `}` of a JsxExpression inside a JSX element: no trailing
			// trivia (the next character is JsxText, not a comment).
			return token.parent.kind !== SK.JsxExpression
				|| !isJsxElementOrFragment(ts, token.parent.parent);
		case SK.GreaterThanToken:
			switch (token.parent.kind) {
				case SK.JsxClosingElement:
				case SK.JsxClosingFragment:
					return !isJsxElementOrFragment(ts, token.parent.parent.parent);
				case SK.JsxOpeningElement:
					// Type-args list keeps trailing trivia; the `>` that
					// closes the opening tag itself does not (next is
					// JsxText).
					return token.end !== token.parent.end;
				case SK.JsxOpeningFragment:
					return false;
				case SK.JsxSelfClosingElement:
					return token.end !== token.parent.end
						|| !isJsxElementOrFragment(ts, token.parent.parent);
			}
	}
	return true;
}

function isJsxElementOrFragment(
	ts: typeof import('typescript'),
	node: ts.Node,
): boolean {
	const SK = ts.SyntaxKind;
	return node.kind === SK.JsxElement || node.kind === SK.JsxFragment;
}

export function create(
	cmdOption: string | [string, string],
	reportsUnusedComments: boolean,
): Plugin {
	const mode = typeof cmdOption === 'string' ? 'singleLine' : 'multiLine';
	const [cmd, endCmd] = Array.isArray(cmdOption) ? cmdOption : [cmdOption, undefined];
	const cmdText = cmd.replace(/\?/g, '');
	// Rule IDs in the wild: bare (`no-shadow`), plugin-prefixed
	// (`regexp/no-foo`), or scoped (`@typescript-eslint/no-foo`,
	// `@scope/plugin/rule`). The previous `\w\S*` required a word char
	// first — `@` failed, so every scoped disable comment fell into the
	// `comments.get(undefined)` "disable all" bucket. Stacking multiple
	// scoped disables then collapsed them into duplicates, only the first
	// got marked used by an incoming error, the rest were reported as
	// unused-comment FPs (real Astro repro: stacked `@typescript-eslint/...`
	// block disables on `extendables.ts`).
	//
	// Match: leading scope segment `@xxx/`, then a name segment that
	// starts with letter/underscore (skip `--` description delimiter),
	// allowing `\w / . -` thereafter.
	const ruleIdPattern = '(?:@[\\w-]+\\/)?[A-Za-z_][\\w/.-]*';
	// Capture EVERYTHING after the command word as `tail`. The previous
	// `(?<ruleId>...)?([ \\t]+[^\\r\\n]*)?` form captured a single rule
	// id and let the trailing-text group eat the rest — but `,` is not
	// in `[ \\t]+`, so for `eslint-disable rule1, rule2` the optional
	// ruleId group backtracked to nothing, the trailing-text group then
	// consumed `rule1, rule2 */`, and the result was treated as a bare
	// `eslint-disable` (= disable ALL). Now we capture the whole tail
	// and split it ourselves below to extract the rule list.
	//
	// `cmd` MUST be followed by whitespace, `*/`, or end of comment —
	// not by another word/`-` char. Otherwise `eslint-disable` would
	// also match `eslint-disable-line ...` (treating `-line ...` as a
	// malformed rule list and falling back to disable-all). The
	// `(?:\\s+(?<tail>...))?` form requires whitespace if anything
	// follows.
	const header = '^\\s*';
	const tail = '(?:\\s+(?<tail>[^]*?))?(?:\\*\\/)?\\s*$';
	const reg = new RegExp(`${header}${cmd}${tail}`);
	const endReg = endCmd ? new RegExp(`${header}${endCmd}${tail}`) : undefined;
	// `tail` parsing: split by `--` (description marker), keep left side,
	// split by `,`, trim each, drop blanks, validate against ruleIdPattern.
	// Empty result = disable-all (matches ESLint semantics).
	const ruleIdRegExp = new RegExp(`^${ruleIdPattern}$`);
	function parseRuleList(rawTail: string | undefined): string[] | undefined {
		if (!rawTail) return undefined; // bare command — disable all
		const beforeDescription = rawTail.split(/\s--\s/)[0];
		const parts = beforeDescription.split(',').map(s => s.trim()).filter(Boolean);
		if (parts.length === 0) return undefined; // disable all
		const valid = parts.filter(p => ruleIdRegExp.test(p));
		// If any part is malformed (e.g. trailing `*/` snuck in), be
		// conservative and treat the whole comment as disable-all rather
		// than silently dropping rules. ESLint surfaces an error here;
		// for our purposes mirroring the legacy "disable all on parse
		// failure" preserves behaviour for malformed comments.
		if (valid.length !== parts.length) return undefined;
		return valid;
	}
	const completeReg1 = /^\s*\/\/(\s*)([\S]*)?$/;
	const completeReg2 = new RegExp(`//\\s*${cmd}(\\S*)?$`);

	return ({ typescript: ts, languageService }) => {
		const reportedRulesOfFile = new Map<string, [string, number][]>();
		const { getCompletionsAtPosition } = languageService;

		languageService.getCompletionsAtPosition = (fileName, position, ...rest) => {
			let result = getCompletionsAtPosition(fileName, position, ...rest);

			const sourceFile = languageService.getProgram()?.getSourceFile(fileName);
			if (!sourceFile) {
				return result;
			}

			const reportedRules = reportedRulesOfFile.get(fileName);
			const line = sourceFile.getLineAndCharacterOfPosition(position).line;
			const lineStart = sourceFile.getPositionOfLineAndCharacter(line, 0);
			const prefix = sourceFile.text.slice(lineStart, position);
			const matchCmd = completeReg1
				? prefix.match(completeReg1)
				: undefined;

			if (matchCmd) {
				const nextLineRules = reportedRules?.filter(([, reportedLine]) => reportedLine === line + 1) ?? [];
				const item: ts.CompletionEntry = {
					name: cmdText,
					insertText: matchCmd[1].length ? cmdText : ` ${cmdText}`,
					kind: ts.ScriptElementKind.keyword,
					sortText: 'a',
					replacementSpan: matchCmd[2]
						? {
							start: position - matchCmd[2].length,
							length: matchCmd[2].length,
						}
						: undefined,
					labelDetails: {
						description: nextLineRules.length >= 2
							? `Ignore ${nextLineRules.length} issues in next line`
							: nextLineRules.length
							? 'Ignore 1 issue in next line'
							: undefined,
					},
				};
				if (result) {
					result.entries.push(item);
				}
				else {
					result = {
						isGlobalCompletion: false,
						isMemberCompletion: false,
						isNewIdentifierLocation: false,
						entries: [item],
					};
				}
			}
			else if (reportedRules?.length) {
				const matchRule = completeReg2
					? prefix.match(completeReg2)
					: undefined;
				if (matchRule) {
					const visited = new Set<string>();
					for (const [ruleId] of reportedRules) {
						if (visited.has(ruleId)) {
							continue;
						}
						visited.add(ruleId);

						const reportedLines = reportedRules
							.filter(([r]) => r === ruleId)
							.map(([, l]) => l + 1);
						const item: ts.CompletionEntry = {
							name: ruleId,
							kind: ts.ScriptElementKind.keyword,
							sortText: ruleId,
							replacementSpan: matchRule[1]
								? {
									start: position - matchRule[1].length,
									length: matchRule[1].length,
								}
								: undefined,
							labelDetails: {
								description: `Reported in line${reportedLines.length >= 2 ? 's' : ''} ${reportedLines.join(', ')}`,
							},
						};
						if (result) {
							result.entries.push(item);
						}
						else {
							result = {
								isGlobalCompletion: false,
								isMemberCompletion: false,
								isNewIdentifierLocation: false,
								entries: [item],
							};
						}
					}
				}
			}

			return result;
		};

		return {
			resolveDiagnostics(file, results) {
				if (
					!reportsUnusedComments
					&& !results.some(error => error.source === 'tsslint')
				) {
					return results;
				}
				const comments = new Map<string | undefined, CommentState[]>();

				for (const c of getFileComments(ts, file)) {
					const startComment = c.text.match(reg);

					if (startComment?.index !== undefined) {
						const index = startComment.index + c.pos;
						const ruleList = parseRuleList(startComment.groups?.tail);
						// `undefined` = bare command (disable all). Else
						// register one entry PER rule so comma-separated
						// disables don't collapse into the disable-all
						// bucket (the bug: `eslint-disable a, b` used
						// to silently disable everything because the old
						// regex backtracked to ruleId=undefined).
						const ruleKeys: (string | undefined)[] = ruleList ?? [undefined];
						const line = file.getLineAndCharacterOfPosition(index).line;

						let startLine = line;
						if (mode === 'singleLine') {
							const startWithComment = file.text.slice(
								file.getPositionOfLineAndCharacter(line, 0),
								index - 2,
							).trim() === '';
							if (startWithComment) {
								startLine = line + 1; // If the comment is at the start of the line, the error is in the next line
							}
						}

						const commentRange: [number, number] = [
							index - 2,
							index + startComment[0].length,
						];
						for (const ruleId of ruleKeys) {
							if (!comments.has(ruleId)) {
								comments.set(ruleId, []);
							}
							// Per-rule state object: a paired `eslint-enable
							// rule1` mutates `.endLine` on the matching
							// rule's last entry. Sharing one state across
							// `[rule1, rule2]` would cause the enable to
							// also close rule2's window.
							comments.get(ruleId)!.push({ commentRange, startLine });
						}
					}
					else if (endReg) {
						const endComment = c.text.match(endReg);

						if (endComment?.index !== undefined) {
							const index = endComment.index + c.pos;
							const prevLine = file.getLineAndCharacterOfPosition(index).line;
							const endRuleList = parseRuleList(endComment.groups?.tail);
							const endRuleKeys: (string | undefined)[] = endRuleList ?? [undefined];

							for (const ruleId of endRuleKeys) {
								const disabledLines = comments.get(ruleId);
								if (disabledLines) {
									disabledLines[disabledLines.length - 1].endLine = prevLine;
								}
							}
						}
					}
				}

				let reportedRules = reportedRulesOfFile.get(file.fileName);
				if (!reportedRules) {
					reportedRules = [];
					reportedRulesOfFile.set(file.fileName, reportedRules);
				}
				reportedRules.length = 0;

				results = results.filter(error => {
					if (error.source !== 'tsslint') {
						return true;
					}
					const line = file.getLineAndCharacterOfPosition(error.start).line;

					reportedRules.push([error.code as any, line]);

					for (const code of [undefined, error.code]) {
						const states = comments.get(code as any);
						if (!states) {
							continue;
						}
						if (mode === 'singleLine') {
							for (const state of states) {
								if (state.startLine === line) {
									state.used = true;
									return false;
								}
							}
						}
						else {
							for (const state of states) {
								if (line >= state.startLine && line <= (state.endLine ?? Number.MAX_VALUE)) {
									state.used = true;
									return false;
								}
							}
						}
					}
					return true;
				});
				if (reportsUnusedComments) {
					for (const comment of comments.values()) {
						for (const state of comment.values()) {
							if (!state.used) {
								results.push({
									file: file,
									start: state.commentRange[0],
									length: state.commentRange[1] - state.commentRange[0],
									code: 'tsslint:unused-ignore-comment' as any,
									messageText: `Unused comment.`,
									source: 'tsslint',
									category: 1,
								});
							}
						}
					}
				}
				return results;
			},
			resolveCodeFixes(file, diagnostic, codeFixes) {
				if (diagnostic.source !== 'tsslint' || diagnostic.start === undefined) {
					return codeFixes;
				}
				const line = file.getLineAndCharacterOfPosition(diagnostic.start).line;
				codeFixes.push({
					fixName: cmd,
					description: `Ignore with ${cmdText}`,
					changes: [
						{
							fileName: file.fileName,
							textChanges: [{
								newText: reg.test(`${cmdText}${diagnostic.code}`)
									? `// ${cmdText}${diagnostic.code}\n`
									: `// ${cmdText} ${diagnostic.code}\n`,
								span: {
									start: file.getPositionOfLineAndCharacter(line, 0),
									length: 0,
								},
							}],
						},
					],
				});
				return codeFixes;
			},
		};
	};
}
