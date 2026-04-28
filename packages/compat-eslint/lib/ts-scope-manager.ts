// TS-backed reimplementation of @typescript-eslint/scope-manager's surface.
//
// Approach: walk the TS AST once at construction time, build a scope tree that
// matches @typescript-eslint/scope-manager's shape (so ESLint rules see the
// same structure they would from the upstream analyzer). Variables and refs
// are populated lazily per scope. The TS type checker is queried lazily for
// reference resolution.
//
// Scope kind dispatch is keyed off TS SyntaxKind directly — not `node.locals`,
// which only contains a subset of ES bindings (var hoisting + let/const) and
// would miss block-scopes-without-decls that ESLint expects.

import type { TSESTree } from '@typescript-eslint/types';
import ts = require('typescript');

type AstMaps = {
	esTreeNodeToTSNodeMap: WeakMap<TSESTree.Node, ts.Node>;
	tsNodeToESTreeNodeMap: WeakMap<ts.Node, TSESTree.Node>;
};

// ECMAScript built-in globals, vendored from `eslint/conf/globals.js`'s
// `es2026` (the latest superset). ESLint core registers these via
// `addDeclaredGlobals` before rules run; the constructor below mirrors
// that step so `no-undef` doesn't fire on `undefined`, `Math`, `String`,
// `Array`, etc. — names that `@typescript-eslint/scope-manager`'s lib
// data marks TYPE-only after merging (`es2015.core` re-declares es5's
// `TYPE_VALUE Math` as `TYPE`, etc.). Update if ESLint adds a new ES
// year.
const ESLINT_BUILTIN_GLOBALS: readonly string[] = [
	'AggregateError',
	'Array',
	'ArrayBuffer',
	'AsyncDisposableStack',
	'Atomics',
	'BigInt',
	'BigInt64Array',
	'BigUint64Array',
	'Boolean',
	'DataView',
	'Date',
	'DisposableStack',
	'Error',
	'EvalError',
	'FinalizationRegistry',
	'Float16Array',
	'Float32Array',
	'Float64Array',
	'Function',
	'Infinity',
	'Int16Array',
	'Int32Array',
	'Int8Array',
	'Intl',
	'Iterator',
	'JSON',
	'Map',
	'Math',
	'NaN',
	'Number',
	'Object',
	'Promise',
	'Proxy',
	'RangeError',
	'ReferenceError',
	'Reflect',
	'RegExp',
	'Set',
	'SharedArrayBuffer',
	'String',
	'SuppressedError',
	'Symbol',
	'SyntaxError',
	'Temporal',
	'TypeError',
	'URIError',
	'Uint16Array',
	'Uint32Array',
	'Uint8Array',
	'Uint8ClampedArray',
	'WeakMap',
	'WeakRef',
	'WeakSet',
	'constructor',
	'decodeURI',
	'decodeURIComponent',
	'encodeURI',
	'encodeURIComponent',
	'escape',
	'eval',
	'globalThis',
	'hasOwnProperty',
	'isFinite',
	'isNaN',
	'isPrototypeOf',
	'parseFloat',
	'parseInt',
	'propertyIsEnumerable',
	'toLocaleString',
	'toString',
	'undefined',
	'unescape',
	'valueOf',
];

// TypeScript built-in lib type globals. Vendored union of every TYPE-tagged
// name across `@typescript-eslint/scope-manager`'s `dist/lib/es*.js`
// (es5 / es2015–es2025 / esnext, including sub-libs like
// `es2015.collection`, `es2024.regexp`, etc.). Excludes DOM / decorators /
// scripthost (environment-specific — opting in would silence undef on
// browser-only names in pure-Node code, which over-silences). Registering
// these via `addGlobals` makes type-position references to lib utility
// types (`Record<K, V>`, `Promise<T>`, `Awaited<T>`, …) resolve cleanly
// even when only a partial lib is loaded — without this, our type-position
// guard had to silence ALL type-position freeRefs, hiding ESLint's
// no-undef on real undeclared type names (`NodeJS.ErrnoException`,
// `Visitor`).
const TS_LIB_TYPE_GLOBALS: readonly string[] = [
	'AggregateError',
	'AggregateErrorConstructor',
	'Array',
	'ArrayBuffer',
	'ArrayBufferConstructor',
	'ArrayBufferLike',
	'ArrayBufferTypes',
	'ArrayBufferView',
	'ArrayConstructor',
	'ArrayIterator',
	'ArrayLike',
	'AsyncDisposable',
	'AsyncDisposableStack',
	'AsyncDisposableStackConstructor',
	'AsyncGenerator',
	'AsyncGeneratorFunction',
	'AsyncGeneratorFunctionConstructor',
	'AsyncIterable',
	'AsyncIterableIterator',
	'AsyncIterator',
	'AsyncIteratorObject',
	'Atomics',
	'Awaited',
	'BigInt',
	'BigInt64Array',
	'BigInt64ArrayConstructor',
	'BigIntConstructor',
	'BigIntToLocaleStringOptions',
	'BigUint64Array',
	'BigUint64ArrayConstructor',
	'Boolean',
	'BooleanConstructor',
	'BuiltinIteratorReturn',
	'CallableFunction',
	'Capitalize',
	'ConcatArray',
	'ConstructorParameters',
	'DataView',
	'DataViewConstructor',
	'Date',
	'DateConstructor',
	'Disposable',
	'DisposableStack',
	'DisposableStackConstructor',
	'Error',
	'ErrorConstructor',
	'ErrorOptions',
	'EvalError',
	'EvalErrorConstructor',
	'Exclude',
	'Extract',
	'FinalizationRegistry',
	'FinalizationRegistryConstructor',
	'FlatArray',
	'Float16Array',
	'Float16ArrayConstructor',
	'Float32Array',
	'Float32ArrayConstructor',
	'Float64Array',
	'Float64ArrayConstructor',
	'Function',
	'FunctionConstructor',
	'Generator',
	'GeneratorFunction',
	'GeneratorFunctionConstructor',
	'IArguments',
	'ImportAssertions',
	'ImportAttributes',
	'ImportCallOptions',
	'ImportMeta',
	'InstanceType',
	'Int16Array',
	'Int16ArrayConstructor',
	'Int32Array',
	'Int32ArrayConstructor',
	'Int8Array',
	'Int8ArrayConstructor',
	'Intl',
	'Iterable',
	'IterableIterator',
	'Iterator',
	'IteratorObject',
	'IteratorObjectConstructor',
	'IteratorResult',
	'IteratorReturnResult',
	'IteratorYieldResult',
	'JSON',
	'Lowercase',
	'Map',
	'MapConstructor',
	'MapIterator',
	'Math',
	'NewableFunction',
	'NoInfer',
	'NonNullable',
	'Number',
	'NumberConstructor',
	'Object',
	'ObjectConstructor',
	'Omit',
	'OmitThisParameter',
	'Parameters',
	'Partial',
	'Pick',
	'Promise',
	'PromiseConstructor',
	'PromiseConstructorLike',
	'PromiseFulfilledResult',
	'PromiseLike',
	'PromiseRejectedResult',
	'PromiseSettledResult',
	'PromiseWithResolvers',
	'PropertyDescriptor',
	'PropertyDescriptorMap',
	'PropertyKey',
	'ProxyConstructor',
	'ProxyHandler',
	'RangeError',
	'RangeErrorConstructor',
	'Readonly',
	'ReadonlyArray',
	'ReadonlyMap',
	'ReadonlySet',
	'ReadonlySetLike',
	'Record',
	'ReferenceError',
	'ReferenceErrorConstructor',
	'Reflect',
	'RegExp',
	'RegExpConstructor',
	'RegExpExecArray',
	'RegExpIndicesArray',
	'RegExpMatchArray',
	'RegExpStringIterator',
	'Required',
	'ReturnType',
	'Set',
	'SetConstructor',
	'SetIterator',
	'SharedArrayBuffer',
	'SharedArrayBufferConstructor',
	'String',
	'StringConstructor',
	'StringIterator',
	'SuppressedError',
	'SuppressedErrorConstructor',
	'Symbol',
	'SymbolConstructor',
	'SyntaxError',
	'SyntaxErrorConstructor',
	'TemplateStringsArray',
	'Temporal',
	'ThisParameterType',
	'ThisType',
	'TypeError',
	'TypeErrorConstructor',
	'TypedPropertyDescriptor',
	'URIError',
	'URIErrorConstructor',
	'Uint16Array',
	'Uint16ArrayConstructor',
	'Uint32Array',
	'Uint32ArrayConstructor',
	'Uint8Array',
	'Uint8ArrayConstructor',
	'Uint8ClampedArray',
	'Uint8ClampedArrayConstructor',
	'Uncapitalize',
	'Uppercase',
	'WeakKey',
	'WeakKeyTypes',
	'WeakMap',
	'WeakMapConstructor',
	'WeakRef',
	'WeakRefConstructor',
	'WeakSet',
	'WeakSetConstructor',
	// Decorator types (from `lib.decorators*.d.ts`). Includes both stage-3
	// (ClassMethodDecoratorContext etc.) and legacy (ClassDecorator,
	// MethodDecorator, PropertyDecorator, ParameterDecorator).
	'ClassMemberDecoratorContext',
	'DecoratorContext',
	'DecoratorMetadataObject',
	'DecoratorMetadata',
	'ClassDecoratorContext',
	'ClassMethodDecoratorContext',
	'ClassGetterDecoratorContext',
	'ClassSetterDecoratorContext',
	'ClassAccessorDecoratorContext',
	'ClassAccessorDecoratorTarget',
	'ClassAccessorDecoratorResult',
	'ClassFieldDecoratorContext',
	'ClassDecorator',
	'PropertyDecorator',
	'MethodDecorator',
	'ParameterDecorator',
];

// Lib globals that upstream's `analyze({ lib: ['esnext'] })` exposes as values
// (i.e. `isValueVariable === true`) after resolving the lib chain. Most lib
// names are type-only because later libs (e.g. `esnext.collection`) override
// es5/es2015's TYPE_VALUE entries with TYPE. Captured empirically from a
// minimal analyze() run; refresh if upstream's lib data changes.
const LIB_VALUE_GLOBALS = new Set([
	'AggregateError',
	'AsyncDisposableStack',
	'BigInt',
	'Boolean',
	'DisposableStack',
	'EvalError',
	'FinalizationRegistry',
	'Float16Array',
	'Intl',
	'Iterator',
	'Object',
	'RangeError',
	'ReferenceError',
	'Reflect',
	'SuppressedError',
	'SyntaxError',
	'Temporal',
	'TypeError',
	'URIError',
	'WeakRef',
]);

// Scope kinds we tag. Names match upstream casing (e.g. 'tsEnum', 'tsModule').
type ScopeType =
	| 'global'
	| 'module'
	| 'function'
	| 'block'
	| 'switch'
	| 'for'
	| 'catch'
	| 'with'
	| 'class'
	| 'class-field-initializer'
	| 'function-expression-name'
	| 'tsEnum'
	| 'tsModule'
	| 'type'
	| 'function-type'
	| 'mapped-type'
	| 'conditional-type';

type DefinitionType =
	| 'CatchClause'
	| 'ClassName'
	| 'FunctionName'
	| 'ImplicitGlobalVariable'
	| 'ImportBinding'
	| 'Parameter'
	| 'TDZ'
	| 'Variable'
	| 'Type'
	| 'TSEnumName'
	| 'TSEnumMember'
	| 'TSModuleName';

// _classifyIdentifier dispatch bitmaps. Hot path: ~120k identifiers/file
// run through this method. Most identifiers (~90%) have a parent.kind that
// falls through the switch's `default` returning `0b11` (both flags true)
// — a single Uint8Array lookup short-circuits before entering the switch.
// A second bitmap covers the large fall-through case body that just does
// `name === id ? 0 : 0b11` — also collapses out of the switch.
const _SK_CLASSIFY_BITMAP_SIZE = 400;
const _CLASSIFY_HANDLED_KINDS = new Uint8Array(_SK_CLASSIFY_BITMAP_SIZE);
const _CLASSIFY_NAME_SLOT_KINDS = new Uint8Array(_SK_CLASSIFY_BITMAP_SIZE);
(() => {
	const SK = ts.SyntaxKind;
	// Fall-through "name slot" cases — body is `(p as { name }).name === id ? 0 : 0b11`.
	const nameSlotKinds = [
		SK.PropertyDeclaration,
		SK.PropertySignature,
		SK.PropertyAssignment,
		SK.MethodDeclaration,
		SK.MethodSignature,
		SK.GetAccessor,
		SK.SetAccessor,
		SK.EnumMember,
		SK.FunctionDeclaration,
		SK.FunctionExpression,
		SK.ClassDeclaration,
		SK.ClassExpression,
		SK.EnumDeclaration,
		SK.ModuleDeclaration,
		SK.TypeAliasDeclaration,
		SK.InterfaceDeclaration,
		SK.TypeParameter,
		SK.ImportClause,
		SK.NamespaceImport,
		SK.ImportEqualsDeclaration,
		SK.NamedTupleMember,
		SK.JsxAttribute,
	];
	for (const k of nameSlotKinds) {
		_CLASSIFY_NAME_SLOT_KINDS[k] = 1;
		_CLASSIFY_HANDLED_KINDS[k] = 1;
	}
	// All other kinds with a dedicated case body in the switch.
	const otherHandled = [
		SK.PropertyAccessExpression,
		SK.QualifiedName,
		SK.LabeledStatement,
		SK.BreakStatement,
		SK.ContinueStatement,
		SK.MetaProperty,
		SK.ImportSpecifier,
		SK.VariableDeclaration,
		SK.BindingElement,
		SK.Parameter,
		SK.ExportSpecifier,
		SK.TypeReference,
		SK.ImportType,
	];
	for (const k of otherHandled) _CLASSIFY_HANDLED_KINDS[k] = 1;
})();

