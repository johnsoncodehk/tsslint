// Adversarial declaration merging: namespace+namespace, interface+namespace,
// class+namespace, declare global / module augmentation.
// Hits: scope-tree shape for TS-specific def merging, no-redeclare's
// merge-aware filter, no-shadow on merged identifiers, no-undef on
// global augmentation.

// namespace + namespace — same name, both contribute exports. Must
// NOT trip no-redeclare.
namespace Geom {
	export const PI = 3.14;
}
namespace Geom {
	export function area(r: number): number { return Geom.PI * r * r; }
}
void Geom.area(1);

// interface + namespace — interface contributes type, namespace
// contributes value. Must NOT trip no-redeclare.
interface Box { width: number; height: number }
namespace Box {
	export function make(w: number, h: number): Box { return { width: w, height: h }; }
}
void Box.make(1, 2);

// class + namespace — class is value+type, namespace adds members.
// Must NOT trip no-redeclare.
class Logger {
	constructor(public readonly tag: string) {}
}
namespace Logger {
	export const DEFAULT = new Logger('default');
	export function tagged(t: string): Logger { return new Logger(t); }
}
void Logger.DEFAULT;
void Logger.tagged('x');

// function + namespace — function declaration merged with namespace
// to attach properties (common for libraries like `Promise`).
function task(name: string): string { return `task:${name}`; }
namespace task {
	export const NONE = 'none';
}
void task('x');
void task.NONE;

// enum + namespace — enums can also be merged with namespaces to
// attach helper methods.
enum Color { Red, Green, Blue }
namespace Color {
	export function hex(c: Color): string { return ['#f00', '#0f0', '#00f'][c]; }
}
void Color.hex(Color.Red);

// declare global — augments globalThis. The `__APP_VERSION__` here
// must be visible in this file's scope; no-undef must NOT report.
declare global {
	const __APP_VERSION__: string;
	interface Window { __APP_FLAG__: boolean }
}
function readVersion(): string { return __APP_VERSION__; }
void readVersion;

// declare module — ambient module augmentation. The augmented module
// `'./_dep.js'` exists; `extra` is added there. Must NOT report
// no-undef on `extra` if accessed via import (not done here, just
// declarative).
declare module './_dep.js' {
	export const extra: number;
}

// Nested namespace — `Outer.Inner` is its own scope; `Inner` inside
// must resolve to the inner namespace, not free.
namespace Outer {
	export namespace Inner {
		export const value = 42;
	}
	export function read(): number { return Inner.value; }
}
void Outer.read;

// Namespace inside a function — local namespace; must not leak.
function withLocalNs(): number {
	namespace Local {
		export const x = 1;
	}
	return Local.x;
}
void withLocalNs;
