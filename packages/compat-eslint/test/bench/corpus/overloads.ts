// Patterns: function overloads, exported overloads (wrapped in
// ExportNamedDeclaration), nested overloaded function-in-function.
// Hits scope-manager: TsDefinition.node + scope.block unwrap export
// wrappers (no-redeclare); isFunctionTypeParameterNameValueShadow
// (no-shadow skip on TSDeclareFunction params).

import { join } from "./_join.js";

// Top-level overloaded export — no-redeclare must report 2 dupes.
export function format(value: number): string;
export function format(value: string): string;
export function format(value: number | string): string {
	return String(value);
}

// Nested overloaded inside exported function — scope.block previously
// returned ExportNamedDeclaration, didn't === FunctionDeclaration node,
// so the nested scope's variables were never walked.
export function makeFactory() {
	function build(token: number): { kind: number };
	function build(token: string): { kind: string };
	function build(token: number | string) {
		return { kind: token } as any;
	}
	return build;
}

// Param name shadows imported function — should be skipped on
// TSDeclareFunction (overload sigs), reported on FunctionDeclaration
// (impl). Pattern matches TS repo `forEachEntry(map, ...)`.
function consume(join: string): void;
function consume(join: number, b: number): void;
function consume(join: string | number, _b?: number): void {
	void join;
}
void consume;