// Module-level caches keyed by ts.Program. Lib symbols (`Object`, `Array`,
// `String` …) are stable per-program — IDEs share one program across all
// files, so the same set of lib symbols gets queried over and over. Caching
// per-instance (per-file) means every file rebuilds the same decisions.
// WeakMap lets entries fall away when a program is GC'd.
const _libDecisionByProgram = new WeakMap<ts.Program, Map<ts.Symbol, 0 | 1>>();
const _libSourceFileByProgram = new WeakMap<ts.Program, WeakMap<ts.SourceFile, boolean>>();

function _getLibDecisionMap(program: ts.Program): Map<ts.Symbol, 0 | 1> {
	let m = _libDecisionByProgram.get(program);
	if (!m) _libDecisionByProgram.set(program, m = new Map());
	return m;
}
function _getLibSourceFileMap(program: ts.Program): WeakMap<ts.SourceFile, boolean> {
	let m = _libSourceFileByProgram.get(program);
	if (!m) _libSourceFileByProgram.set(program, m = new WeakMap());
	return m;
}

// Module-level cache of fake `ts.Symbol` placeholders for ESLint declared
// globals. The shape `{ name, declarations: [], flags: 0 }` is completely
// stateless — same fake works for every file's `TsScopeManager`. Without
// this, every `getEstree` would alloc 250+ throwaway plain objects.
//
// `_variableBySymbol` is still per-manager, so the wrapper `TsVariable`
// is per-file (it carries `manager`, `references` are file-local). But
// the symbol that keys it can — and should — be shared.
const _SHARED_FAKE_GLOBAL_SYMBOLS = new Map<string, ts.Symbol>();
function _sharedFakeGlobalSymbol(name: string): ts.Symbol {
	let s = _SHARED_FAKE_GLOBAL_SYMBOLS.get(name);
	if (!s) {
		s = { name, declarations: [], flags: 0 } as unknown as ts.Symbol;
		_SHARED_FAKE_GLOBAL_SYMBOLS.set(name, s);
	}
	return s;
}

// Public surface mirrors `@typescript-eslint/scope-manager`'s
// `ScopeManager` class (`scope-manager/dist/ScopeManager.js`):
// `scopes`, `globalScope`, `getDeclaredVariables`, `acquire`,
// plus the boolean accessors (`isGlobalReturn`, `isModule`, …)
// that ESLint's `Linter` reads at scope-construction time.
//
// Construction is intentionally LAZY: the upstream `Referencer`
// walks the entire AST eagerly to build the scope tree and
// classify every reference. We split that into a single-pass
// scope-tree walk (`_buildScopeTree`) plus a deferred reference
// classification (`_ensureRefIndex`) triggered by the first
// `scope.through` / `var.references` / `getReferencesFor` read.
// Most rules only ever read a small subset of refs.
export class TsScopeManager {
	scopes: TsScope[] = [];
	globalScope!: TsScope;
	moduleScope: TsScope | null = null;
	declaredVariables = new WeakMap<TSESTree.Node, TsVariable[]>();
	nodeToScope = new Map<ts.Node, TsScope[]>();
	currentScope: TsScope | null = null;

	_variableBySymbol = new Map<ts.Symbol, TsVariable>();
	_libVariableBySymbol = new Map<ts.Symbol, TsVariable>();
	_libDecisionBySymbol: Map<ts.Symbol, 0 | 1>;
	_libSourceFileCache: WeakMap<ts.SourceFile, boolean>;
	_syntheticArguments = new Map<TsScope, TsVariable>();
	readonly checker: ts.TypeChecker;

	constructor(
		readonly tsFile: ts.SourceFile,
		readonly program: ts.Program,
		readonly estree: TSESTree.Program,
		readonly astMaps: AstMaps,
		readonly sourceType: 'module' | 'script',
	) {
		this.checker = program.getTypeChecker();
		// Per-program caches — share lib decisions across every file in the
		// same ts.Program (typical IDE setup is one program for the whole
		// project). Per-file managers all hit the same Map / WeakMap.
		this._libDecisionBySymbol = _getLibDecisionMap(program);
		this._libSourceFileCache = _getLibSourceFileMap(program);
		// Build scope tree by walking the TS AST. ESLint built-in globals
		// are NOT injected here — that's a lint-pipeline policy, not a
		// scope-analysis fact. `applyEslintGlobals(manager)` is the
		// pipeline-side hook (see compat-eslint/index.ts).
		this._buildScopeTree();
	}

	// Identifiers picked up during the scope-tree walk; classified once after
	// scope variables are populated (so we know which symbols are "ours").
	_pendingIdentifiers: ts.Identifier[] = [];

	_buildScopeTree() {
		this.globalScope = new TsScope(this, this.tsFile, 'global', null);
		this._registerScope(this.tsFile, this.globalScope);

		let topScope: TsScope = this.globalScope;
		if (this.sourceType === 'module') {
			this.moduleScope = new TsScope(this, this.tsFile, 'module', this.globalScope);
			this._registerScope(this.tsFile, this.moduleScope);
			topScope = this.moduleScope;
		}
		this.currentScope = topScope;

		// Single AST walk: build scope tree + collect identifiers for later
		// classification. We thread `currentParent` through a stack-style
		// save/restore around the recursion so `forEachChild` can take a single
		// stable callback (no per-call arrow allocation).
		const SK_Identifier = ts.SyntaxKind.Identifier;
		const SK_ConditionalType = ts.SyntaxKind.ConditionalType;
		const idents = this._pendingIdentifiers;
		let currentParent: TsScope = topScope;
		const walk = (n: ts.Node) => {
			const prevParent = currentParent;
			const created = this._createScopesFor(n, prevParent);
			if (created) currentParent = created;
			if (n.kind === SK_Identifier) idents.push(n as ts.Identifier);
			// Conditional type: only `trueType` lives inside the conditional-type
			// scope (where `infer X` is accessible). `checkType`, `extendsType`,
			// `falseType` walk in the OUTER scope. Without this split, a nested
			// conditional in `falseType` becomes a child of the outer conditional-
			// type scope, and its `infer X` shadows the outer's `infer X`.
			// Repro: `type U<T> = T extends Array<infer U> ? U : T extends Promise<infer U> ? U : T;`
			// — no-shadow incorrectly reported the second `infer U`.
			if (n.kind === SK_ConditionalType) {
				const cond = n as ts.ConditionalTypeNode;
				currentParent = prevParent;
				walk(cond.checkType);
				walk(cond.extendsType);
				if (created) currentParent = created;
				walk(cond.trueType);
				currentParent = prevParent;
				walk(cond.falseType);
			}
			else {
				ts.forEachChild(n, walk);
			}
			currentParent = prevParent;
		};
		ts.forEachChild(this.tsFile, walk);
	}

	_registerScope(tsNode: ts.Node, scope: TsScope) {
		this.scopes.push(scope);
		let arr = this.nodeToScope.get(tsNode);
		if (!arr) {
			this.nodeToScope.set(tsNode, arr = []);
		}
		arr.push(scope);
	}

	// For nodes that are themselves scope-creating, build the appropriate scope
	// (or pair of scopes, for named function expressions). Returns the innermost
	// scope created, so its descendants live in it.
	_createScopesFor(n: ts.Node, parent: TsScope): TsScope | undefined {
		const SK = ts.SyntaxKind;
		// Class field initializer: `class C { f = expr }` — `expr` is in its
		// own scope so `this` and (in the future) other class-field-only
		// constructs resolve correctly. Detected before the kind-switch
		// because the scope's boundary is the initializer node itself, which
		// can be any expression kind.
		const np = n.parent;
		if (
			np
			&& np.kind === SK.PropertyDeclaration
			&& (np as ts.PropertyDeclaration).initializer === n
		) {
			return new TsScope(this, n, 'class-field-initializer', parent, true);
		}
		switch (n.kind) {
			case SK.FunctionDeclaration:
			case SK.ArrowFunction:
			case SK.MethodDeclaration:
			case SK.Constructor:
			case SK.GetAccessor:
			case SK.SetAccessor:
				return new TsScope(this, n, 'function', parent, true);
			case SK.FunctionExpression: {
				// Named function expressions get a wrapping
				// `function-expression-name` scope; inner function scope is its
				// child.
				const name = (n as ts.FunctionExpression).name;
				const outer = name
					? new TsScope(this, n, 'function-expression-name', parent, true)
					: parent;
				return new TsScope(this, n, 'function', outer, true);
			}
			case SK.ClassDeclaration:
			case SK.ClassExpression:
				return new TsScope(this, n, 'class', parent, true);
			case SK.Block: {
				// Block as a function/method body is NOT its own scope; the
				// function scope already covers it. Free-standing blocks are.
				const pk = n.parent?.kind;
				if (
					pk === SK.FunctionDeclaration
					|| pk === SK.FunctionExpression
					|| pk === SK.ArrowFunction
					|| pk === SK.MethodDeclaration
					|| pk === SK.Constructor
					|| pk === SK.GetAccessor
					|| pk === SK.SetAccessor
				) return undefined;
				return new TsScope(this, n, 'block', parent, true);
			}
			case SK.ForStatement:
			case SK.ForInStatement:
			case SK.ForOfStatement: {
				// Upstream nests a 'for' scope only when the init clause is a
				// let/const declaration (block-scoped binding). For
				// `for (a in xs)` or `for (var x = …)` the loop binding lives
				// in the enclosing scope.
				const init = n.kind === SK.ForStatement
					? (n as ts.ForStatement).initializer
					: (n as ts.ForInStatement | ts.ForOfStatement).initializer;
				if (
					init
					&& init.kind === SK.VariableDeclarationList
					&& ((init as ts.VariableDeclarationList).flags
							& (ts.NodeFlags.Let | ts.NodeFlags.Const)) !== 0
				) {
					return new TsScope(this, n, 'for', parent, true);
				}
				return undefined;
			}
			case SK.CatchClause:
				return new TsScope(this, n, 'catch', parent, true);
			case SK.SwitchStatement: {
				// Use CaseBlock (not SwitchStatement) as the scope's boundary
				// node, so the discriminant `switch (ok)` resolves to the
				// outer scope rather than the switch scope.
				return new TsScope(this, (n as ts.SwitchStatement).caseBlock, 'switch', parent, true);
			}
			case SK.WithStatement: {
				// `with (obj) { stmt }` — `obj` resolves to the outer scope
				// (visited before entering with scope). Use the body statement
				// as the with scope boundary; `block` getter steps back out.
				return new TsScope(this, (n as ts.WithStatement).statement, 'with', parent, true);
			}
			case SK.EnumDeclaration:
				return new TsScope(this, n, 'tsEnum', parent, true);
			case SK.ModuleDeclaration:
				return new TsScope(this, n, 'tsModule', parent, true);
			case SK.InterfaceDeclaration:
			case SK.TypeAliasDeclaration:
				// Upstream only creates a 'type' scope when type parameters are
				// present (since they need to be scoped to this declaration).
				return (n as { typeParameters?: ts.NodeArray<ts.TypeParameterDeclaration> }).typeParameters
					? new TsScope(this, n, 'type', parent, true)
					: undefined;
			case SK.MappedType:
				return new TsScope(this, n, 'mapped-type', parent, true);
			case SK.ConditionalType:
				return new TsScope(this, n, 'conditional-type', parent, true);
			case SK.FunctionType:
			case SK.ConstructorType:
			case SK.CallSignature:
			case SK.ConstructSignature:
			case SK.MethodSignature:
				return new TsScope(this, n, 'function-type', parent, true);
			default:
				return undefined;
		}
	}

	_getOrCreateVariable(symbol: ts.Symbol): TsVariable {
		let v = this._variableBySymbol.get(symbol);
		if (!v) {
			v = new TsVariable(this, symbol);
			this._variableBySymbol.set(symbol, v);
		}
		return v;
	}

	_collectBinding(binding: ts.BindingName | undefined, out: TsVariable[]) {
		if (!binding) return;
		const ts_ = ts;
		if (ts_.isIdentifier(binding)) {
			const sym = this.checker.getSymbolAtLocation(binding);
			if (sym) out.push(this._getOrCreateVariable(sym));
			return;
		}
		if (ts_.isObjectBindingPattern(binding) || ts_.isArrayBindingPattern(binding)) {
			for (const el of binding.elements) {
				if (ts_.isOmittedExpression(el)) continue;
				this._collectBinding(el.name, out);
			}
		}
	}

