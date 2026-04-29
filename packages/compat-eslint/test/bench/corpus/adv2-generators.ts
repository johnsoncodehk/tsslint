// Adv2: Generator + try/finally patterns. Generator delegations,
// async iteration, throw/return method paths. Hits CodePath analysis
// and the new FunctionExpression visit on method bodies (now matches
// MethodDeclaration).

// Generator delegation `yield*` to an iterator, with throw method.
// no-unreachable + require-yield + no-useless-return interplay.
function* outer(): Generator<number, void, unknown> {
	yield* inner();
	yield 99;
}

function* inner(): Generator<number, void, unknown> {
	try {
		yield 1;
		yield 2;
	} catch (e) {
		// catch path is a generator continuation
		yield 3;
		throw e;
	} finally {
		// finally yields are fine but unusual
		yield 4;
	}
}
void outer; void inner;

// Class with generator method — now FunctionExpression listener fires
// here. require-yield must check yields inside the body.
export class Pull {
	*emit(n: number): Generator<number, void, unknown> {
		for (let i = 0; i < n; i++) {
			yield i;
		}
	}
	// Generator method with NO yield — require-yield must report.
	*never(): Generator<never, void, unknown> {
		// no yield; should fire require-yield
		void 0;
	}
}
void Pull;

// Async generator method — try/finally with await.
export class Stream {
	async *fetch(urls: string[]): AsyncGenerator<string, void, unknown> {
		for (const u of urls) {
			try {
				yield `fetched:${u}`;
			} catch {
				yield `error:${u}`;
			} finally {
				// no-useless-return must not fire — empty finally
				void 0;
			}
		}
	}
}
void Stream;

// Generator with return value — typed via TReturn. The implicit
// return at end of body has a value. consistent-return interacts.
function* numbered(): Generator<number, string, unknown> {
	yield 1;
	yield 2;
	return 'done';
}
void numbered;

// Generator never reaches yield (early return). require-yield's
// "must yield at least once" should NOT report when there's a return
// path that's reachable.
function* maybe(go: boolean): Generator<number, void, unknown> {
	if (!go) return;
	yield 1;
}
void maybe;

// Yield expression as RHS of assignment — yield can be on either
// side of an assignment in expression position.
function* assigner(): Generator<number, void, number> {
	let v = yield 1;
	v = yield (v + 1);
	return;
}
void assigner;

// `yield` in object method shorthand inside a generator (the OBJECT
// is created by a regular function — yield should NOT be allowed
// in the inner method, but TS allows it via async generator method.
export const factory = {
	*entries(): Generator<[string, number], void, unknown> {
		yield ['a', 1];
		yield ['b', 2];
	},
};
void factory;
