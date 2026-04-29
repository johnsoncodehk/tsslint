// Patterns: BinaryExpression(',') in expression position, parens-wrapped
// sequences, parenthesized-left flatten exception.
// Hits: lazy-estree SequenceExpressionNode (BinaryExpression(',') →
// SequenceExpression with flatten); ts-ast-scan SequenceExpression
// predicate + flatten skip in CPA mode (no-sequences fires once per
// logical sequence); allowInParentheses=true default (parens-wrapped
// sequences NOT reported).

// Bare comma in expression position — no-sequences MUST report.
export function bareComma(a: number, b: number): number {
	let result;
	result = (a, b);
	return result;
}
void bareComma;

// Comma in for-init / for-update — special-cased by rule, NOT reported.
export function forLoop(): number[] {
	const out: number[] = [];
	for (let i = 0, length = 5; i < length; i++, out.push(i)) {
		// nothing
	}
	return out;
}
void forLoop;

// Parenthesized comma — `allowInParentheses: true` (default) MUST NOT
// report (intent expressed via parens).
export function returnParens(): number {
	return (1, 2, 3);
}
void returnParens;

// Logical OR with parenthesized sequence — `||(a, b, c)` is also
// allow-listed by allowInParentheses.
export function lazyInit() {
	const cache: { value?: number } = {};
	return cache.value || (cache.value = 1, cache.value);
}
void lazyInit;
