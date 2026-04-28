// Adv2: Top-level await + module-scope patterns. ES2022+ shapes that
// historically required ecmaVersion >= 13 in ESLint core. Now that
// languageOptions.ecmaVersion is 2026, listeners gated on ES6+ run.
// Hits: await-import expression node, for-await-of (which now hits
// the new VariableDeclarationList visit for the binding), await-using
// (TS5+ stage-3 syntax — explicit-resource-management).

// Top-level `await` against a dynamic import. ImportExpression node.
// no-return-await would fire here if it were a function body — at
// module top-level it must not.
const mod = await import('./_dep.js');
void mod;

// `for await (const x of asyncIter)` — VariableDeclarationList for the
// `const x` is now hit by the predicate (was previously skipped).
// no-var (must NOT report on const), prefer-const (must NOT report —
// it IS const), id-length (1-char `x`).
async function* gen() {
	yield 1;
	yield 2;
}
async function consume(): Promise<void> {
	for await (const x of gen()) {
		void x;
	}
}
void consume;

// for-of with let — must NOT trigger no-var. prefer-const must check
// whether `i` is reassigned in the body — here it is.
async function reassign(arr: number[]): Promise<number> {
	let total = 0;
	for await (let i of (async function*() { for (const v of arr) yield v; })()) {
		i += 1;
		total += i;
	}
	return total;
}
void reassign;

// `await using` — explicit resource management (stage-3, TS 5.2).
// Lowered as VariableDeclaration with `awaitModifier`. Predicate
// should treat the inner VariableDeclarationList correctly.
async function useResource(): Promise<void> {
	const make = (): { [Symbol.asyncDispose](): Promise<void> } => ({
		async [Symbol.asyncDispose]() {},
	});
	await using r = make();
	void r;
}
void useResource;

// Top-level for-await with destructure binding (RestElement).
async function* pairs() {
	yield [1, 2];
	yield [3, 4];
}
async function destruct(): Promise<void> {
	for await (const [a, ...rest] of pairs()) {
		void a; void rest;
	}
}
void destruct;

// await in default parameter value — function expression default param
// with await. Inside an async arrow.
const greeter = async (name: string = await Promise.resolve('world')) => {
	return `hi ${name}`;
};
void greeter;
