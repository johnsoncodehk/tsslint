// Adversarial try/catch + control-flow: nested try inside generator,
// async iterator with throw, optional catch binding, finally that
// returns/throws (overriding inner throw), throw in finally.
// Hits: CPA's TryContext + ChoiceContext push/pop balance,
// no-unreachable's CodePath analysis, consistent-return through
// finally, no-useless-catch with rethrow inside loops.

// Optional catch binding — `catch {}` (no var). Must NOT trip
// no-unused-vars (no binding to mark unused) and must NOT trip
// no-useless-catch when catch body is empty.
export function tryQuiet(work: () => void): void {
	try {
		work();
	} catch {
		// swallow — no binding
	}
}
void tryQuiet;

// finally with return — overrides any throw/return in try/catch.
// CPA must thread the finally exit edge correctly. consistent-return
// must NOT spuriously fire here (every path returns through finally).
export function finallyOverride(flag: boolean): number {
	try {
		if (flag) throw new Error('x');
		return 1;
	} catch {
		return 2;
	} finally {
		return 3;  // wins over both above
	}
}
void finallyOverride;

// throw in finally — also overrides; CPA should mark anything after
// the try/finally as reachable only via the finally throw path.
export function throwInFinally(): never {
	try {
		return; // would be a return path
	} finally {
		throw new Error('always');
	}
}
void throwInFinally;

// Nested try/catch/finally inside a generator — yield can throw via
// `gen.throw(err)`; the surrounding try should catch.
export function* recover(): Generator<number, void, unknown> {
	try {
		try {
			yield 1;       // throwable point
			yield 2;
		} catch (e) {
			yield 3;       // recovery yield
			throw e;       // rethrow → outer catch
		} finally {
			yield 4;       // pre-finally cleanup
		}
	} catch {
		yield 5;
	}
}
void recover;

// Async iterator with throw method — `for await` + try/finally.
export async function consume(iter: AsyncIterable<number>): Promise<number> {
	let total = 0;
	try {
		for await (const v of iter) {
			total += v;
			if (total > 100) throw new Error('overflow');
		}
	} catch (e) {
		if (e instanceof Error) total = -1;
	} finally {
		// finally side-effects, no return
		void total;
	}
	return total;
}
void consume;

// Useless catch with try-finally — catch only rethrows AND there's a
// finally. ESLint's no-useless-catch reports when the catch is a
// pure rethrow — the finally shouldn't suppress that report.
export function uselessWithFinally(): void {
	try {
		throw new Error('x');
	} catch (e) {
		throw e;
	} finally {
		// cleanup
	}
}
void uselessWithFinally;

// Throw inside a switch → no-fallthrough must NOT report (throw is
// terminator). Tests CPA + switch fallthrough together.
export function dispatch(k: 'a' | 'b' | 'c'): number {
	switch (k) {
		case 'a':
			throw new Error('a not allowed');
		case 'b':
			return 2;
		default:
			return 3;
	}
}
void dispatch;

// no-useless-return inside try with finally — the explicit `return`
// before the closing brace IS useful (lets finally run before exit
// with a specific value). Edge case: rule may differ here.
export function tailReturn(x: number): number {
	try {
		if (x < 0) return -1;
		// fall through to next statement
	} finally {
		// cleanup
	}
	return 0;
}
void tailReturn;

// catch with parameter assigned — no-ex-assign MUST report.
export function exAssign(): void {
	try {
		throw new Error('x');
	} catch (e) {
		e = new Error('replaced');  // no-ex-assign
		void e;
	}
}
void exAssign;

// Loop with try/continue/break — CPA must thread loop-exit edges
// across the try block. no-unreachable-loop tests "loop body always
// completes the iteration"; here continue/break vary.
export function pickFirst(arr: number[]): number {
	for (const x of arr) {
		try {
			if (x < 0) continue;
			if (x === 0) break;
			return x;
		} catch {
			continue;
		}
	}
	return -1;
}
void pickFirst;
