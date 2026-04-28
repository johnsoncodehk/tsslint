// Patterns: non-const enum, namespace, ambient module, declare global,
// interface declaration merging, type alias, abstract class.
// Hits: TSEnumName scope (non-const enum is a value); TSModuleName
// (namespace + ambient module declarations); declaration merging
// (interface + interface, namespace + namespace); abstract methods
// (TSAbstractMethodDefinition).

// Non-const enum — value-like, no-undef must NOT fire on Color refs.
export enum Color { Red = 'red', Green = 'green', Blue = 'blue' }

// Namespace with internal helpers + an exported function.
export namespace Util {
	export function clamp(min: number, max: number, x: number): number {
		return x < min ? min : x > max ? max : x;
	}
	// Use namespace-keyword (not module) — @typescript-eslint/prefer-
	// namespace-keyword should NOT fire (already namespace).
}

// Interface declaration merging — both halves contribute to the same
// type. no-redeclare typically skips this for TS interfaces.
export interface Box { kind: 'box'; }
export interface Box { width: number; height: number; }

// Type alias used before declaration via type-only reference —
// no-use-before-define with default `ignoreTypeReferences: true`
// must NOT report.
const _drawn: Drawn = { color: Color.Red };
void _drawn;
type Drawn = { color: Color };

// Abstract class with abstract method.
export abstract class Shape {
	abstract area(): number;
	describe(): string { return `area=${this.area()}`; }
}

// Ambient module declaration — `declare module "x"` is module
// augmentation. Inside, types are merged with the imported module.
declare module './_dep.js' {
	export interface AnyImport { extra?: number; }
}

// Type alias chain.
export type Length = number;
export type Width = Length;