	// upstream: `@typescript-eslint/scope-manager/dist/ScopeManager.js`
	// `getDeclaredVariables(node)`. Returns every variable declared
	// directly in `node` — for `let [a, b] = ...` that's two vars
	// (`a`, `b`); for `function f(x, { y }) {}` it's three (`f`, `x`,
	// `y`). Critical for rules that walk declarations top-down
	// (prefer-const, no-unused-vars, naming-convention).
	getDeclaredVariables(node: TSESTree.Node): TsVariable[] {
		const tsNode = this.astMaps.esTreeNodeToTSNodeMap.get(node);
		if (!tsNode) return [];
		const out: TsVariable[] = [];
		const ts_ = ts;
		const collect = (decl: ts.Node | undefined) => {
			if (!decl) return;
			// VariableDeclaration / Parameter `.name` may be a binding pattern
			// (`let [a, b] = ...`, `function f({ x, y }) {}`) — symbol lives on
			// each leaf Identifier, not on the pattern container. Walk via
			// `_collectBinding` so destructured bindings are emitted.
			// `prefer-const` and friends call `getDeclaredVariables(letNode)`
			// to enumerate scoped bindings; without this, the rule sees an
			// empty array for any destructuring declaration.
			if (ts_.isVariableDeclaration(decl) || ts_.isParameter(decl)) {
				this._collectBinding(decl.name, out);
				return;
			}
			// CatchClause holds the param via `variableDeclaration` (which is
			// itself a VariableDeclaration with the param identifier or pattern
			// as `.name`). Without this, getDeclaredVariables returns [] for
			// catch clauses and rules like no-ex-assign / no-shadow can't
			// enumerate the catch-bound name. Repro:
			//   `catch (e) { e = new Error() }` — no-ex-assign must report.
			if (ts_.isCatchClause(decl)) {
				if (decl.variableDeclaration) {
					this._collectBinding(decl.variableDeclaration.name, out);
				}
				return;
			}
			let sym: ts.Symbol | undefined = (decl as { symbol?: ts.Symbol }).symbol;
			if (!sym) {
				const nameNode = (decl as { name?: ts.Node }).name;
				if (nameNode) sym = this.checker.getSymbolAtLocation(nameNode);
			}
			if (sym) out.push(this._getOrCreateVariable(sym));
		};
		if (ts_.isVariableStatement(tsNode)) {
			for (const d of tsNode.declarationList.declarations) collect(d);
		}
		else if (ts_.isVariableDeclarationList(tsNode)) {
			for (const d of tsNode.declarations) collect(d);
		}
		else if (
			ts_.isVariableDeclaration(tsNode)
			|| ts_.isParameter(tsNode)
			|| ts_.isFunctionDeclaration(tsNode)
			|| ts_.isFunctionExpression(tsNode)
			|| ts_.isArrowFunction(tsNode)
			|| ts_.isMethodDeclaration(tsNode)
			|| ts_.isClassDeclaration(tsNode)
			|| ts_.isClassExpression(tsNode)
			|| ts_.isImportSpecifier(tsNode)
			|| ts_.isImportClause(tsNode)
			|| ts_.isNamespaceImport(tsNode)
			|| ts_.isImportEqualsDeclaration(tsNode)
			|| ts_.isEnumDeclaration(tsNode)
			|| ts_.isModuleDeclaration(tsNode)
			|| ts_.isTypeAliasDeclaration(tsNode)
			|| ts_.isInterfaceDeclaration(tsNode)
			|| ts_.isTypeParameterDeclaration(tsNode)
			|| ts_.isCatchClause(tsNode)
		) {
			collect(tsNode);
		}
		// For function-like nodes, also return their parameters.
		if (
			ts_.isFunctionDeclaration(tsNode)
			|| ts_.isFunctionExpression(tsNode)
			|| ts_.isArrowFunction(tsNode)
			|| ts_.isMethodDeclaration(tsNode)
		) {
			const fn = tsNode as ts.FunctionLikeDeclaration;
			if (fn.parameters) {
				for (const p of fn.parameters) {
					this._collectBinding(p.name, out);
				}
			}
		}
		return out;
	}

	acquire(node: TSESTree.Node, inner = false): TsScope | null {
		const tsNode = this.astMaps.esTreeNodeToTSNodeMap.get(node);
		if (!tsNode) return null;
		const arr = this.nodeToScope.get(tsNode);
		if (!arr || arr.length === 0) return null;
		if (arr.length === 1) return arr[0];
		// Multiple scopes share this node (e.g. Program → [global, module] or
		// FunctionExpression → [fn-expr-name, function]).
		const predicate = (s: TsScope) => !(s.type === 'function' && s.functionExpressionScope);
		if (inner) {
			for (let i = arr.length - 1; i >= 0; --i) {
				if (predicate(arr[i])) return arr[i];
			}
			return null;
		}
		return arr.find(predicate) ?? null;
	}

	get variables(): TsVariable[] {
		const out: TsVariable[] = [];
		for (const s of this.scopes) out.push(...s.variables);
		return out;
	}

	isES6() {
		return true;
	}
	isGlobalReturn() {
		return false;
	}
	isImpliedStrict() {
		return this.sourceType === 'module';
	}
	isModule() {
		return this.sourceType === 'module';
	}
	isStrictModeSupported() {
		return true;
	}

	// Fake globals registered by `addGlobals` whose through-ref reconciliation
	// is still pending. Drained when `_ensureRefIndex` actually runs (i.e.
	// when a rule first reads references). Reading `globalScope.variables`
	// directly already sees these — only the `through` -> `references`
	// re-resolve is deferred.
	_pendingFakeGlobals?: Map<string, TsVariable>;

	// upstream: `eslint-scope/lib/scope-manager.js` `ScopeManager.addGlobals`,
	// invoked by `eslint/lib/languages/js/source-code/source-code.js`
	// `addDeclaredGlobals` for every name in `conf/globals.js`'s
	// `es${ecmaVersion}` set + user `globals` config. Synthesises a
	// Variable in `globalScope` per name and re-resolves matching
	// through-refs against it. Compat-eslint's entry point calls this
	// with the vendored `ESLINT_BUILTIN_GLOBALS` (es2026) so `no-undef`
	// doesn't fire on `undefined` / `Math` / `Array` / etc.
	//
	// ESLint's contract requires `scopeManager.variables` /
	// `globalScope.set` to immediately reflect an `addGlobals` call (see
	// `eslint-scope/test/add-globals.test.ts`'s "doesn't affect unrelated
	// references" case), so the per-file `TsVariable` is built eagerly.
	// What we DO save:
	//   1. Fake `ts.Symbol` placeholders are module-shared via
	//      `_sharedFakeGlobalSymbol(name)` — every file's manager reuses
	//      the same plain-object symbol per name. Across the TypeScript
	//      repo's 710 files × ~250 declared names, that's ~177k throwaway
	//      allocs avoided.
	//   2. The through-ref reconciliation is parked in
	//      `_pendingFakeGlobals` and drained at the tail of
	//      `_ensureRefIndex`. Rule sets that don't query references
	//      (most lint configs without `no-undef` / `no-unused-vars`)
	//      skip it entirely.
	addGlobals(names: string[]) {
		// Skip names that already exist as declared globals — upstream's
		// addGlobals is a no-op for already-known names (test name:
		// "doesn't affect already declared global variables").
		const existingNames = new Set<string>();
		for (const v of this.globalScope.variables) {
			existingNames.add(v.name);
		}
		const pending = this._pendingFakeGlobals ??= new Map<string, TsVariable>();
		for (const name of names) {
			if (existingNames.has(name)) continue;
			const fakeSym = _sharedFakeGlobalSymbol(name);
			const v = new TsVariable(this, fakeSym);
			this._variableBySymbol.set(fakeSym, v);
			this.globalScope._addLibVariable(v);
			pending.set(name, v);
		}
		// If the ref index is already built (rare — only when a rule queried
		// references before all `addGlobals` calls finished), reconcile now
		// since the deferred path won't fire again.
		if (this._refIndex) {
			this._reconcileFakeGlobals();
		}
		// Clear implicit-globals cache — added globals supersede the
		// auto-synthesized ones for any matching names.
		this._implicitGlobals = undefined;
	}

	// Drain `_pendingFakeGlobals` against the currently-built `_through`,
	// moving every ref whose identifier text matches a registered fake into
	// the per-symbol `_refIndex`. Called either from `addGlobals` (when the
	// ref index is already built) or at the tail of `_ensureRefIndex` (the
	// common path for the lint pipeline).
	_reconcileFakeGlobals() {
		const pending = this._pendingFakeGlobals;
		if (!pending || pending.size === 0) return;
		const through = this._through!;
		const refs = this._refIndex!;
		const remaining: TsReference[] = [];
		for (const ref of through) {
			// Read name from the ts.Identifier directly — `ref.identifier.name`
			// would trigger `tsToEstreeOrStub` → `materialize`, which walks
			// up the parent chain and may eagerly construct wrapper-class
			// ESTree nodes (ChainExpression, ExportNamedDeclaration). ts-ast-
			// scan's later traversal then sees those wrappers in the lazy
			// cache and dispatches enter/leave on them out of source order
			// — desyncing CPA's choice-context stack and crashing
			// `popChoiceContext` on null. Reading `tsIdentifier.text` is
			// pure and avoids the eager materialize.
			const name = ref.tsIdentifier.text;
			const added = pending.get(name);
			if (!added) {
				remaining.push(ref);
				continue;
			}
			// Re-point the ref's symbol so resolved/getReferencesFor work.
			(ref as { symbol: ts.Symbol }).symbol = added.symbol;
			let arr = refs.get(added.symbol);
			if (!arr) refs.set(added.symbol, arr = []);
			arr.push(ref);
		}
		this._through = remaining;
		this._pendingFakeGlobals = undefined;
	}

