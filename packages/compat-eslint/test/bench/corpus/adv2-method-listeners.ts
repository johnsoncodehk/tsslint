// Adv2: Rules that listen on FunctionExpression / MethodDefinition
// now also fire on class methods (NEW visit). Previously these only
// fired on plain functions. default-param-last, no-empty-function,
// consistent-return — all are class-method-aware.

// Class with default param BEFORE non-default param in a method.
// default-param-last must report.
export class Bad {
	method(a: number = 0, b: number): number {
		return a + b;
	}
	// Constructor with default-then-required.
	constructor(_x: string = 'a', _y: number) {}

	// Getter with empty body — no-empty-function (variant 'getters').
	get name(): string { return ''; }
	get empty(): string { return undefined as any; }

	// Plain method with empty body — no-empty-function (variant 'methods').
	noop(): void {}

	// Constructor with empty body — no-empty-function (variant 'constructors').
}
void Bad;

// Static method with default-then-required.
export class Stat {
	static go(a: number = 0, b: number): number { return a + b; }
}
void Stat;

// Object literal method with default-then-required.
export const obj = {
	go(a: number = 0, b: number): number { return a + b; },
	empty() {},                      // no-empty-function
	get name(): string { return ''; }, // empty getter setter — separate
};
void obj;

// Async method with default-then-required (now FunctionExpression
// listener fires here).
export class Async {
	async fetch(_url: string = '', _opts: object): Promise<void> {}
}
void Async;

// Generator method with default-then-required.
export class Gen {
	*emit(_a: number = 0, _b: number): Generator<number, void, unknown> {
		yield 1;
	}
}
void Gen;

// consistent-return on a method — some paths return value, others
// implicit (no return). NOW the FunctionExpression listener should
// trigger consistent-return on this method body.
export class Inconsistent {
	check(x: number): number | undefined {
		if (x > 0) return x;
		// implicit return — consistent-return must report
	}
}
void Inconsistent;

// Object method with consistent-return inconsistency.
export const obj2 = {
	check(x: number): number | undefined {
		if (x > 0) return x;
		return; // bare return — consistent-return reports
	},
};
void obj2;

// Setter — no-empty-function variant 'setters'.
export class Setter {
	set value(_v: number) {}
}
void Setter;
