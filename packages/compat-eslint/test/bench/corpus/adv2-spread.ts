// Adv2: Spread in unusual positions. Spread of spread, deeply nested
// rest in destructure, spread inside computed key. Hits SpreadElement
// vs RestElement disambiguation, and no-useless-rename / prefer-spread.

// Spread of a fresh array containing spreads. CallExpression with
// SpreadElement that is itself an ArrayExpression of SpreadElements.
// prefer-spread might want to flag .apply, but there's no .apply here.
export function chained(arr: number[], other: number[]): number[] {
	return [...[...arr, ...other], 99];
}
void chained;

// f(...x) where x is spread again inside f's args.
export function callwise(arr: number[], other: number[]): number {
	return Math.max(...[...arr, ...other]);
}
void callwise;

// Deeply nested rest in destructure pattern — array → object → array.
// no-useless-rename must NOT fire here. RestElement inside both array
// and object patterns nested deeply.
export function nested({a: [b, ...rest]}: {a: number[]}): number[] {
	return [b, ...rest];
}
void nested;

// Object pattern with rest at end + nested array pattern with rest.
// `{ a: [x, ...xrest], ...orest }`
export function biRest(
	{ a: [x, ...xrest], ...orest }: { a: number[]; b?: number; c?: string }
): unknown[] {
	return [x, xrest, orest];
}
void biRest;

// Function default with spread expression inside the default value.
// `function f(arr = [...src])`.
const src = [1, 2, 3];
export function withSpread(arr: number[] = [...src]): number[] {
	return arr;
}
void withSpread;

// Spread in JSX-like spread call (just a call) inside a class method.
// Now FunctionExpression listener fires on the method body.
export class Builder {
	build(parts: string[][], ...rest: string[]): string[] {
		// Spread inside spread inside spread.
		return [...parts.flat(), ...rest, ...[...parts[0] ?? [], ...rest]];
	}
}
void Builder;

// Tagged template + spread combination — `tag\`${...arr}\`` is invalid
// but `tag\`${arr.join(',')}\`` with spread inside the call is fine.
function tag(strs: TemplateStringsArray, ...vals: unknown[]): string {
	return strs.join('') + vals.length;
}
const data = [1, 2, 3];
export const result = tag`prefix ${[...data].length} suffix`;
void result;

// Spread inside `new` expression — `new C(...args)`. NewExpression
// with SpreadElement argument.
class Box { constructor(public a: number, public b: number, public c: number) {} }
export const box = new Box(...([1, 2, 3] as const));
void box;

// `[, ...rest]` — array pattern with hole + rest. RestElement should
// fire; the hole is null. no-empty-pattern / no-useless-rename interplay.
export function holeRest([, ...rest]: number[]): number[] { return rest; }
void holeRest;

// Object spread inside an object pattern — `{ ...o, x } = obj`. Wait,
// `{...o, x}` is invalid as a pattern (rest must be last). So:
// `{ x, ...o } = obj`. Here `x` is the binding, `o` collects the rest.
export function destruct({ x, ...o }: { x: number; y: number; z: number }): unknown[] {
	return [x, o];
}
void destruct;