	// upstream equivalent: `@typescript-eslint/scope-manager/dist/referencer/Referencer.js`
	// running through every node and calling `currentScope().referenceValue(...)` /
	// `referenceType(...)`. Upstream is eager — the entire reference graph
	// is built during scope-tree construction. We split:
	//   `_buildScopeTree` (constructor) — scopes + parented walk + collects
	//      `_pendingIdentifiers`.
	//   `_ensureRefIndex` (this method, lazy) — classifies each pending
	//      Identifier into resolved references vs `_through` (escapes file).
	// Triggered on first `scope.through` / `scope.references` /
	// `var.references` / `getReferencesFor` access. Most rules read
	// nothing from this graph, paying nothing.
	_through?: TsReference[];
	_refIndex?: Map<ts.Symbol, TsReference[]>;
	_referencesByScope?: Map<TsScope, TsReference[]>;
	_ensureRefIndex(): Map<ts.Symbol, TsReference[]> {
		if (this._refIndex) return this._refIndex;
		// Reference classification needs `_variableBySymbol` populated for
		// every scope so it can distinguish file-local symbols (resolved)
		// from cross-file globals (unresolved → goes to `through`). Walking
		// `s.variables` for each scope is what fills the map. Used to be
		// done eagerly in `_buildScopeTree`, but rule sets that never query
		// references (e.g. eqeqeq + no-var + no-bitwise) don't need this —
		// defer until the first ref query forces it. addGlobals reads
		// `globalScope.variables` explicitly, so the global scope still
		// gets populated at the right time.
		for (const s of this.scopes) {
			void s.variables;
		}
		const refs = new Map<ts.Symbol, TsReference[]>();
		const through: TsReference[] = [];
		const byScope = new Map<TsScope, TsReference[]>();
		const recordScope = (ref: TsReference) => {
			const s = ref.from;
			let arr = byScope.get(s);
			if (!arr) byScope.set(s, arr = []);
			arr.push(ref);
		};
		const checker = this.checker;
		const SK = ts.SyntaxKind;
		const variableBySymbol = this._variableBySymbol;
		// Iterate identifiers gathered during the scope-tree walk — no second
		// AST traversal.
		const idents = this._pendingIdentifiers;
		for (let i = 0; i < idents.length; i++) {
			const node = idents[i];
			// Cheap filter first: many identifiers (property names, label
			// targets, decl names) are neither reference-eligible nor free —
			// skip them before triggering the (expensive) symbol resolver.
			// One switch over `parent.kind` produces both flags as a 2-bit
			// bitmap (bit 0 = freeRef, bit 1 = refUsage); 0 means skip.
			const flags = this._classifyIdentifier(node);
			if (flags === 0) continue;
			const refUsage = (flags & 0b10) !== 0;
			const freeRef = (flags & 0b01) !== 0;

			// `arguments` inside a non-arrow function resolves to the
			// function's synthetic arguments TsVariable. TS's checker gives
			// each function a separate `arguments` symbol; register the link
			// the first time we see it.
			if (node.text === 'arguments') {
				for (let cur: ts.Node | undefined = node.parent; cur; cur = cur.parent) {
					if (
						cur.kind === SK.FunctionDeclaration
						|| cur.kind === SK.FunctionExpression
						|| cur.kind === SK.MethodDeclaration
						|| cur.kind === SK.Constructor
						|| cur.kind === SK.GetAccessor
						|| cur.kind === SK.SetAccessor
					) {
						const arr = this.nodeToScope.get(cur);
						const fnScope = arr?.find(s => s.type === 'function');
						if (fnScope) {
							const argsVar = fnScope._getOrCreateArgumentsVar();
							const sym = checker.getSymbolAtLocation(node);
							if (sym && !variableBySymbol.has(sym)) {
								variableBySymbol.set(sym, argsVar);
							}
						}
						break;
					}
				}
			}

			// Symbol resolution. For binding identifiers (the `x` in `let x = …`,
			// destructured `{ x }`, `for (const x of …)`), the symbol is already
			// on the parent declaration node (set by the TS binder) — read it
			// directly instead of paying for a checker.getSymbolAtLocation walk.
			const parent = node.parent;
			let sym: ts.Symbol | undefined;
			const pk = parent?.kind;
			if (
				pk === SK.VariableDeclaration && (parent as ts.VariableDeclaration).name === node
				|| pk === SK.BindingElement && (parent as ts.BindingElement).name === node
			) {
				sym = (parent as { symbol?: ts.Symbol }).symbol;
			}
			if (!sym) {
				sym = checker.getSymbolAtLocation(node);
			}
			// `{ x }` shorthand: getSymbolAtLocation returns the property
			// symbol; we want the binding `x` resolves to.
			if (parent && pk === SK.ShorthandPropertyAssignment && (parent as ts.ShorthandPropertyAssignment).name === node) {
				const valSym = checker.getShorthandAssignmentValueSymbol(parent);
				if (valSym) sym = valSym;
			}
			// `export { x }` (no `from`): TS produces an alias Symbol whose
			// declaration is the ExportSpecifier itself — distinct from the
			// LOCAL symbol the import / let / fn declared. `getSymbolAtLocation`
			// returns the alias; the rule needs the local target so the ref
			// resolves into module scope. `getExportSpecifierLocalTargetSymbol`
			// follows the alias to the original local. Without this, every
			// `export { foo }` re-export reports `foo` as undefined.
			if (parent && pk === SK.ExportSpecifier && (parent as ts.ExportSpecifier).name === node) {
				const exportDecl = parent.parent.parent as ts.ExportDeclaration;
				if (!exportDecl.moduleSpecifier) {
					const localSym = checker.getExportSpecifierLocalTargetSymbol(parent as ts.ExportSpecifier);
					if (localSym) sym = localSym;
				}
			}
			if (sym && variableBySymbol.has(sym)) {
				// Resolved reference — add to per-symbol index (only when this
				// position counts as a reference, e.g. usage or init).
				if (refUsage) {
					// Key the bucket by the TsVariable's canonical symbol — for
					// most cases that's the same as `sym`, but synthetic
					// `arguments` is built before any reference is seen and
					// uses a symbol from `getSymbolsInScope`, while
					// `getSymbolAtLocation` on an actual `arguments`
					// identifier returns a function-scoped synthetic symbol
					// (the implicit `arguments` per non-arrow function). Both
					// alias to the same TsVariable via `variableBySymbol`,
					// but keying refs by `sym` would split them across two
					// buckets — `getReferencesFor(argsVar.symbol)` then
					// returns empty and prefer-rest-params reports nothing.
					const v = variableBySymbol.get(sym)!;
					const key = v.symbol;
					let arr = refs.get(key);
					if (!arr) refs.set(key, arr = []);
					{
						const ref = new TsReference(this, node, sym);
						arr.push(ref);
						recordScope(ref);
					}
				}
			}
			else if (sym) {
				// Lib-global decision is cached per symbol: check the cache
				// before re-walking the symbol's declarations through
				// `_isLibGlobalSymbol`. `null` in the cache means
				// "checked, not a lib global".
				let cached = this._libDecisionBySymbol.get(sym);
				if (cached === undefined) {
					cached = this._isLibGlobalSymbol(sym) ? 1 : 0;
					this._libDecisionBySymbol.set(sym, cached);
				}
				if (cached === 1) {
					const isValue = LIB_VALUE_GLOBALS.has(sym.name);
					const inTypePosition = !this._isValueReferencePosition(node);
					if (inTypePosition || isValue) {
						let v = this._libVariableBySymbol.get(sym);
						if (!v) {
							v = new TsVariable(this, sym);
							this._libVariableBySymbol.set(sym, v);
							// Also register in `_variableBySymbol` so
							// `scope.through`'s alias-aware lookup finds the
							// var by ref.symbol. Without this, lib vars (Map,
							// Set, ...) don't show up as local in
							// globalScope and refs escape → no-undef false
							// positives.
							variableBySymbol.set(sym, v);
							this.globalScope._addLibVariable(v);
						}
						let arr = refs.get(sym);
						if (!arr) refs.set(sym, arr = []);
						{
							const ref = new TsReference(this, node, sym);
							arr.push(ref);
							recordScope(ref);
						}
					}
					else if (freeRef) {
						// Value ref to a type-only lib global (e.g. Set, Map,
						// Iterable in expression position) — upstream treats
						// as undefined. Match.
						{
							const ref = new TsReference(this, node, sym);
							through.push(ref);
							recordScope(ref);
						}
					}
				}
				else if (freeRef) {
					// Symbol present but unknown to lib globals. The compat
					// entry point pre-registers TS lib type names
					// (Record / Promise / Awaited / …) via `addGlobals`,
					// so any name that resolves cleanly with @typescript-
					// eslint scope-manager already lands in
					// `_variableBySymbol` after this point. Whatever falls
					// through here is a genuinely unresolved value- or
					// type-position reference — fire it (matches plain ESLint
					// no-undef on `NodeJS.ErrnoException` / `Visitor` / typo
					// names that aren't in the registered lib type set).
					{
						const ref = new TsReference(this, node, sym);
						through.push(ref);
						recordScope(ref);
					}
				}
			}
			else if (freeRef) {
				// Unresolved (no symbol). Through-only.
				const ref = new TsReference(this, node, undefined as any);
				through.push(ref);
				recordScope(ref);
			}
		}
		// Free the identifier list — won't be needed again.
		this._pendingIdentifiers = [];
		this._through = through;
		this._referencesByScope = byScope;
		this._refIndex = refs;
		// Drain any `addGlobals` calls that landed before the index was
		// built — `_through` now exists, so we can move matching refs
		// across in one pass instead of forcing the index per `addGlobals`.
		this._reconcileFakeGlobals();
		return this._refIndex;
	}

	getReferencesFor(symbol: ts.Symbol): TsReference[] {
		return this._ensureRefIndex().get(symbol) ?? [];
	}

	getThroughReferences(): TsReference[] {
		this._ensureRefIndex();
		return this._through!;
	}

	// Implicit globals: synthesized variables for unresolved write references
	// (e.g. `x = 1;` where `x` isn't declared) that ESLint's `no-undef`
	// alternatives might want to model. One Variable per unique name; each
	// gets a synthetic ImplicitGlobalVariable def + the first write's
	// identifier.
	_implicitGlobals?: TsVariable[];
	getImplicitGlobals(): TsVariable[] {
		if (this._implicitGlobals) return this._implicitGlobals;
		const through = this.globalScope.through;
		const byName = new Map<string, { v: TsVariable; firstWrite: TsReference }>();
		for (const ref of through) {
			if (!ref.isWrite()) continue;
			const name = ref.identifier.name;
			if (byName.has(name)) continue;
			const fakeSym = { name, declarations: [], flags: 0 } as unknown as ts.Symbol;
			const v = new TsVariable(this, fakeSym);
			// Override defs / identifiers via instance-level override so the
			// implicit global has a believable single ImplicitGlobalVariable
			// def pointing at the write reference's identifier.
			(v as TsVariable & { _defsOverride?: TsDefinition[] })._defsOverride = [
				new TsImplicitGlobalDefinition(this, v, ref.tsIdentifier),
			];
			(v as TsVariable & { _identifiersOverride?: TSESTree.Identifier[] })._identifiersOverride = [ref.identifier];
			byName.set(name, { v, firstWrite: ref });
		}
		return this._implicitGlobals = Array.from(byName.values()).map(x => x.v);
	}

	// upstream equivalent: spread across `@typescript-eslint/scope-manager/dist/
	// referencer/{Referencer,TypeVisitor,ExportVisitor,...}.js`. Each
	// upstream visitor decides whether to emit `referenceValue`,
	// `referenceType`, or skip (e.g. TypeVisitor.TSImportType skips the
	// qualifier; PropertyAccessExpression visitor only descends into
	// `.object`, never `.property`).
	//
	// We collapse those visitor decisions into one branchy switch
	// keyed by `parent.kind`, returning a 2-bit bitmap:
	//   bit 0 (FREE_REF=1): identifier is in a reference position (NOT a
	//     declaration name, property access RHS, label, etc.)
	//   bit 1 (REF_USAGE=2): identifier should produce an ESLint Reference —
	//     either a usage (free position) or a declaration with init/iter
	//     binding that counts as an init Reference.
	//
	// Adding a new case here requires reading the corresponding
	// upstream visitor to understand whether the identifier should be
	// classified as a value reference, type reference, or skipped.
	//
	// Hot-path layout:
	//   1. parent.kind not in `_CLASSIFY_HANDLED_KINDS` → return 0b11 (most
	//      identifiers, e.g. inside expression positions).
	//   2. parent.kind in `_CLASSIFY_NAME_SLOT_KINDS` → fall-through "name
	//      slot" body shared by ~22 declaration-shaped kinds.
	//   3. otherwise enter the switch for one of ~10 special-shape cases.
	_classifyIdentifier(id: ts.Identifier): number {
		const p = id.parent;
		if (!p) return 0b11;
		const k = p.kind;
		if (!_CLASSIFY_HANDLED_KINDS[k]) return 0b11;
		if (_CLASSIFY_NAME_SLOT_KINDS[k]) {
			return (p as { name?: ts.Node }).name === id ? 0 : 0b11;
		}
		const SK = ts.SyntaxKind;
		switch (k) {
			// Single-slot kinds — each consults its own slot field.
			case SK.PropertyAccessExpression:
				return (p as ts.PropertyAccessExpression).name === id ? 0 : 0b11;
			case SK.QualifiedName: {
				if ((p as ts.QualifiedName).right === id) return 0;
				// `import("mod").A.B.C` — every identifier in the qualifier
				// chain references an export of the imported module, NOT a
				// local. Walk up through QualifiedName ancestors; if we hit
				// an ImportType, skip the whole chain (matches upstream's
				// `TypeVisitor.TSImportType` skipping the qualifier).
				let cur: ts.Node | undefined = p;
				while (cur && cur.kind === SK.QualifiedName) cur = cur.parent;
				if (cur && cur.kind === SK.ImportType) return 0;
				return 0b11;
			}
			case SK.LabeledStatement:
				return (p as ts.LabeledStatement).label === id ? 0 : 0b11;
			case SK.BreakStatement:
			case SK.ContinueStatement:
				return (p as ts.BreakStatement | ts.ContinueStatement).label === id ? 0 : 0b11;
			case SK.MetaProperty:
				// `new.target` / `import.meta` — `target` / `meta` are syntactic
				// markers, not real references.
				return (p as ts.MetaProperty).name === id ? 0 : 0b11;
			case SK.ImportSpecifier: {
				// Import binding — the names are declarations, not references.
				const e = p as ts.ImportSpecifier;
				return (e.name === id || e.propertyName === id) ? 0 : 0b11;
			}

			// Declaration name slot but with init/iter rules — name slot is
			// not free, but may still produce an init Reference.
			case SK.VariableDeclaration: {
				const v = p as ts.VariableDeclaration;
				if (v.name !== id) return 0b11;
				// In the name slot: not free; refUsage if initializer or
				// for-of/in binding.
				if (v.initializer !== undefined) return 0b10;
				const list = v.parent;
				if (list && list.kind === SK.VariableDeclarationList) {
					const stmt = list.parent;
					if (stmt && (stmt.kind === SK.ForOfStatement || stmt.kind === SK.ForInStatement)) return 0b10;
				}
				return 0;
			}
			case SK.BindingElement: {
				const e = p as ts.BindingElement;
				if (e.name !== id && e.propertyName !== id) return 0b11;
				// In a binding name slot: not free. refUsage walks up to the
				// owning VariableDeclaration / Parameter to inherit init/iter
				// semantics.
				for (let cur: ts.Node | undefined = p; cur; cur = cur.parent) {
					if (cur.kind === SK.VariableDeclaration) {
						const v = cur as ts.VariableDeclaration;
						if (v.initializer !== undefined) return 0b10;
						const list = v.parent;
						if (list && list.kind === SK.VariableDeclarationList) {
							const stmt = list.parent;
							if (stmt && (stmt.kind === SK.ForOfStatement || stmt.kind === SK.ForInStatement)) return 0b10;
						}
						return 0;
					}
					if (cur.kind === SK.Parameter) {
						// `function f([a = 0] = [])` — outer Parameter init counts.
						return (cur as ts.ParameterDeclaration).initializer !== undefined ? 0b10 : 0;
					}
				}
				return 0;
			}
			case SK.Parameter: {
				const param = p as ts.ParameterDeclaration;
				if (param.name !== id) return 0b11;
				// In the name slot: not free; refUsage iff initializer.
				return param.initializer !== undefined ? 0b10 : 0;
			}

			case SK.ExportSpecifier: {
				// `export {x} from "mod";` — re-export, no local reference.
				const e = p as ts.ExportSpecifier;
				const decl = e.parent.parent;
				if (decl.moduleSpecifier) return 0;
				// `export {x}` — `x` references the local. `export {x as v}` —
				// `x` (propertyName) references the local; `v` (name) is the
				// public export name (not a local reference).
				if (e.propertyName) return e.name === id ? 0 : 0b11;
				return 0b11;
			}

			case SK.TypeReference:
				// `expr as const` — `const` is a syntactic marker. _isFreeReference
				// returned false; _isReferenceableUsage left it on the default
				// `return true` path → REF_USAGE only.
				if (
					id.text === 'const'
					&& (p as ts.TypeReferenceNode).typeName === id
					&& p.parent
					&& (p.parent.kind === SK.AsExpression || p.parent.kind === SK.TypeAssertionExpression)
					&& (p.parent as ts.AsExpression | ts.TypeAssertion).type === p
				) return 0b10;
				return 0b11;

			case SK.ImportType:
				// `import("module").Foo` — `Foo` is the qualifier of an
				// EntityName referencing an export of the imported module,
				// NOT a local reference. Upstream's TypeVisitor explicitly
				// skips visiting the qualifier (see
				// `@typescript-eslint/scope-manager/.../TypeVisitor.ts`
				// `TSImportType`). Without this skip, the qualifier ends up
				// in `globalScope.through` → `no-undef` reports it.
				if ((p as ts.ImportTypeNode).qualifier === id) return 0;
				return 0b11;

			default:
				return 0b11;
		}
	}

