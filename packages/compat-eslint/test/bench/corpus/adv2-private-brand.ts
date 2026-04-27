// Adv2: Class private brand check (`#field in obj`) — ES2022.
// BinaryExpression with `in` operator on a PrivateIdentifier as left side.
// Hits: BinaryExpression predicate + lazy-estree's PrivateIdentifier
// emission inside an `in` expression.

export class Branded {
	#brand = 'private';

	// Private brand check — `#brand in obj`. ESTree shape:
	// BinaryExpression { left: PrivateIdentifier, operator: 'in', right: ... }
	// no-unreachable + no-constant-binary-expression + no-self-compare
	// could all check this expression.
	static is(obj: unknown): obj is Branded {
		return typeof obj === 'object' && obj !== null && #brand in obj;
	}

	use(other: unknown): boolean {
		// Check brand on parameter, in conditional position.
		if (#brand in (other as object)) {
			return true;
		}
		return false;
	}
}
void Branded;

// Brand check inside a logical expression — short-circuits.
// no-mixed-operators interplay (mixing && / || / in).
export function checkBoth(a: unknown, b: unknown): boolean {
	const o1 = a as Branded;
	const o2 = b as Branded;
	void o1; void o2;
	return Branded.is(a) && Branded.is(b);
}
void checkBoth;

// Brand check that's always false (compile-time obvious — own type).
// no-constant-binary-expression should NOT report a private brand check
// (it depends on dynamic shape).
export class Maybe {
	#tag = 'maybe';
	test(o: unknown): string {
		// `#tag in o` is dynamic; not constant.
		return (#tag in (o as object)) ? 'yes' : 'no';
	}
}
void Maybe;

// Brand check inside a self-compare-shaped expression. no-self-compare
// shouldn't fire on `#x in obj === #x in obj` (different reads of the
// dynamic check; no-self-compare looks at strict-equal of structurally
// identical sides).
export class Twice {
	#x = 1;
	silly(o: unknown): boolean {
		const obj = o as object;
		return (#x in obj) === (#x in obj);
	}
}
void Twice;

// Private static method called via brand-checked `this`.
export class Private {
	static #helper(): number { return 42; }
	static probe(o: unknown): number {
		if (#helper in this) {
			return Private.#helper();
		}
		return -1;
	}
}
void Private;
