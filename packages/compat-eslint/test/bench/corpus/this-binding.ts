// Patterns: `this` in class methods, arrow functions, class field
// initializers, derived-class super calls. Hits: no-invalid-this
// (CPA-driven `this`-context resolution), class-methods-use-this
// (scope-walks the method body for `this`/`super`),
// no-this-before-super (CPA tracks super-availability across paths),
// constructor-super (super-call presence in derived classes).

// Plain class with method using `this` — class-methods-use-this OK.
export class Counter {
	private count = 0;
	increment(): void {
		this.count++;
	}
	// Method NOT using `this` — class-methods-use-this MUST report.
	staticGreet(name: string): string {
		return 'hello ' + name;
	}
}

// Class field with arrow — `this` is the instance.
export class Bound {
	private value = 42;
	getValue = (): number => this.value;
}

// Derived class with proper super() before this — OK.
export class A {
	constructor(public x: number) {}
}
export class B extends A {
	y: number;
	constructor(x: number, y: number) {
		super(x); // must come before `this`
		this.y = y; // OK after super
	}
}

// Derived class missing super() — constructor-super MUST report.
export class C extends A {
	constructor() {
		// missing super(...) — error
	}
}

// `this` in nested arrow inside method — bound to instance.
export class Logger {
	private prefix = '> ';
	log(messages: string[]): void {
		messages.forEach(m => {
			console.log(this.prefix + m);
		});
	}
}

// `this` at module scope — no-invalid-this MUST report (this is undefined
// in strict module).
function freeThis() {
	'use strict';
	return this; // no-invalid-this
}
void freeThis;
