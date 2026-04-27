// Patterns: class with overloaded methods, accessors (get/set),
// parameter properties (`constructor(public x)`), static blocks,
// abstract members, private/protected modifiers.
// Hits: MethodDefinition + nested FunctionExpression scope shape;
// TSParameterPropertyNode wrapper; static-block scope; class-name
// duplication (no-shadow's isDuplicatedClassNameVariable filter);
// no-useless-constructor.

export class Vec {
	constructor(public x: number, public y: number, private readonly z: number = 0) {}

	// Overloaded method — the @typescript-eslint/parser's
	// `TSDeclareFunction`-flavour MethodDefinition entries. no-redeclare
	// must NOT fire on overloads.
	add(other: Vec): Vec;
	add(scalar: number): Vec;
	add(arg: Vec | number): Vec {
		if (typeof arg === 'number') return new Vec(this.x + arg, this.y + arg, this.z);
		return new Vec(this.x + arg.x, this.y + arg.y, this.z);
	}

	// Accessors — get/set forming a single conceptual property.
	get magnitude(): number {
		return Math.sqrt(this.x * this.x + this.y * this.y);
	}
	set magnitude(_unused: number) {
		// noop — accessors must still satisfy getter-return rule on the get half
	}

	// Static block — its own scope; `local` here doesn't shadow class
	// fields. Used by no-shadow + no-unused-vars.
	static readonly DEFAULT = new Vec(0, 0);
	static {
		const local = Vec.DEFAULT;
		void local;
	}
}

// Useless constructor (only forwards args to super). no-useless-constructor
// MUST report.
export class Sub extends Vec {
	constructor(x: number, y: number) {
		super(x, y);
	}
}

// Class generic shadowing class generic — no-shadow's
// isGenericOfAStaticMethodShadow filter handles the specific case
// where a static method's generic shadows the class's.
export class Container<T> {
	private items: T[] = [];
	add(item: T): void { this.items.push(item); }
	static of<T>(item: T): Container<T> {
		const c = new Container<T>();
		c.add(item);
		return c;
	}
}
