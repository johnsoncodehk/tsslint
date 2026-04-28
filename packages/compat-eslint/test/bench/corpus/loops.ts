// Patterns: for-of / for-in with const/let/var bindings, while,
// do-while, labelled break/continue, infinite loops, unmodified
// loop conditions.
// Hits: no-loop-func (binding kind detection via def.parent kind);
// no-unreachable-loop; no-unmodified-loop-condition; block-scoped-var;
// no-useless-return inside loop; no-await-in-loop pattern.

// for-of with const — no-loop-func MUST NOT report (block-scoped).
export function makeCallbacks(items: number[]) {
	const out: (() => number)[] = [];
	for (const x of items) {
		out.push(() => x);
	}
	return out;
}

// for-of with let — also block-scoped, no-loop-func MUST NOT report.
export function makeCallbacksLet(items: number[]) {
	const out: (() => number)[] = [];
	for (let x of items) {
		out.push(() => x);
		x++;
	}
	return out;
}

// for-init with var (function-scoped) — no-loop-func MUST report
// because the closure captures the SAME binding across iterations.
export function makeCallbacksVar(items: number[]) {
	const out: (() => number)[] = [];
	for (var i = 0; i < items.length; i++) {
		out.push(() => items[i]);
	}
	return out;
}

// for-in over object keys.
export function keyList(obj: Record<string, number>): string[] {
	const out: string[] = [];
	for (const key in obj) {
		out.push(key);
	}
	return out;
}

// while loop with unmodified condition — no-unmodified-loop-condition
// MUST report `flag` is never reassigned.
export function spin(flag: boolean): void {
	while (flag) {
		// flag never changes
		break;
	}
}

// do-while loop.
export function readUntil(read: () => number, sentinel: number): number[] {
	const out: number[] = [];
	let v: number;
	do {
		v = read();
		if (v !== sentinel) out.push(v);
	} while (v !== sentinel);
	return out;
}

// Labelled break — exercise label scope handling.
export function findFirst(grid: number[][], target: number): [number, number] | null {
	outer: for (let i = 0; i < grid.length; i++) {
		for (let j = 0; j < grid[i].length; j++) {
			if (grid[i][j] === target) {
				return [i, j];
			}
			if (j === target) {
				break outer;
			}
		}
	}
	return null;
}
