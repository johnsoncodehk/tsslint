// Patterns: generator function (with/without yield), async generator,
// generator method, nested generator, yield* delegation.
// Hits: require-yield (CPA forces dispatch on every node so listener-
// scope tracking via onCodePathStart/onCodePathEnd must be balanced),
// generator function scope (separate from regular function scope —
// no-shadow / no-use-before-define must respect the boundary).

// Generator with yield — must NOT report.
export function* counter(start: number): Generator<number> {
	let n = start;
	while (true) {
		yield n++;
	}
}

// Generator WITHOUT yield — require-yield MUST report.
export function* empty(): Generator<never> {
	// no yield
}

// Async generator — same require-yield contract.
export async function* poll(read: () => Promise<number>): AsyncGenerator<number> {
	for (let i = 0; i < 3; i++) {
		yield await read();
	}
}

// yield* delegation — counts as a yield for require-yield.
export function* outer(): Generator<number> {
	yield* counter(0);
}

// Generator method on class — exercises method-as-generator + class scope.
export class Producer<T> {
	private items: T[] = [];
	*[Symbol.iterator](): Generator<T> {
		for (const x of this.items) yield x;
	}
	// Generator method WITHOUT yield — require-yield MUST report.
	*emptyMethod(): Generator<T> {
		// no yield
	}
}

// Nested generator — inner counts, outer doesn't.
// require-yield MUST report on outer (no yield) but NOT inner.
export function* nested(): Generator<number> {
	const inner = function* () {
		yield 1;
	};
	void inner;
}
