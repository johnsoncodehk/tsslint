// Adv2: no-redeclare corner cases. Overload + impl, namespace + class
// merging, function declaration + var hoisting, function inside switch.
// Hits: scope-manager merging logic for declarations.

// Function overload signature + implementation. Identical name appears
// 3 times (2 sigs + 1 impl). no-redeclare must NOT report — these are
// overloads, not redeclarations.
export function over(x: number): string;
export function over(x: string): string;
export function over(x: unknown): string {
	return String(x);
}
void over(1); void over('a');

// Generic overload — same name with different generics.
export function gen<T>(x: T): T;
export function gen<T extends string>(x: T): T;
export function gen<T>(x: T): T { return x; }
void gen(1); void gen('a');

// Class + namespace merging. `Logger` declared as class + namespace.
class Logger { constructor(public tag: string) {} }
namespace Logger {
	export const DEFAULT = new Logger('def');
}
void Logger.DEFAULT;

// Function + namespace merging — same as class+ns.
function helper(s: string): string { return s; }
namespace helper {
	export const PREFIX = 'help-';
}
void helper('x'); void helper.PREFIX;

// `var foo` + `function foo` — historical hoisting overlap.
// In modern modules this should NOT trip no-redeclare for hoisted
// `function` followed by `var foo` referring to it.
function foo(): number { return 1; }
var foo: typeof foo;  // no-redeclare may report (interaction)
void foo();

// Function declared inside a switch case — separate cases. Two
// `inner` functions in different cases must NOT trip no-redeclare
// (block scope).
export function dispatch(k: 'a' | 'b'): number {
	switch (k) {
		case 'a': {
			function inner(): number { return 1; }
			return inner();
		}
		case 'b': {
			function inner(): number { return 2; } // not a redeclare (different block)
			return inner();
		}
		default:
			return 0;
	}
}
void dispatch;

// `var` redeclared at same block — IS a redeclare per ESLint, BUT
// since it's hoisted, scope-manager still treats them as one binding.
// no-redeclare classic case.
function legacy(): number {
	var n = 1;
	var n = 2; // no-redeclare must report (same block, var redeclared)
	return n;
}
void legacy;

// `let` redeclared in nested block — NOT a redeclare (different block).
function nested(): number {
	let n = 1;
	{
		let n = 2; // shadows, not redeclares
		return n;
	}
}
void nested;

// Class + interface merging — interface contributes type, class is
// value. no-redeclare must NOT fire.
export class Pair { constructor(public a: number, public b: number) {} }
export interface Pair { c?: number }
void new Pair(1, 2);

// Enum + interface merging.
export enum Color { Red, Green, Blue }
export interface Color { hex?: string }
void Color.Red;

// Conflicting class declarations — same name in same scope. SHOULD
// fire no-redeclare. (TypeScript would also error but that's separate.)
// Wrap in a function to keep block-local.
function bad(): void {
	class X { a = 1; }
	// @ts-expect-error -- redeclare
	class X { b = 2; } // no-redeclare must report
	void X;
}
void bad;
