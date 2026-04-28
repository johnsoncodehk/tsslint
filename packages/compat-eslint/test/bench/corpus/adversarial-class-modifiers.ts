// Adversarial class modifiers: declare abstract, accessor keyword,
// override modifier, private name #field, static #method, abstract
// optional method, parameter property with accessor.
// Hits: PropertyDefinition / AccessorProperty / TSAbstract* shape;
// the recently-added wrapper drills for class members; the
// MethodDefinition's PrivateIdentifier key handling.

// declare abstract class — purely ambient; no body, no constructor.
// Both class and abstract modifiers stack.
export declare abstract class Sealed {
	abstract readonly id: string;
	abstract describe(): string;
	abstract describeAsync?(): Promise<string>;  // optional abstract method
}

// Concrete class with override + private #field + accessor field.
abstract class Base2 {
	abstract id(): string;
	greet(): string { return 'hi'; }
}

export class WithModifiers extends Base2 {
	// Private field with hash — TS5 syntax.
	#secret: string = 'secret';

	// Static private method — `static #method()`.
	static #counter: number = 0;
	static increment(): number { return ++WithModifiers.#counter; }

	// Stage-3 `accessor` keyword — auto-generates get/set with a
	// hidden backing field. PropertyDefinition with `accessor: true`.
	accessor name: string = 'unnamed';
	static accessor instances: number = 0;

	// override modifier — must NOT trip no-redeclare or no-shadow on
	// `greet`.
	override greet(): string { return `hello, ${this.name}`; }

	// override with abstract impl.
	override id(): string { return this.#secret; }

	// Private getter/setter pair.
	get #internal(): string { return this.#secret; }
	set #internal(v: string) { this.#secret = v; }

	useInternal(v: string): string {
		this.#internal = v;
		return this.#internal;
	}
}
void WithModifiers;

// Class with parameter property + every modifier combo.
export class FullParams {
	constructor(
		public readonly a: number,
		private b: string,
		protected readonly c: boolean,
		public override d: number = 0,  // override would only apply if extending; keep as harmless
		...rest: unknown[]
	) {
		void this.a; void this.b; void this.c; void this.d; void rest;
	}
}
void FullParams;

// Abstract class with `protected abstract` method — modifier stack.
export abstract class Half {
	protected abstract impl(): void;
	run(): void { this.impl(); }
}

// Class with private name in computed key context — illegal at
// runtime BUT private name appears as `MemberExpression.property` of
// type `PrivateIdentifier`. Tests scope-manager's filter for them.
export class PrivAccess {
	#x = 1;
	read(): number { return this.#x; }
	write(v: number): void { this.#x = v; }
	// Self-comparison via private — should trip no-self-compare.
	bad(): boolean { return this.#x === this.#x; }
}
void PrivAccess;

// Class field with no initializer + definite assignment assertion.
export class Late {
	val!: number;
	init(): void { this.val = 1; }
}
void Late;

// Class with static block referencing a private static field.
export class WithStaticBlock {
	static #internal: number = 0;
	static {
		WithStaticBlock.#internal = 42;
	}
	static get internal(): number { return WithStaticBlock.#internal; }
}
void WithStaticBlock;

// Useless constructor on class with `override` modifier — should
// still report no-useless-constructor.
class Parent { constructor(public x: number) {} }
export class Child extends Parent {
	constructor(x: number) { super(x); }  // useless
}
void Child;
