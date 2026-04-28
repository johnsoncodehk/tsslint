// Patterns: switch/case with fallthrough, throw, conditional / nullish /
// optional chaining, try/catch (with + without binding).
// Hits: no-fallthrough (CPA-driven), no-unreachable, no-useless-catch,
// no-self-compare, no-empty (catch / finally), default-case-last,
// consistent-return, no-throw-literal.

type Kind = 'a' | 'b' | 'c';

// Switch with fallthrough — no-fallthrough MUST report case 'a' falling
// into 'b'. Default-case-last MUST NOT report when default is last.
export function classify(k: Kind): number {
	switch (k) {
		case 'a':
			// fallthrough (intentional); rule reports
		case 'b':
			return 1;
		case 'c':
			return 2;
		default:
			return -1;
	}
}

// Throw with non-error — no-throw-literal MUST report.
export function bad() {
	throw 'literal'; // no-throw-literal
}

// Useless catch — no-useless-catch MUST report.
export function rethrow(): void {
	try {
		bad();
	} catch (e) {
		throw e;
	}
}

// Empty catch — no-empty MUST report.
export function swallow(): void {
	try {
		bad();
	} catch {
	}
}

// Optional chaining + nullish coalescing — no-unsafe-optional-chaining
// (not in our set) doesn't fire here; rules listening on
// ChainExpression / LogicalExpression('??') exercise the lazy
// wrapper expansion.
export function pull(obj: { x?: { y?: string } } | undefined): string {
	return obj?.x?.y ?? 'default';
}

// Self-compare — no-self-compare MUST report.
export function isNaN_(x: number): boolean {
	return x !== x;
}

// Inconsistent return — consistent-return MUST report on the
// implicit return path.
export function maybe(flag: boolean) {
	if (flag) return 1;
	// implicit `return undefined` here → inconsistent
}
