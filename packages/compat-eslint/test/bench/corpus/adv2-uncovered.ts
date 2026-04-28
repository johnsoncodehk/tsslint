// Adv2: Patterns prior passes didn't cover. dot-notation with optional
// chain, accessor-pairs with computed key, no-misleading-character-class,
// no-unmodified-loop-condition with nested loops, no-multi-assign,
// consistent-this, default-case-last edge cases.

// dot-notation with optional chain — `obj?.['x']` where `'x'` is a
// valid identifier. Must report (suggest `obj?.x`).
declare const maybe: { foo: number; bar?: string } | undefined;
void maybe?.['foo']; // dot-notation: suggest .foo
void maybe?.['bar']; // dot-notation: suggest .bar
void maybe?.['has-dash']; // OK — not a valid identifier

// dot-notation with computed access on a non-optional chain.
const x = { y: 1, z: 2 };
void x['y']; // dot-notation: suggest .y
void x['valid']; // not a property of x but still flagged

// accessor-pairs with computed key — pair-matching by string key.
// Both getter and setter use the SAME computed key.
export const obj1 = {
	get [`name`]() { return 'a'; },
	set [`name`](_v: string) { /* */ },
};
void obj1;

// accessor-pairs with computed key BUT only setter (no matching getter).
// Should report.
export const obj2 = {
	set [`name`](_v: string) { /* */ },
};
void obj2;

// consistent-this — `const that = this` outside of self/that exception.
// Default option only allows specific names.
export class Stash {
	cap(): void {
		const self = this;  // consistent-this default fires unless 'self' is in the list
		void self;
	}
	cap2(): void {
		const me = this;    // consistent-this fires
		void me;
	}
}
void Stash;

// no-multi-assign — chained `=` assignments.
let a, b, c;
a = b = c = 0; // no-multi-assign
void a; void b; void c;

// no-multi-assign with destructure.
let p, q;
[p, q] = [1, 2]; // simple, not multi.
void p; void q;

// Multi-assign as init in for loop.
for (let i = 0, j = 0; i < 10; i++, j++) {
	void i; void j;
}

// no-misleading-character-class — surrogate pair, ZWJ, combining marks.
// `/[👍]/u` — single emoji is fine, but `/[👨‍👩‍👧]/u` (ZWJ family)
// is misleading because it's actually 5 code points.
const emoji1 = /[😀]/u; // surrogate pair as single character class — misleading
const emoji2 = /[👨‍👩‍👧]/u;       // ZWJ sequence — misleading
const emoji3 = /[a-z]/;           // safe
void emoji1; void emoji2; void emoji3;

// Combining marks.
const combo = /[á]/; // 'á' as 2 code points (a + U+0301) — misleading
void combo;

// no-unmodified-loop-condition with nested loops — outer `cond`
// changes only via inner loop's last iteration. Inner has no
// modification of outer cond at all → outer flagged.
function nested(): void {
	let cond = true;
	while (cond) {            // unmodified-loop-condition: cond never changes in this body
		for (let i = 0; i < 1; i++) {
			void i;
			// no modification of cond
		}
		break; // breaks anyway, but the rule may still flag
	}
}
void nested;

// no-unmodified-loop-condition with condition referencing outer scope
// + nested loop that modifies it.
function maybeMod(): void {
	let cond = true;
	while (cond) {
		for (let i = 0; i < 5; i++) {
			if (i === 3) cond = false; // modification IS in inner loop
		}
	}
}
void maybeMod;

// default-case-last with throw between cases.
function dispatch(k: string): number {
	switch (k) {
		case 'a': return 1;
		default: throw new Error('unknown'); // default not last, follows
		case 'b': return 2;                  // default-case-last must report
	}
}
void dispatch;

// id-denylist — name in denylist appears as parameter, variable.
function inner(callback: () => void): void { callback(); } // 'callback' is denylisted
void inner;
const callback = () => 1; // also denylisted
void callback;
