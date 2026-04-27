// Adversarial computed property names: well-known symbols, template
// literals with interpolation, side-effecting expressions, computed
// keys on classes / objects / interfaces.
// Hits: scope.through resolution from computed-key positions
// (which evaluate in OUTER scope, not the class/object scope),
// no-useless-computed-key shape detection, no-shadow of names
// referenced from computed keys.

const prefix = 'prefix';
const idx = 0;
function nameFor(i: number): string { return `key_${i}`; }
let counter = 0;
function bump(): number { return ++counter; }

// Class with [Symbol.iterator] computed method — `Symbol` is a
// global value reference; must resolve via builtin globals.
export class Range {
	constructor(public lo: number, public hi: number) {}
	*[Symbol.iterator](): Iterator<number> {
		for (let i = this.lo; i < this.hi; i++) yield i;
	}
}
void new Range(0, 3);

// Class with [Symbol.toPrimitive] — second well-known symbol.
export class Money {
	constructor(public cents: number) {}
	[Symbol.toPrimitive](hint: string): number | string {
		if (hint === 'string') return `$${this.cents / 100}`;
		return this.cents;
	}
}
void new Money(100);

// Object literal with template-literal computed key — references
// outer `prefix` and `idx`. Both must resolve in outer scope.
const obj1 = {
	[`${prefix}-${idx}`]: 1,
	[`static`]: 2,
};
void obj1;

// Object literal with side-effecting computed keys — `bump()`
// evaluates in outer scope. The function reference must resolve;
// `counter` reads/writes via the function body.
const obj2 = {
	[bump()]: 'a',
	[bump()]: 'b',
	[nameFor(idx)]: 'c',
};
void obj2;

// Class with computed method name — `nameFor` invocation in computed
// key position. Tests through-scope resolution from class member key.
export class Methods {
	[nameFor(0)](): string { return 'zero'; }
	[`${prefix}_one`](): string { return 'one'; }
	static [Symbol.hasInstance](_x: unknown): boolean { return false; }
}
void new Methods();

// Computed key referencing a class's OWN type parameter — illegal in
// runtime sense (T is type-only) but the reference appears at
// computed-key position. ESLint's scope-manager treats class type
// params as visible inside the class scope; the computed key
// position should still see them.
export class Holder<T extends string> {
	// T is type-position here; should not trip no-undef.
	private items: Record<T, number> = {} as any;
	get(k: T): number { return this.items[k]; }
}
void new Holder<'x'>();

// Useless computed key — string literal that doesn't need brackets.
// no-useless-computed-key MUST report.
const obj3 = {
	['plain']: 1,           // useless — string literal key
	[42]: 2,                // useless — numeric literal key
	[`interp${idx}`]: 3,    // NOT useless — interpolation
};
void obj3;

// Computed key inside a destructure pattern — the computed key is
// re-used to extract the value. References outer `prefix`.
function pull(o: Record<string, number>): number {
	const { [`${prefix}-key`]: v = 0 } = o;
	return v;
}
void pull;

// Class field with computed name — PropertyDefinition with computed:true.
export class Fields {
	[Symbol.iterator] = function*() { yield 1; };
	[`computed_${idx}`] = 'value';
}
void new Fields();

// Computed key referencing a name that IS shadowed in inner scope —
// the computed key sees the OUTER. If scope-manager mistakes the
// class scope for the resolution scope, no-shadow may fire here.
const ambient = 'outer';
class WithAmbient {
	[ambient] = 1;
	use(ambient: string): string { return ambient; }  // param shadows outer
}
void WithAmbient;
