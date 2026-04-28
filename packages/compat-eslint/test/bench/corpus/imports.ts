// Patterns: namespace imports, type-only specifiers, re-exports.
// Hits scope-manager: TsDefinition.parent (ImportSpecifier walks past
// NamedImports to ImportDeclaration), getExportSpecifierLocalTargetSymbol.

import { length, type AnyImport, value } from "./_dep.js";
import * as ns from "./_ns.js";
import type DefaultType from "./_default.js";

// `length` import: type-only specifier in same block widens
// `no-shadow`'s isTypeValueShadow filter — must skip param shadows.
function f1(start: number, length: number) {
	return start + length;
}

// `value` import (regular value): different filter behavior — should
// still report shadow.
function f2(value: number) {
	return value * 2;
}

// `import * as ns; export { ns };` — alias symbol differs from import
// binding. ExportSpecifier name must resolve via
// getExportSpecifierLocalTargetSymbol to count as a local reference,
// not an undefined-global through.
export { ns };

// `import type` is value-shadow-safe.
const _t: DefaultType = null as any;
const _a: AnyImport = null as any;
void _t;
void _a;