	// Is this Identifier in a value position (not a type)? Used to decide
	// whether an unresolved free reference becomes a `no-undef`-eligible
	// through-reference.
	_isValueReferencePosition(id: ts.Identifier): boolean {
		const ts_ = ts;
		const SK = ts_.SyntaxKind;
		for (let cur: ts.Node | undefined = id.parent; cur; cur = cur.parent) {
			// `class Foo extends Base` — Base is a value reference (the
			// superclass must be a constructor function). The wrapping
			// ExpressionWithTypeArguments returns true from BOTH ts.isTypeNode
			// AND ts.isExpression, so the generic isTypeNode-first check
			// would short-circuit this position as "type only" and drop the
			// reference. `implements I` (class) and `extends I` (interface)
			// stay type-only and fall through to the generic logic.
			if (cur.kind === SK.ExpressionWithTypeArguments) {
				const hc = cur.parent;
				if (
					hc?.kind === SK.HeritageClause
					&& (hc as ts.HeritageClause).token === SK.ExtendsKeyword
					&& hc.parent
					&& (hc.parent.kind === SK.ClassDeclaration || hc.parent.kind === SK.ClassExpression)
				) {
					return true;
				}
			}
			if (ts_.isTypeNode(cur)) return false;
			if (ts_.isExpression(cur) || ts_.isStatement(cur)) return true;
		}
		return true;
	}

	// True if this symbol is declared exclusively in a TS default library
	// (`lib.es*.d.ts`). The caller decides whether the reference resolves —
	// type-position refs always do; value-position refs only do for the names
	// upstream marks as `isValueVariable: true` (LIB_VALUE_GLOBALS).
	//
	// `decl.getSourceFile()` walks `parent` to the SourceFile (5–20 hops), and
	// `program.isSourceFileDefaultLibrary` does its own path check. Lib symbols
	// commonly have multiple decls all landing in the same `lib.*.d.ts` file —
	// cache by SourceFile so repeat lookups within a symbol (and across symbols
	// within the same program) skip the rechecks.
	_isLibGlobalSymbol(sym: ts.Symbol): boolean {
		const decls = sym.declarations;
		if (!decls || decls.length === 0) return false;
		const sfCache = this._libSourceFileCache;
		for (const d of decls) {
			const sf = d.getSourceFile();
			let isLib = sfCache.get(sf);
			if (isLib === undefined) {
				isLib = this.program.isSourceFileDefaultLibrary(sf);
				sfCache.set(sf, isLib);
			}
			if (!isLib) return false;
		}
		return true;
	}

	tsToEstree<T extends TSESTree.Node = TSESTree.Node>(tsNode: ts.Node): T | undefined {
		return this.astMaps.tsNodeToESTreeNodeMap.get(tsNode) as T | undefined;
	}

	// Compat-eslint specific (no upstream equivalent — typescript-estree
	// converts the WHOLE program eagerly, so every ts.Node has its
	// ESTree counterpart from parse time). This is the bridge from
	// scope-manager's TS-keyed state to the lazy ESTree shim. Every
	// `def.node` / `def.parent` / `var.identifiers[]` / `ref.identifier`
	// getter reads through here. Must always return a non-undefined
	// value for non-undefined input — see `lazy-estree.ts`'s
	// `materialize()` for the GenericTSNode fallback contract.
	tsToEstreeOrStub<T extends TSESTree.Node = TSESTree.Node>(tsNode: ts.Node | undefined): T | undefined {
		if (!tsNode) return undefined;
		const real = this.astMaps.tsNodeToESTreeNodeMap.get(tsNode) as T | undefined;
		if (real) return real;
		// Bottom-up materialise the missing node via the lazy ESTree shim.
		// Builds a real ESTree counterpart with proper parent chain. Lazy
		// has a generic-fallback for unsupported kinds and null returns,
		// so this never throws.
		const { materialize } = require(
			'./lazy-estree',
		) as typeof import('./lazy-estree');
		return materialize(tsNode, {
			ast: this.tsFile,
			maps: this.astMaps,
		}) as unknown as T;
	}
}

// Public surface mirrors `@typescript-eslint/scope-manager/dist/scope/`'s
// per-type Scope classes (BlockScope, FunctionScope, GlobalScope, …).
// We collapse them into one class with a `type` discriminator.
//
// Rule-facing getters: `block`, `set`, `variables`, `references`,
// `through`, `childScopes`, `upper`, `variableScope`, `isStrict`,
// `functionExpressionScope`, `implicit`. Each has a corresponding
// upstream method/getter on ScopeBase.js or one of its subclasses.
export class TsScope {
	_variables?: TsVariable[];
	_childScopes: TsScope[] = [];
	_set?: Map<string, TsVariable>;
	upper: TsScope | null;

	constructor(
		readonly manager: TsScopeManager,
		readonly tsNode: ts.Node,
		readonly type: ScopeType,
		upper: TsScope | null,
		register = false,
	) {
		this.upper = upper;
		if (upper) upper._childScopes.push(this);
		if (register) manager._registerScope(tsNode, this);
	}

	// upstream: `eslint-scope/lib/scope.js` `Scope.block` — the AST
	// node that owns this scope (FunctionDeclaration / Program /
	// BlockStatement / etc.). Rules use `scope.block === node` to
	// match a listener firing to the scope it should enter
	// (no-redeclare's `checkForBlock`, no-shadow's stack walk).
	get block(): TSESTree.Node | undefined {
		const SK = ts.SyntaxKind;
		const k = this.tsNode.kind;
		// For class methods (Constructor / MethodDeclaration / accessors), TS
		// has a single node but ESTree splits into MethodDefinition + nested
		// FunctionExpression. ESLint's scope.block points at the
		// FunctionExpression — extract it from the MethodDefinition.value slot.
		if (
			k === SK.Constructor
			|| k === SK.MethodDeclaration
			|| k === SK.GetAccessor
			|| k === SK.SetAccessor
		) {
			const md = this.manager.tsToEstreeOrStub<TSESTree.Node>(this.tsNode) as
				| { value?: TSESTree.Node }
				| undefined;
			if (md?.value) return md.value;
		}
		// Switch scope's tsNode is the CaseBlock (boundary for `from`). ESLint
		// expects scope.block === SwitchStatement, so step out one level.
		// Same trick for with scope (tsNode is the body statement).
		if (k === SK.CaseBlock && this.tsNode.parent) {
			return this.manager.tsToEstreeOrStub(this.tsNode.parent);
		}
		if (this.type === 'with' && this.tsNode.parent) {
			return this.manager.tsToEstreeOrStub(this.tsNode.parent);
		}
		const result = this.manager.tsToEstreeOrStub<TSESTree.Node>(this.tsNode);
		// `export function f` / `export default function f` / `export class C`:
		// materialize wraps the inner declaration in
		// ExportNamedDeclaration / ExportDefaultDeclaration. ESLint listens
		// on the inner FunctionDeclaration / ClassDeclaration and tests
		// `scope.block === node` to decide whether to enter the scope —
		// so scope.block must point at the inner, not the wrapper.
		// Unwrap when this scope's tsNode is the inner declaration but
		// materialize yielded the wrapper.
		if (
			result && (
				(result as { type?: string }).type === 'ExportNamedDeclaration'
				|| (result as { type?: string }).type === 'ExportDefaultDeclaration'
			)
		) {
			const inner = (result as { declaration?: TSESTree.Node }).declaration;
			if (inner) return inner;
		}
		return result;
	}

	get variableScope(): TsScope {
		// Nearest enclosing function / global / module / class /
		// class-field-initializer scope.
		let s: TsScope | null = this;
		while (
			s
			&& s.type !== 'function'
			&& s.type !== 'global'
			&& s.type !== 'module'
			&& s.type !== 'class'
			&& s.type !== 'class-field-initializer'
		) {
			s = s.upper;
		}
		return s ?? this.manager.globalScope;
	}

	get functionExpressionScope(): boolean {
		return this.type === 'function-expression-name';
	}

	get isStrict(): boolean {
		// Modules are implicitly strict.
		if (this.manager.isModule()) return true;
		// Class bodies are always strict.
		if (this.type === 'class') return true;
		const SK = ts.SyntaxKind;
		const hasUseStrictDirective = (statements: ReadonlyArray<ts.Statement>): boolean => {
			for (const stmt of statements) {
				if (
					stmt.kind === SK.ExpressionStatement
					&& (stmt as ts.ExpressionStatement).expression.kind === SK.StringLiteral
					&& ((stmt as ts.ExpressionStatement).expression as ts.StringLiteral).text === 'use strict'
				) return true;
				break; // directive prologue only — first non-directive stops the search.
			}
			return false;
		};
		// SourceFile (script with `'use strict'` at top): propagates.
		if (this.type === 'global') {
			if (hasUseStrictDirective((this.tsNode as ts.SourceFile).statements)) return true;
		}
		// Function with 'use strict' directive in body.
		if (this.type === 'function') {
			const fn = this.tsNode as ts.FunctionLikeDeclaration;
			const body = (fn as { body?: ts.Node }).body;
			if (body && body.kind === SK.Block && hasUseStrictDirective((body as ts.Block).statements)) {
				return true;
			}
		}
		// Inherit from upper scope.
		return this.upper?.isStrict ?? false;
	}

	get variables(): TsVariable[] {
		if (!this._variables) {
			this._variables = this._collectVariables();
		}
		return this._variables;
	}

	// Inject a synthesized lib global (Object, Array, etc.) discovered during
	// reference-index walk. Only globalScope receives these.
	_addLibVariable(v: TsVariable) {
		void this.variables; // ensure populated
		if (!this._variables!.includes(v)) {
			this._variables!.push(v);
			this._set?.set(v.name, v);
		}
	}

