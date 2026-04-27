// Patterns: namespaces with const enums, function inside namespace,
// arguments inside non-arrow function, ECMAScript built-in globals.
// Hits: scope.through alias-aware via _variableBySymbol (no-undef
// on `arguments`, `Map`, `Object`); ECMAScript globals registered
// via addGlobals; meta.defaultOptions deep-merged (no-use-before-define
// const-enum case fires).

import { length } from "./_dep.js";
void length;

// const enum used before defined inside a namespace — should report
// no-use-before-define (after deep-merge of meta.defaultOptions
// supplies enums:true, ignoreTypeReferences:true defaults).
namespace Parser {
	export function isStart(): boolean {
		return Bar.A === 0;
	}
	export const enum Bar { A, B }
}
void Parser;

// `arguments` inside non-arrow function — must resolve to the
// synthetic argsVar via the alias-aware through filter; no-undef
// must NOT report.
function variadic() {
	if (arguments.length > 0) {
		return arguments[0];
	}
	return undefined;
}
void variadic;

// Built-in ECMAScript globals — Math, Set, JSON, Object, Array
// must NOT trip no-undef (registered via ESLINT_BUILTIN_GLOBALS).
function builtins() {
	const m = Math.PI;
	const s = new Set<number>();
	const j = JSON.stringify({});
	const o = Object.keys({});
	const a = Array.isArray([]);
	return { m, s, j, o, a };
}
void builtins;
