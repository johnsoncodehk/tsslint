// Patterns: array / object destructuring, computed-key destructure,
// for-of/for-in `const` bindings.
// Hits: getDeclaredVariables walks BindingPattern (prefer-const);
// TsDefinition.parent for-init points at VariableDeclarationList
// (no-loop-func); BindingElement.computed reflects ComputedPropertyName
// (no-useless-computed-key).

interface Bag {
	"resolution-mode"?: string;
	x: number;
	y: number;
}

// Computed-key destructure with a kebab-case literal — keep the
// computed brackets, no-useless-computed-key MUST report (key needs
// quotes either way, but the rule treats destructure-pattern Property
// as "report any computed").
function pull(arg: Bag) {
	const { ["resolution-mode"]: res, x, y } = arg;
	return { res, x, y };
}
void pull;

// Array destructure with mixed reassign — prefer-const reports each
// non-reassigned binding individually under default `destructuring:
// "any"`. Mirrors TS repo `moduleSpecifiers.ts:407`.
export function consumeTuple(arr: [number, string, object, number[], Set<number> | undefined]) {
	let [kind, specifiers, moduleSourceFile, modulePaths, cache] = arr;
	if (specifiers) return kind;
	if (!moduleSourceFile) return undefined;
	modulePaths ||= [];
	cache?.add(modulePaths.length);
	return modulePaths.length;
}

// for-of `const` binding — no-loop-func must NOT report (block-scoped).
export function loop(items: number[]) {
	const out: (() => number)[] = [];
	for (const x of items) {
		out.push(() => x);
	}
	return out;
}

// `var` for-init — no-loop-func MUST report (function-scoped).
export function loopVar(items: number[]) {
	const out: (() => number)[] = [];
	for (var i = 0; i < items.length; i++) {
		out.push(() => items[i]);
	}
	return out;
}

// Destructure-able member access — prefer-destructuring MUST report
// (`const x = obj.x` should be `const { x } = obj`).
export function pickX(obj: { x: number, y: number }): number {
	const x = obj.x; // prefer-destructuring
	return x;
}

// Already destructured — MUST NOT report.
export function pickY(obj: { x: number, y: number }): number {
	const { y } = obj;
	return y;
}

// Indexed array access — prefer-destructuring with `array: true` reports.
export function firstOf(arr: number[]): number {
	const first = arr[0]; // prefer-destructuring (array)
	return first;
}

// Parameter reassignment — no-param-reassign MUST report.
export function clamp(x: number, min: number, max: number): number {
	if (x < min) x = min;        // no-param-reassign
	else if (x > max) x = max;   // no-param-reassign
	return x;
}

// Reassigning a destructured parameter — same rule, different shape.
export function nudge({ x, y }: { x: number, y: number }): number {
	x = x + 1; // no-param-reassign
	return x + y;
}