	_collectVariables(): TsVariable[] {
		const ts_ = ts;
		const SK = ts_.SyntaxKind;
		const out: TsVariable[] = [];
		const seen = new Set<ts.Symbol>();
		const seenNames = new Set<string>();
		const push = (sym: ts.Symbol | undefined) => {
			if (!sym || seen.has(sym)) return;
			seen.add(sym);
			// Dedupe by name too: TS sometimes produces multiple symbols for the
			// same lexical binding (e.g. parameter properties have one symbol
			// for the parameter and another for the synthesized class member).
			// ESLint expects one Variable per name in a scope.
			if (seenNames.has(sym.name)) return;
			seenNames.add(sym.name);
			out.push(this.manager._getOrCreateVariable(sym));
		};
		const symOf = (decl: ts.Node | undefined): ts.Symbol | undefined => {
			if (!decl) return undefined;
			const direct = (decl as { symbol?: ts.Symbol }).symbol;
			if (direct) return direct;
			const nameNode = (decl as { name?: ts.Node }).name;
			if (nameNode) return this.manager.checker.getSymbolAtLocation(nameNode);
			return undefined;
		};
		// Walk the binding pattern of a declarator/parameter, pushing every
		// identifier's symbol into `out`.
		const pushBinding = (binding: ts.BindingName | undefined) => {
			if (!binding) return;
			if (ts_.isIdentifier(binding)) {
				push(this.manager.checker.getSymbolAtLocation(binding));
				return;
			}
			if (ts_.isObjectBindingPattern(binding) || ts_.isArrayBindingPattern(binding)) {
				for (const el of binding.elements) {
					if (ts_.isOmittedExpression(el)) continue;
					pushBinding(el.name);
				}
			}
		};
		// Walk children up to (but not into) any nested scope of these kinds.
		const walkUntilScope = (n: ts.Node, visit: (c: ts.Node) => void) => {
			ts_.forEachChild(n, c => {
				visit(c);
				// Skip into another scope (we don't recurse into function bodies etc.)
				if (this._isOwnScopeBoundary(c)) return;
				walkUntilScope(c, visit);
			});
		};

		switch (this.type) {
			case 'global': {
				// In module mode the globalScope is empty — moduleScope owns the
				// top-level decls. In script mode globalScope owns them. In
				// either case TS's binder pre-hoists `var` (including
				// `for (var x in …)`) into SourceFile.locals — pull those in too.
				if (this.manager.isModule()) break;
				const sf = this.tsNode as ts.SourceFile;
				for (const stmt of sf.statements) this._collectStatementBindings(stmt, push, pushBinding);
				const locals = (sf as { locals?: ts.SymbolTable }).locals;
				if (locals) {
					locals.forEach(sym => {
						// Skip TS's synthetic `default` export symbol.
						if (sym.name === 'default') return;
						push(sym);
					});
				}
				break;
			}
			case 'module': {
				const sf = this.tsNode as ts.SourceFile;
				for (const stmt of sf.statements) this._collectStatementBindings(stmt, push, pushBinding);
				const locals = (sf as { locals?: ts.SymbolTable }).locals;
				if (locals) {
					locals.forEach(sym => {
						if (sym.name === 'default') return;
						push(sym);
					});
				}
				break;
			}
			case 'function': {
				const fn = this.tsNode as ts.FunctionLikeDeclaration;
				// Synthetic `arguments` first (matches upstream order).
				if (fn.kind !== SK.ArrowFunction) {
					const argsVar = this._getOrCreateArgumentsVar();
					if (!seen.has(argsVar.symbol)) {
						out.push(argsVar);
						seen.add(argsVar.symbol);
					}
				}
				// Parameters next.
				if (fn.parameters) {
					for (const p of fn.parameters) {
						pushBinding(p.name);
						// Parameter property (`constructor(public x: T)`): TS's
						// binder produces TWO symbols on the same declaration —
						// a Property symbol (flags=Property=4) returned by
						// `getSymbolAtLocation(p.name)` and a function-scoped
						// FunctionScopedVariable symbol (flags=1) returned by
						// `getSymbolAtLocation` on a USE of the binding inside
						// the constructor body. pushBinding registered the
						// Property symbol; references inside the body resolve
						// to the local symbol, miss `_variableBySymbol`, and
						// fall through to `through` → no-undef false-positives
						// every parameter-property binding. Alias the local
						// symbol to the same TsVariable so resolution lands.
						// Repro (real code): `class C { constructor(public
						// readonly program: ts.Program) { program.x } }`.
						const isParamProp = ts_.isParameter(p)
							&& p.modifiers?.some(m =>
								m.kind === SK.PublicKeyword || m.kind === SK.PrivateKeyword
								|| m.kind === SK.ProtectedKeyword || m.kind === SK.ReadonlyKeyword
								|| m.kind === SK.OverrideKeyword
							);
						if (isParamProp && fn.body && ts_.isIdentifier(p.name)) {
							const propSym = this.manager.checker.getSymbolAtLocation(p.name);
							const localSym = this.manager.checker.getSymbolsInScope(
								fn.body,
								ts_.SymbolFlags.Variable,
							).find(s => s.name === (p.name as ts.Identifier).text);
							if (propSym && localSym && propSym !== localSym) {
								const v = this.manager._variableBySymbol.get(propSym);
								if (v) this.manager._variableBySymbol.set(localSym, v);
							}
						}
					}
				}
				// Walk the body in source order to preserve declaration
				// ordering (matches upstream's referencer). Body statements
				// + var-hoisted decls collapse into the function scope.
				if (fn.body && ts_.isBlock(fn.body)) {
					for (const stmt of fn.body.statements) {
						this._collectStatementBindings(stmt, push, pushBinding);
					}
				}
				// Pick up any var-hoisted decls TS recorded in fn.locals that
				// the source-order walk missed (e.g. `var x` inside nested
				// blocks of the function body).
				const fnLocals = (fn as { locals?: ts.SymbolTable }).locals;
				if (fnLocals) fnLocals.forEach(sym => push(sym));
				break;
			}
			case 'function-expression-name': {
				const fn = this.tsNode as ts.FunctionExpression;
				if (fn.name) push(this.manager.checker.getSymbolAtLocation(fn.name));
				break;
			}
			case 'class': {
				const cls = this.tsNode as ts.ClassLikeDeclaration;
				if (cls.name) push(this.manager.checker.getSymbolAtLocation(cls.name));
				if (cls.typeParameters) {
					for (const tp of cls.typeParameters) push(symOf(tp));
				}
				break;
			}
			case 'block': {
				// let/const/function/class declared directly in the block. var is
				// excluded — it hoists to the enclosing function/global scope.
				const block = this.tsNode as ts.Block;
				for (const stmt of block.statements) {
					if (ts_.isVariableStatement(stmt)) {
						const flags = stmt.declarationList.flags;
						if (flags & (ts_.NodeFlags.Let | ts_.NodeFlags.Const)) {
							for (const d of stmt.declarationList.declarations) pushBinding(d.name);
						}
						continue;
					}
					this._collectStatementBindings(stmt, push, pushBinding);
				}
				break;
			}
			case 'for': {
				const f = this.tsNode as ts.ForStatement | ts.ForInStatement | ts.ForOfStatement;
				const initializer = (f as ts.ForStatement).initializer
					?? (f as ts.ForInStatement | ts.ForOfStatement).initializer;
				if (initializer && ts_.isVariableDeclarationList(initializer)) {
					for (const d of initializer.declarations) pushBinding(d.name);
				}
				break;
			}
			case 'catch': {
				const c = this.tsNode as ts.CatchClause;
				if (c.variableDeclaration) pushBinding(c.variableDeclaration.name);
				break;
			}
			case 'switch': {
				// `switch (…) { case X: let y = …; }` — let/const inside any
				// case clause are scoped to the switch (single block scope per
				// the spec). this.tsNode is the CaseBlock.
				const cb = this.tsNode as ts.CaseBlock;
				for (const clause of cb.clauses) {
					for (const stmt of clause.statements) {
						if (ts_.isVariableStatement(stmt)) {
							const flags = stmt.declarationList.flags;
							if (flags & (ts_.NodeFlags.Let | ts_.NodeFlags.Const)) {
								for (const d of stmt.declarationList.declarations) pushBinding(d.name);
							}
							continue;
						}
						this._collectStatementBindings(stmt, push, pushBinding);
					}
				}
				break;
			}
			case 'with':
				break;
			case 'tsEnum': {
				const e = this.tsNode as ts.EnumDeclaration;
				for (const m of e.members) push(symOf(m));
				break;
			}
			case 'tsModule': {
				const mod = this.tsNode as ts.ModuleDeclaration;
				const body = mod.body;
				if (body && ts_.isModuleBlock(body)) {
					for (const stmt of body.statements) this._collectStatementBindings(stmt, push, pushBinding);
				}
				break;
			}
			case 'type': {
				const tps = (this.tsNode as { typeParameters?: ts.NodeArray<ts.TypeParameterDeclaration> }).typeParameters;
				if (tps) {
					for (const tp of tps) push(symOf(tp));
				}
				break;
			}
			case 'conditional-type': {
				// `T extends ... infer U ...` — `infer U` introduces `U`
				// into the conditional type's scope, accessible only from
				// the trueType (and any nested conditionals therein).
				// Upstream's TypeVisitor.TSInferType defines the type
				// parameter on the enclosing conditional scope. Walk the
				// extendsType and collect every InferTypeNode's name.
				const cond = this.tsNode as ts.ConditionalTypeNode;
				const collectInfer = (n: ts.Node) => {
					if (ts_.isInferTypeNode(n)) {
						push(symOf(n.typeParameter));
					}
					ts_.forEachChild(n, collectInfer);
				};
				if (cond.extendsType) collectInfer(cond.extendsType);
				break;
			}
			case 'mapped-type': {
				// Mapped types use a single `typeParameter` (not the plural array).
				const tp = (this.tsNode as ts.MappedTypeNode).typeParameter;
				if (tp) push(symOf(tp));
				break;
			}
			case 'function-type': {
				// Function type signatures (FunctionType, MethodSignature, etc.):
				// type params + parameter names are scoped here. Upstream's
				// no-unused-vars treats their parameter names as variables.
				const tps = (this.tsNode as { typeParameters?: ts.NodeArray<ts.TypeParameterDeclaration> }).typeParameters;
				if (tps) {
					for (const tp of tps) push(symOf(tp));
				}
				const params = (this.tsNode as { parameters?: ts.NodeArray<ts.ParameterDeclaration> }).parameters;
				if (params) {
					for (const p of params) pushBinding(p.name);
				}
				break;
			}
		}
		return out;
	}

	_isOwnScopeBoundary(n: ts.Node): boolean {
		const ts_ = ts;
		const SK = ts_.SyntaxKind;
		switch (n.kind) {
			case SK.FunctionDeclaration:
			case SK.FunctionExpression:
			case SK.ArrowFunction:
			case SK.MethodDeclaration:
			case SK.Constructor:
			case SK.GetAccessor:
			case SK.SetAccessor:
			case SK.ClassDeclaration:
			case SK.ClassExpression:
			case SK.ForStatement:
			case SK.ForInStatement:
			case SK.ForOfStatement:
			case SK.CatchClause:
			case SK.SwitchStatement:
			case SK.WithStatement:
			case SK.EnumDeclaration:
			case SK.ModuleDeclaration:
			case SK.InterfaceDeclaration:
			case SK.TypeAliasDeclaration:
			case SK.MappedType:
			case SK.ConditionalType:
			case SK.FunctionType:
			case SK.ConstructorType:
			case SK.CallSignature:
			case SK.ConstructSignature:
			case SK.MethodSignature:
				return true;
			case SK.Block: {
				// Function bodies are not their own block scope (they ARE the function
				// scope's body). Free-standing blocks are.
				const p = n.parent;
				if (
					p && (
						p.kind === SK.FunctionDeclaration
						|| p.kind === SK.FunctionExpression
						|| p.kind === SK.ArrowFunction
						|| p.kind === SK.MethodDeclaration
						|| p.kind === SK.Constructor
						|| p.kind === SK.GetAccessor
						|| p.kind === SK.SetAccessor
					)
				) {
					return false;
				}
				return true;
			}
		}
		return false;
	}

	// Collect bindings from a statement that lives in this scope (i.e. block /
	// global / module / tsModule scope). Does not recurse into nested scopes.
	_collectStatementBindings(
		stmt: ts.Statement,
		push: (sym: ts.Symbol | undefined) => void,
		pushBinding: (b: ts.BindingName | undefined) => void,
	) {
		const ts_ = ts;
		if (ts_.isVariableStatement(stmt)) {
			// Module/global/block scope: only let/const/var (var hoists to function,
			// but at top level it lives in the module/global scope).
			for (const d of stmt.declarationList.declarations) pushBinding(d.name);
			return;
		}
		if (ts_.isFunctionDeclaration(stmt) || ts_.isClassDeclaration(stmt)) {
			if (stmt.name) {
				const sym = this.manager.checker.getSymbolAtLocation(stmt.name);
				// `export default function f` makes the symbol's name 'default'.
				// Skip — the locals walk picks up the local `f` symbol instead.
				if (sym && sym.name !== 'default') push(sym);
			}
			return;
		}
		if (ts_.isImportDeclaration(stmt)) {
			const clause = stmt.importClause;
			if (!clause) return;
			if (clause.name) push(this.manager.checker.getSymbolAtLocation(clause.name));
			const bindings = clause.namedBindings;
			if (bindings) {
				if (ts_.isNamespaceImport(bindings)) {
					push(this.manager.checker.getSymbolAtLocation(bindings.name));
				}
				else {
					for (const el of bindings.elements) {
						push(this.manager.checker.getSymbolAtLocation(el.name));
					}
				}
			}
			return;
		}
		if (ts_.isImportEqualsDeclaration(stmt)) {
			// `import x = require('mod')` and `import x = OtherNS` — the name
			// binds in module/global scope.
			push(this.manager.checker.getSymbolAtLocation(stmt.name));
			return;
		}
		if (ts_.isEnumDeclaration(stmt) || ts_.isModuleDeclaration(stmt)) {
			if (stmt.name && ts.isIdentifier(stmt.name)) {
				push(this.manager.checker.getSymbolAtLocation(stmt.name));
			}
			return;
		}
		if (ts_.isInterfaceDeclaration(stmt) || ts_.isTypeAliasDeclaration(stmt)) {
			if (stmt.name) push(this.manager.checker.getSymbolAtLocation(stmt.name));
			return;
		}
	}

	_getOrCreateArgumentsVar(): TsVariable {
		let v = this.manager._syntheticArguments.get(this);
		if (!v) {
			// Try to obtain TS's real `arguments` symbol so references to the
			// identifier resolve to this same TsVariable. Fall back to a fake
			// symbol for arrow functions and other edge cases (where the var
			// won't actually be referenced anyway).
			const fn = this.tsNode as ts.FunctionLikeDeclaration;
			let sym: ts.Symbol | undefined;
			const body = (fn as { body?: ts.Node }).body;
			if (body) {
				const found = this.manager.checker.getSymbolsInScope(
					body,
					ts.SymbolFlags.Variable,
				).find(s => s.name === 'arguments');
				if (found) sym = found;
			}
			sym ??= { name: 'arguments', declarations: [], flags: 0 } as unknown as ts.Symbol;
			v = new TsVariable(this.manager, sym);
			this.manager._syntheticArguments.set(this, v);
			// Register so ref-index resolution finds it.
			this.manager._variableBySymbol.set(sym, v);
		}
		return v;
	}

	get set(): Map<string, TsVariable> {
		if (!this._set) {
			this._set = new Map();
			for (const v of this.variables) this._set.set(v.name, v);
		}
		return this._set;
	}

	get childScopes(): TsScope[] {
		return this._childScopes;
	}

	get references(): TsReference[] {
		this.manager._ensureRefIndex();
		return this.manager._referencesByScope!.get(this) ?? [];
	}

	get implicit(): {
		variables: TsVariable[];
		left: TsReference[];
		leftToBeResolved: TsReference[];
		set: Map<string, TsVariable>;
	} {
		// Only globalScope has meaningful implicit globals — references that
		// escaped resolution and become implicit globals at runtime
		// (e.g. `x = 300;` for undeclared `x`).
		if (this.type === 'global') {
			const through = this.through;
			const implicits = this.manager.getImplicitGlobals();
			const set = new Map<string, TsVariable>();
			for (const v of implicits) set.set(v.name, v);
			return {
				variables: implicits,
				left: through,
				leftToBeResolved: through,
				set,
			};
		}
		return { variables: [], left: [], leftToBeResolved: [], set: new Map() };
	}

	// upstream: `eslint-scope/lib/scope.js` `Scope.through` — references
	// that escape this scope after delegation up the parent chain.
	// `no-undef` reads `globalScope.through` to report unresolved refs.
	get through(): TsReference[] {
		// Computed lazily; not cached because scope.variables is mutable
		// via addGlobals.
		// `isLocal` looks up the ref's ts.Symbol via `_variableBySymbol` →
		// TsVariable, then checks if that var is in this scope. This handles
		// alias symbols (e.g. synthetic `arguments`: ref.symbol from
		// `getSymbolAtLocation` differs from `v.symbol` from
		// `getSymbolsInScope`, but both map to the same var). Lib vars and
		// the addGlobals fakes register in `_variableBySymbol` too, so
		// type-position refs to `Map` / `Set` / `Object` resolve to global.
		const out: TsReference[] = [];
		const localVars = new Set<TsVariable>();
		for (const v of this.variables) localVars.add(v);
		const isLocal = (sym: ts.Symbol | undefined) => {
			if (!sym) return false;
			const v = this.manager._variableBySymbol.get(sym);
			return v !== undefined && localVars.has(v);
		};
		for (const ref of this.references) {
			if (!isLocal(ref.symbol)) out.push(ref);
		}
		for (const child of this.childScopes) {
			// Skip function-expression-name (its lookup is the wrapped name's
			// own scope and not really visible to ancestors).
			for (const ref of child.through) {
				if (!isLocal(ref.symbol)) out.push(ref);
			}
		}
		return out;
	}
}

