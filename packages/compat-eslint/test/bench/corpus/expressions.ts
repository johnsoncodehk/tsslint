// Patterns: template literals (tagged + untagged), spread / rest,
// async / await, arrow functions, dynamic import, tagged templates,
// type assertions (`as`, `<T>`, `as const`), satisfies operator,
// nullish operator chains, computed property keys.
// Hits: TemplateLiteral / TaggedTemplateExpression dispatch;
// SpreadElement / RestElement; ArrowFunctionExpression scope;
// AwaitExpression; CallExpression with import; AssertExpression /
// TSAsExpression; TSSatisfiesExpression.

// Untagged template + tagged template.
const inline = `simple ${1 + 2}`;
const tag = (strings: TemplateStringsArray, ...values: unknown[]) => strings.join('|') + values.length;
const tagged = tag`hello ${42} world`;
void inline;
void tagged;

// Spread + rest.
export function variadic(...args: number[]): number {
	return args.reduce((a, b) => a + b, 0);
}
const nums = [1, 2, 3];
const total = variadic(...nums);
void total;

// Object spread + computed keys.
const base = { a: 1, b: 2 };
const extended = { ...base, ['c-key']: 3 };
void extended;

// Async / await + arrow function.
export const fetchOnce = async <T>(url: string, parse: (raw: string) => T): Promise<T> => {
	const raw = await Promise.resolve(url);
	return parse(raw);
};

// Dynamic import (import expression).
export async function lazy() {
	const mod = await import('./_dep.js');
	return mod.length;
}

// Type assertions — `as`, `as const`, `satisfies`.
const literal = 'on' as const;
const asNumber = (1 as unknown) as number;
const sat = { kind: 'box' as const, w: 10 } satisfies { kind: 'box'; w: number };
void literal;
void asNumber;
void sat;

// Optional chaining call.
export function callIfFn(maybe: (() => number) | undefined) {
	return maybe?.() ?? 0;
}
