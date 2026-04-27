// Adversarial optional chains: deep chains, optional call, optional
// computed access, mixed with nullish, parenthesized chain breaking
// short-circuit, optional chain in destructure default.
// Hits: ChainExpression wrapper + the `parent.optional` flag check
// that the agent's earlier audit landed for compat shape parity.

interface Inner { c?: () => number }
interface Mid { b?: Inner }
interface Outer { a?: Mid }

const data: Outer = { a: { b: { c: () => 1 } } };

// Deep optional chain with optional call at the end —
// `a?.b?.c?.()`. Each `?.` is its own MemberExpression with
// optional:true; the trailing `?.()` is a CallExpression with
// optional:true wrapped by ChainExpression.
export function deep(): number | undefined {
	return data.a?.b?.c?.();
}
void deep;

// Optional access via computed property — `a?.[expr]?.b`. The expr
// inside brackets evaluates regardless of short-circuit.
const idx2 = 'b';
export function viaIndex(): Inner | undefined {
	return data.a?.[idx2 as 'b']?.b ? data.a[idx2 as 'b'] : undefined;
}
void viaIndex;

// Mixed optional + nullish coalescing — `a?.b ?? c?.d` should NOT
// trip no-constant-binary-expression even though tsserver may know
// values.
export function mixed(): Inner | undefined {
	return data.a?.b ?? null as any as Mid | undefined;
}
void mixed;

// Parenthesized optional chain breaks the short-circuit — `(a?.b)?.c`
// the outer `?.c` accesses on the result of `(a?.b)`, which may be
// `undefined`. The parens introduce a ChainExpression boundary.
export function parened(): (() => number) | undefined {
	return (data.a?.b)?.c;
}
void parened;

// Optional chain in destructure default — `const { x = a?.b } = obj`.
// The default expression is in the destructure position; ChainExpression
// wraps `a?.b`.
export function withDefault(obj: { x?: Mid }): Mid | undefined {
	const { x = data.a?.b } = obj;
	return x;
}
void withDefault;

// Optional chain in template literal — call through optional chain
// inside `${...}`.
export function templated(): string {
	return `value: ${data.a?.b?.c?.() ?? 'none'}`;
}
void templated;

// Optional chain with non-null assertion — `a?.b!` is valid TS.
// The `!` is a TSNonNullExpression wrapping a chain.
export function bang(): Inner {
	return data.a?.b!;
}
void bang;

// Optional chain in `typeof` typeof position — `typeof a?.b`. The
// typeof operator wraps the chain. (Runtime typeof, not type-position.)
export function typeofChain(): string {
	return typeof data.a?.b;
}
void typeofChain;

// Optional call on a function reference — `fn?.()`. Different from
// member access optional. ChainExpression wrapper still applies.
let maybeFn: ((x: number) => number) | undefined;
export function maybeCall(x: number): number | undefined {
	return maybeFn?.(x);
}
void maybeCall;

// Yoda + optional chain — yoda wants literal-on-right; optional chain
// access on the right with literal on the left should report.
export function checkYoda(): boolean {
	return null === data.a?.b; // yoda
}
void checkYoda;

// Useless ternary on optional chain — `a?.b ? a.b : null` could be
// just `a?.b ?? null`. no-unneeded-ternary's heuristic shouldn't
// fire (different value), but if it does, parity matters.
export function checkTernary(): Inner | null {
	return data.a?.b ? data.a.b : null;
}
void checkTernary;

// Optional chain on `arguments` — `arguments?.length` inside a
// function. `arguments` is a synthetic var; chain wrapping it shouldn't
// trip no-undef.
export function chainArgs(): number {
	return arguments?.length ?? 0;
}
void chainArgs;

// Optional chain reading method then calling — `a?.b.c()` (NOT
// `a?.b?.c?.()`). Only the first `?.` is optional; subsequent are
// regular.
export function partialChain(): number | undefined {
	return data.a?.b!.c?.();
}
void partialChain;