// upstream: `@typescript-eslint/scope-manager/dist/variable/Variable.js`
// (which extends `VariableBase.js`). Public API:
//   `name`, `scope`, `defs[]`, `identifiers[]`, `references[]`,
//   `writeable`, `isValueVariable`, `isTypeVariable`.
//
// Upstream's `defs` is populated eagerly during the Referencer walk —
// each declaration occurrence pushes one Definition into `defs`.
// We materialise on first access from `symbol.declarations` (TS
// already stores them on the Symbol). The two paths diverge for:
//   - lib-source declarations: filtered out (see `defs` getter); they
//     materialise to `GenericTSNode(parent=null)` and crash rules
//     reading `def.node.parent.type`.
//   - declaration merging: TS merges multiple decls into one Symbol;
//     upstream creates one Definition per visit. Same shape.
export class TsVariable {
	_defs?: TsDefinition[];
	_references?: TsReference[];
	_identifiers?: TSESTree.Identifier[];
	eslintUsed = false;
	eslintExported = false;
	eslintExplicitGlobal = false;
	eslintExplicitGlobalComments = undefined as undefined | unknown[];
	eslintImplicitGlobalSetting = undefined as undefined | string;

	constructor(readonly manager: TsScopeManager, readonly symbol: ts.Symbol) {}

	get name(): string {
		// `export default function f() {}` — TS gives the function's symbol
		// the synthetic name 'default'. Local-scope variable name should be
		// the declaration's identifier (`f`).
		if (this.symbol.name === 'default') {
			const decls = this.symbol.declarations;
			if (decls && decls.length > 0) {
				const nameNode = (decls[0] as { name?: { text?: string } }).name;
				if (nameNode?.text) return nameNode.text;
			}
		}
		return this.symbol.name;
	}

	private _scope?: TsScope;
	get scope(): TsScope {
		if (this._scope) return this._scope;
		const decl = this.symbol.declarations?.[0];
		if (!decl) return this._scope = this.manager.globalScope;
		const ts_ = ts;
		const SK = ts_.SyntaxKind;
		// Walk parents until we hit a scope-creating node.
		for (let cur: ts.Node | undefined = decl; cur; cur = cur.parent) {
			const arr = this.manager.nodeToScope.get(cur);
			if (arr && arr.length > 0) {
				// Pick the innermost non-fn-expr-name scope.
				for (let i = arr.length - 1; i >= 0; --i) {
					if (arr[i].type !== 'function-expression-name') return this._scope = arr[i];
				}
			}
			if (cur.kind === SK.SourceFile) break;
		}
		return this._scope = this.manager.globalScope;
	}

	_defsOverride?: TsDefinition[];
	_identifiersOverride?: TSESTree.Identifier[];

	// upstream: `Variable.js` `defs` (populated eagerly in
	// `ScopeBase.defineVariable`). One Definition per declaration
	// occurrence.
	get defs(): TsDefinition[] {
		if (this._defsOverride) return this._defsOverride;
		if (!this._defs) {
			const decls = this.symbol.declarations ?? [];
			// Filter out declarations that aren't in the user's source file
			// (e.g. TS lib declarations for `Map`, `Set`, `Promise`).
			// `materialize()` can't reach those — convertLazy only
			// pre-registers the user's SourceFile — so they fall back to
			// `GenericTSNode(parent=null)`. Rules that read
			// `def.node.parent.type` (naming-convention's `collectVariables`,
			// no-unused-vars, no-redeclare) crash on the null parent.
			// Upstream models the same symbols as `ImplicitLibVariable` with
			// no defs; mirror that for lib-sourced declarations.
			const userFile = this.manager.tsFile;
			this._defs = decls
				.filter(d => d.getSourceFile() === userFile)
				.map(d => new TsDefinition(this.manager, this, d));
		}
		return this._defs;
	}

	get identifiers(): TSESTree.Identifier[] {
		if (this._identifiersOverride) return this._identifiersOverride;
		if (!this._identifiers) {
			this._identifiers = this.defs.map(d => d.name).filter(Boolean) as TSESTree.Identifier[];
		}
		return this._identifiers;
	}

	get references(): TsReference[] {
		if (!this._references) {
			this._references = this.manager.getReferencesFor(this.symbol);
		}
		return this._references;
	}

	get writeable(): boolean {
		const decls = this.symbol.declarations ?? [];
		for (const d of decls) {
			const ts_ = ts;
			if (ts_.isVariableDeclaration(d)) {
				const list = d.parent;
				if (ts_.isVariableDeclarationList(list)) {
					if (list.flags & ts_.NodeFlags.Const) return false;
				}
			}
			if (ts_.isImportSpecifier(d) || ts_.isImportClause(d) || ts_.isNamespaceImport(d)) return false;
			if (ts_.isFunctionDeclaration(d) || ts_.isClassDeclaration(d) || ts_.isEnumDeclaration(d)) return false;
		}
		return true;
	}

	get isValueVariable(): boolean {
		// Match upstream's `Variable.isValueVariable`: `defs.some(d =>
		// d.isVariableDefinition)`. Definition flags per upstream's
		// per-DefinitionType subclasses:
		//   ImportBinding / Variable / TSEnumName / FunctionName / Parameter /
		//   CatchClause / TSModuleName / ClassName / TSEnumMember /
		//   ImplicitGlobalVariable → isVariableDefinition = true
		//   Type → isVariableDefinition = false
		// Reading symbol.flags directly misses ImportBinding (TS marks aliases
		// without `Value` until you resolve the alias); walking defs[] gives
		// the same answer no-shadow's `isTypeValueShadow` expects.
		if (this.defs.length === 0) return true; // implicit lib var (no static info)
		return this.defs.some(d => d.type !== 'Type');
	}

	get isTypeVariable(): boolean {
		// Match upstream's `Variable.isTypeVariable`: `defs.some(d =>
		// d.isTypeDefinition)`. Per upstream:
		//   ImportBinding / TSEnumName / Type / TSModuleName / ClassName /
		//   TSEnumMember → isTypeDefinition = true
		//   Variable / FunctionName / Parameter / CatchClause /
		//   ImplicitGlobalVariable → isTypeDefinition = false
		if (this.defs.length === 0) return true; // implicit lib var
		const TYPE_DEF_TYPES = new Set([
			'ImportBinding',
			'TSEnumName',
			'Type',
			'TSModuleName',
			'ClassName',
			'TSEnumMember',
		]);
		return this.defs.some(d => TYPE_DEF_TYPES.has(d.type));
	}
}

// upstream: `@typescript-eslint/scope-manager/dist/referencer/Reference.js`.
// Public API:
//   `identifier` (the Identifier ESTree node), `from` (containing
//   scope), `resolved` (Variable or null), `init` (declaration init?
//   tristate true/false/undefined), `writeExpr`,
//   `isWrite()` / `isRead()` / `isReadWrite()` / `isWriteOnly()` /
//   `isReadOnly()`, `isValueReference` / `isTypeReference`.
//
// Constructed lazily during `_ensureRefIndex` (one per pending
// Identifier with FREE_REF=1). Upstream constructs eagerly in the
// Referencer's `referenceValue` / `referenceType` calls.
export class TsReference {
	_estreeIdent?: TSESTree.Identifier;

	constructor(
		readonly manager: TsScopeManager,
		readonly tsIdentifier: ts.Identifier,
		readonly symbol: ts.Symbol,
	) {}

	get identifier(): TSESTree.Identifier {
		if (this._estreeIdent) return this._estreeIdent;
		const real = this.manager.tsToEstreeOrStub<TSESTree.Identifier>(this.tsIdentifier);
		// Real lazy Identifier — has `name` and a proper parent chain.
		if (real && (real as { name?: string }).name) {
			return this._estreeIdent = real;
		}
		// Fallback: tsToEstreeOrStub returned a generic stub (e.g. when the
		// identifier sits inside an unsupported kind and materialise fell
		// through). Construct the Identifier shape directly with the text,
		// and let the stub's parent chain (if any) attach.
		const stub: TSESTree.Identifier = {
			type: 'Identifier',
			name: this.tsIdentifier.text,
			range: [this.tsIdentifier.getStart(), this.tsIdentifier.end],
		} as TSESTree.Identifier;
		if (real && (real as { parent?: object }).parent) {
			(stub as { parent?: object }).parent = (real as { parent?: object }).parent;
		}
		return this._estreeIdent = stub;
	}

	private _from?: TsScope;
	get from(): TsScope {
		if (this._from) return this._from;
		const SK = ts.SyntaxKind;
		// Computed property names (`class { [expr]() {} }`, `{ [expr]: … }`)
		// are evaluated in the OUTER scope, not the method/property scope —
		// upstream visits the key before entering the function. Detect this
		// by checking for a ComputedPropertyName ancestor and, if so, skip
		// past the enclosing method's function scope.
		let skipMethodScope = false;
		// Inclusive: the identifier itself can be a scope-creating node
		// (e.g. class-field-initializer where the scope's block IS the
		// initializer expression — possibly the identifier being referenced).
		for (let cur: ts.Node | undefined = this.tsIdentifier; cur; cur = cur.parent) {
			if (cur.kind === SK.ComputedPropertyName) {
				skipMethodScope = true;
			}
			const arr = this.manager.nodeToScope.get(cur);
			if (arr && arr.length > 0) {
				for (let i = arr.length - 1; i >= 0; --i) {
					const s = arr[i];
					if (s.type === 'function-expression-name') continue;
					if (skipMethodScope && s.type === 'function') {
						// Skip this method/getter/setter scope — the computed
						// key reference belongs in the enclosing class/outer
						// scope.
						skipMethodScope = false;
						continue;
					}
					return this._from = s;
				}
			}
			if (cur.kind === SK.SourceFile) break;
		}
		return this._from = this.manager.globalScope;
	}

	get resolved(): TsVariable | null {
		// Resolved iff the symbol points to a variable declared in our scope
		// tree. Through refs (lib globals, undeclared) → null.
		if (!this.symbol) return null;
		const local = this.manager._variableBySymbol.get(this.symbol);
		if (local) return local;
		const lib = this.manager._libVariableBySymbol.get(this.symbol);
		return lib ?? null;
	}

	// Identifier IS the declaration name (binding position), not just a usage
	// of the symbol. Used internally by `init` / `isWrite` — cached so
	// the decl walk doesn't repeat.
	private _isBindingIdent?: boolean;
	get _isBindingIdentifier(): boolean {
		if (this._isBindingIdent !== undefined) return this._isBindingIdent;
		const decls = this.symbol?.declarations ?? [];
		const SK = ts.SyntaxKind;
		for (const d of decls) {
			// TS adds ExportSpecifier / ImportSpecifier as "declarations" of the
			// underlying symbol via aliasing. Those identifiers reference the
			// declared variable; they aren't fresh bindings, so don't count
			// them as init positions.
			if (d.kind === SK.ExportSpecifier || d.kind === SK.ImportSpecifier) continue;
			if ((d as { name?: ts.Node }).name === this.tsIdentifier) return this._isBindingIdent = true;
		}
		return this._isBindingIdent = false;
	}

	get init(): boolean | undefined {
		// ESLint's `init` tristate:
		//   - true  → declaration-with-initializer (`let x = expr`)
		//   - false → non-init write (`x = expr`)
		//   - undefined → pure read.
		if (this._isBindingIdentifier) return true;
		return this.isWrite() ? false : undefined;
	}

	isWrite(): boolean {
		const SK = ts.SyntaxKind;
		const id = this.tsIdentifier;
		const parent = id.parent;
		if (this._isBindingIdentifier) return true;
		if (!parent) return false;
		// Direct assignment: `x = …`, `x += …`.
		if (parent.kind === SK.BinaryExpression && (parent as ts.BinaryExpression).left === id) {
			const op = (parent as ts.BinaryExpression).operatorToken.kind;
			return op === SK.EqualsToken
				|| (op >= SK.FirstCompoundAssignment && op <= SK.LastCompoundAssignment);
		}
		// Update: `x++` / `++x`.
		if (parent.kind === SK.PrefixUnaryExpression || parent.kind === SK.PostfixUnaryExpression) {
			const op = (parent as ts.PrefixUnaryExpression | ts.PostfixUnaryExpression).operator;
			return op === SK.PlusPlusToken || op === SK.MinusMinusToken;
		}
		// Destructuring assignment: `[a] = …`, `({a} = …)`, etc. Walk up
		// through pattern wrappers (ArrayLiteralExpression / ObjectLiteralExpression
		// /SpreadElement / Property assignments / Parens) until we hit either
		// a `=` BinaryExpression (write) or anything else (not a write).
		for (let cur: ts.Node | undefined = parent; cur; cur = cur.parent) {
			switch (cur.kind) {
				case SK.ArrayLiteralExpression:
				case SK.ObjectLiteralExpression:
				case SK.SpreadElement:
				case SK.SpreadAssignment:
				case SK.PropertyAssignment:
				case SK.ShorthandPropertyAssignment:
				case SK.ParenthesizedExpression:
					continue;
				case SK.BinaryExpression: {
					const op = (cur as ts.BinaryExpression).operatorToken.kind;
					if (op !== SK.EqualsToken) return false;
					return (cur as ts.BinaryExpression).left.pos <= id.pos
						&& (cur as ts.BinaryExpression).left.end >= id.end;
				}
				case SK.ForInStatement:
				case SK.ForOfStatement:
					return (cur as ts.ForInStatement | ts.ForOfStatement).initializer.pos <= id.pos
						&& (cur as ts.ForInStatement | ts.ForOfStatement).initializer.end >= id.end;
				default:
					return false;
			}
		}
		return false;
	}

	isRead(): boolean {
		if (this._isBindingIdentifier) return false;
		if (!this.isWrite()) return true;
		const parent = this.tsIdentifier.parent;
		const ts_ = ts;
		// Compound assignments (`+=`, `-=`, etc.) read+write.
		if (parent && ts_.isBinaryExpression(parent) && parent.left === this.tsIdentifier) {
			return parent.operatorToken.kind !== ts_.SyntaxKind.EqualsToken;
		}
		// `x++` / `++x` / `x--` / `--x` read+write.
		if (parent && (ts_.isPrefixUnaryExpression(parent) || ts_.isPostfixUnaryExpression(parent))) {
			const op = parent.operator;
			return op === ts_.SyntaxKind.PlusPlusToken || op === ts_.SyntaxKind.MinusMinusToken;
		}
		return false;
	}

	isWriteOnly(): boolean {
		return this.isWrite() && !this.isRead();
	}
	isReadOnly(): boolean {
		return this.isRead() && !this.isWrite();
	}
	isReadWrite(): boolean {
		return this.isRead() && this.isWrite();
	}

	get writeExpr(): TSESTree.Node | null | undefined {
		// For an init reference (`let x = expr`, `function f(b = expr)`),
		// returns the initializer expression. For an assignment (`x = expr`,
		// `x += expr`), returns the right-hand side. For pure reads, returns
		// undefined (matches ESLint's distinction: present-but-null vs absent).
		const SK = ts.SyntaxKind;
		const id = this.tsIdentifier;
		const parent = id.parent;
		if (!parent) return undefined;
		// VariableDeclaration / Parameter init.
		if (
			(parent.kind === SK.VariableDeclaration && (parent as ts.VariableDeclaration).name === id)
			|| (parent.kind === SK.Parameter && (parent as ts.ParameterDeclaration).name === id)
		) {
			const init = (parent as { initializer?: ts.Node }).initializer;
			return init ? this.manager.tsToEstreeOrStub(init) ?? null : undefined;
		}
		// BindingElement (destructured init): use the enclosing VariableDeclaration's initializer.
		if (parent.kind === SK.BindingElement && (parent as ts.BindingElement).name === id) {
			for (let cur: ts.Node | undefined = parent; cur; cur = cur.parent) {
				if (cur.kind === SK.VariableDeclaration) {
					const init = (cur as ts.VariableDeclaration).initializer;
					return init ? this.manager.tsToEstreeOrStub(init) ?? null : undefined;
				}
				if (cur.kind === SK.Parameter) {
					const init = (cur as ts.ParameterDeclaration).initializer;
					return init ? this.manager.tsToEstreeOrStub(init) ?? null : undefined;
				}
			}
			return undefined;
		}
		// Assignment: x = rhs, x += rhs.
		if (parent.kind === SK.BinaryExpression && (parent as ts.BinaryExpression).left === id) {
			const op = (parent as ts.BinaryExpression).operatorToken.kind;
			if (
				op === SK.EqualsToken
				|| (op >= SK.FirstCompoundAssignment && op <= SK.LastCompoundAssignment)
			) {
				return this.manager.tsToEstreeOrStub((parent as ts.BinaryExpression).right) ?? null;
			}
		}
		return undefined;
	}

	get isValueReference(): boolean {
		const ts_ = ts;
		for (let cur: ts.Node | undefined = this.tsIdentifier.parent; cur; cur = cur.parent) {
			if (ts_.isTypeNode(cur)) return false;
			if (ts_.isExpression(cur)) return true;
		}
		return true;
	}

	get isTypeReference(): boolean {
		return !this.isValueReference;
	}
}

// upstream: `@typescript-eslint/scope-manager/dist/definition/`'s
// per-DefinitionType subclasses (VariableDefinition, ParameterDefinition,
// ImportBindingDefinition, TypeDefinition, …). Each upstream subclass
// hard-codes `isTypeDefinition` and `isVariableDefinition` booleans —
// see `Variable.isValueVariable` / `isTypeVariable` for how those
// flags compose.
//
// Public API: `type`, `name`, `node`, `parent`, `rest`,
// `isTypeDefinition`, `isVariableDefinition`. `node` and `parent`
// are the rule-facing accessors that flow through
// `tsToEstreeOrStub` → `materialize`. Both must yield ESTree nodes
// with proper `.parent` chains; rules read `def.node.parent.type`
// (no-redeclare, naming-convention's collectVariables, no-shadow's
// `isTypeValueShadow`) and a null parent here means a crash.
export class TsDefinition {
	constructor(
		readonly manager: TsScopeManager,
		readonly variable: TsVariable,
		readonly tsDeclaration: ts.Node,
	) {}

	// True for `function(...rest)` and `function([a, ...rest])` rest binding.
	get rest(): boolean {
		const d = this.tsDeclaration;
		if (ts.isParameter(d)) return d.dotDotDotToken !== undefined;
		if (ts.isBindingElement(d)) return d.dotDotDotToken !== undefined;
		return false;
	}

	get type(): DefinitionType {
		const ts_ = ts;
		const d = this.tsDeclaration;
		// BindingElement (destructured name): walk up to the enclosing
		// declaration to decide whether this is a Parameter or Variable def.
		if (ts_.isBindingElement(d)) {
			for (let cur: ts.Node | undefined = d.parent; cur; cur = cur.parent) {
				if (ts_.isParameter(cur)) return 'Parameter';
				if (ts_.isVariableDeclaration(cur)) {
					return cur.parent && ts_.isCatchClause(cur.parent) ? 'CatchClause' : 'Variable';
				}
			}
			return 'Variable';
		}
		if (ts_.isVariableDeclaration(d)) {
			// In TS, catch params are modeled as VariableDeclaration whose parent is
			// CatchClause; ESLint treats those as CatchClauseDefinition.
			if (d.parent && ts_.isCatchClause(d.parent)) return 'CatchClause';
			return 'Variable';
		}
		if (ts_.isParameter(d)) return 'Parameter';
		if (ts_.isFunctionDeclaration(d) || ts_.isFunctionExpression(d) || ts_.isArrowFunction(d)) return 'FunctionName';
		if (ts_.isClassDeclaration(d) || ts_.isClassExpression(d)) return 'ClassName';
		if (
			ts_.isImportSpecifier(d)
			|| ts_.isImportClause(d)
			|| ts_.isNamespaceImport(d)
			|| ts_.isImportEqualsDeclaration(d)
		) return 'ImportBinding';
		if (ts_.isCatchClause(d)) return 'CatchClause';
		if (ts_.isEnumDeclaration(d)) return 'TSEnumName';
		if (ts_.isEnumMember(d)) return 'TSEnumMember';
		if (ts_.isModuleDeclaration(d)) return 'TSModuleName';
		if (ts_.isTypeAliasDeclaration(d) || ts_.isInterfaceDeclaration(d) || ts_.isTypeParameterDeclaration(d)) {
			return 'Type';
		}
		return 'Variable';
	}

	get name(): TSESTree.Identifier | undefined {
		const nameNode = (this.tsDeclaration as { name?: ts.Node }).name;
		if (!nameNode) return undefined;
		return this.manager.tsToEstreeOrStub<TSESTree.Identifier>(nameNode);
	}

	get node(): TSESTree.Node | undefined {
		// For Variable defs, ESLint expects the VariableDeclarator (TS:
		// VariableDeclaration). For destructured names whose declaration is a
		// BindingElement / pattern, walk up until we find the declarator.
		const ts_ = ts;
		let target: ts.Node = this.tsDeclaration;
		while (
			target
			&& (ts_.isBindingElement(target)
				|| ts_.isObjectBindingPattern(target)
				|| ts_.isArrayBindingPattern(target))
		) {
			target = target.parent;
		}
		// Parameter: ESLint expects `node` to be the enclosing function-like.
		if (target && ts_.isParameter(target) && target.parent) {
			target = target.parent;
		}
		// Catch param: TS models as VariableDeclaration under CatchClause; ESLint
		// expects the CatchClause itself as the def's node.
		if (target && ts_.isVariableDeclaration(target) && target.parent && ts_.isCatchClause(target.parent)) {
			target = target.parent;
		}
		const result = this.manager.tsToEstreeOrStub<TSESTree.Node>(target);
		// Unwrap export wrapper: `export function f` materializes to
		// ExportNamedDeclaration containing the FunctionDeclaration. ESLint
		// expects `def.node` to be the inner declaration so rules like
		// `no-shadow` (`isFunctionTypeParameterNameValueShadow` checks
		// `def.node.type === 'TSDeclareFunction'`) work on overload sigs.
		if (
			result && (
				(result as { type?: string }).type === 'ExportNamedDeclaration'
				|| (result as { type?: string }).type === 'ExportDefaultDeclaration'
			)
		) {
			const inner = (result as { declaration?: TSESTree.Node }).declaration;
			if (inner) return inner;
		}
		return result;
	}

	get parent(): TSESTree.Node | undefined {
		// For VariableDeclarator, parent is VariableDeclaration (TS:
		// VariableDeclarationList → parent is VariableStatement).
		const ts_ = ts;
		let target: ts.Node = this.tsDeclaration;
		while (
			target
			&& (ts_.isBindingElement(target)
				|| ts_.isObjectBindingPattern(target)
				|| ts_.isArrayBindingPattern(target))
		) {
			target = target.parent;
		}
		// VariableDeclaration → parent is VariableDeclarationList → parent is
		// VariableStatement (which corresponds to ESTree VariableDeclaration).
		// In for-of / for-in / for-init position the VariableDeclarationList
		// itself IS the ESTree VariableDeclaration (mapped via
		// VariableDeclarationListAsNode), so the def's parent must point at
		// the list — NOT at the enclosing ForOfStatement / ForInStatement /
		// ForStatement. ESLint's no-loop-func reads `definition.parent.kind`
		// to skip block-scoped `let` / `const` bindings; getting this wrong
		// produces false positives on every block-scoped iteration variable.
		if (target && ts_.isVariableDeclaration(target)) {
			const list = target.parent;
			if (list && ts_.isVariableDeclarationList(list)) {
				const owner = list.parent;
				if (owner && ts_.isVariableStatement(owner)) {
					return this.manager.tsToEstreeOrStub(owner);
				}
				return this.manager.tsToEstreeOrStub(list);
			}
		}
		// Import bindings: TS nests `ImportSpecifier → NamedImports →
		// ImportClause → ImportDeclaration`, but ESTree skips NamedImports
		// and ImportClause — `ImportSpecifier.parent` IS `ImportDeclaration`.
		// no-shadow's `isTypeValueShadow` reads
		// `def.parent.type === 'ImportDeclaration'` and
		// `def.parent.specifiers.some(s => s.importKind === 'type')` to
		// detect any-specifier-type imports; without unwrapping we hand
		// back the synthetic `TSNamedImports` and the check silently
		// fails → 19 no-shadow false positives in TS repo's
		// `src/compiler/utilities.ts` whose import block has type-only
		// specifiers.
		if (target && (ts_.isImportSpecifier(target) || ts_.isNamespaceImport(target) || ts_.isImportClause(target))) {
			let cur: ts.Node = target.parent;
			while (cur && !ts_.isImportDeclaration(cur)) cur = cur.parent;
			if (cur) return this.manager.tsToEstreeOrStub(cur);
		}
		return this.manager.tsToEstreeOrStub(target?.parent);
	}

	get isVariableDefinition(): boolean {
		return this.type === 'Variable' || this.type === 'Parameter';
	}
	get isTypeDefinition(): boolean {
		return this.type === 'Type';
	}
}

// Synthetic def for implicit globals — `x = 1;` for an undeclared `x`.
// `tsDeclaration` is the first write reference's identifier (a stand-in
// for a real declaration node).
export class TsImplicitGlobalDefinition extends TsDefinition {
	get type(): DefinitionType {
		return 'ImplicitGlobalVariable';
	}
	get name(): TSESTree.Identifier | undefined {
		return this.manager.tsToEstreeOrStub<TSESTree.Identifier>(this.tsDeclaration);
	}
	get node(): TSESTree.Node | undefined {
		return this.name;
	}
	get parent(): TSESTree.Node | undefined {
		return undefined;
	}
	get isVariableDefinition(): boolean {
		return true;
	}
	get isTypeDefinition(): boolean {
		return false;
	}
}

// Declares ECMAScript built-ins (es2026 from ESLint's `conf/globals.js`)
// plus TS `lib.*.d.ts` type globals on the manager's `globalScope`.
// Called by the compat-eslint lint pipeline so `no-undef` doesn't fire on
// `undefined` / `Math` / `Promise` / `Record<K, V>` / etc. — names that
// `@typescript-eslint/scope-manager`'s lib data marks TYPE-only after
// merging.
//
// Kept as a free function (not a `TsScopeManager` method) because this is
// a lint-pipeline policy, not a scope-analysis fact: upstream
// `eslint-scope` parity tests construct managers without it and would
// fail if it ran inside the constructor.
export function applyEslintGlobals(manager: TsScopeManager): void {
	manager.addGlobals(ESLINT_BUILTIN_GLOBALS as string[]);
	manager.addGlobals(TS_LIB_TYPE_GLOBALS as string[]);
}
