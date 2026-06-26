// tsgo backend — alternative to ts.createProgram for the linter's
// `ctx.program()` thunk. Activated by `--tsgo`. Spawns the
// @typescript/native-preview binary, holds a Snapshot/Project, and
// presents `Project.program` + `Project.checker` as a ts.Program /
// ts.TypeChecker subset that satisfies the linter's contract.
//
// Two non-obvious invariants:
//
//   1. Symbol resolution batching. tsgo Checker calls are sync RPCs.
//      `Checker.getSymbolAtLocation([nodes])` and
//      `Checker.getSymbolAtPosition(file, [positions])` are array
//      overloads — N nodes resolved in 1 RPC. We do a per-file prepass:
//      walk the AST, collect every Identifier, batched-resolve once,
//      stash in `nodeToSymbol`. Rules then call `getSymbolAtLocation`
//      synchronously and read from the Map.
//
//   2. `getSymbolAtLocation` doesn't resolve identifiers in
//      import/export specifier position (~76% miss rate on type-heavy
//      TS files). `getSymbolAtPosition(file, [endOffsets])` does. The
//      prepass uses the position-based API as primary and falls back
//      to location-based for the small remainder (mostly object-spread
//      method names where position is "between siblings").
//
// AST node identity is preserved across calls — tsgo's SourceFileCache
// hands back the same parsed SF object for the same path within a
// snapshot, and we reuse those Node references as Map keys.

import path = require('path');
import ts = require('typescript');

import { loadTsgoModules } from './tsgo-load.js';
import { acquireSharedTsgoApi, closeSharedTsgoApi } from './tsgo-api-pool.js';
import {
	createRpcProfile,
	isTsgoRpcProfileEnabled,
	memoGet,
	memoGet2,
	type RpcProfile,
} from './tsgo-rpc-profile.js';
import { batchPrefetchTypes, EMPTY_PREFETCH_PLAN, type PrefetchPlan } from './tsgo-prefetch.js';

// `@typescript/native-preview` ships ESM-only. Under Node16 module
// resolution, type-only imports of an ESM package from this CJS file
// require the `'resolution-mode': 'import'` attribute. We thread that
// through once via `import(..., { with: ... })` aliases and reuse them.
type TsgoSync = typeof import('@typescript/native-preview/unstable/sync', { with: { 'resolution-mode': 'import' } });
type Snapshot = InstanceType<TsgoSync['Snapshot']>;
type Project = InstanceType<TsgoSync['Project']>;
type TsgoSymbol = InstanceType<TsgoSync['Symbol']>;
type Node = import('@typescript/native-preview/unstable/ast', { with: { 'resolution-mode': 'import' } }).Node;

export interface TsgoBackend {
	// ts.Program-shape adapter, fed to LinterContext.program().
	getProgram(): ts.Program;
	// Per-file setup before rules run: prototype-patches the tsgo Node
	// hierarchy on first call, then bind-via-real-ts the file so the
	// JS-side scope walker can answer in-process Symbol queries.
	// Idempotent on unchanged text (cached).
	prepareFile(fileName: string, prefetchPlan?: PrefetchPlan): void;
	// Drop the JS-side bind + position maps for one file. Call after
	// the file's lint pass completes so the bound SF doesn't pin in
	// memory across the rest of the project's lint. Subsequent lint of
	// the SAME file (rare, e.g. `--fix` rewrite + re-lint) re-binds
	// from current text via prepareFile.
	releaseFile(fileName: string): void;
	// Drop the JS-side bind cache for a file. Call after `--fix`
	// rewrites file content so the next `prepareFile` re-binds against
	// the new text.
	invalidateFile(fileName: string): void;
	// Drop per-project adapter state; keep the shared tsgo child alive.
	dispose(): void;
	// Tear down adapter + shared tsgo child (tests / explicit shutdown).
	close(): void;
}

// Process-level guards. All prototype patches are one-shot per process
// (tsgo's class shapes are stable per binary version).
let nodeProtoPatched = false;
const patchedTypeProtos = new WeakSet<object>();
let nodeHandleProtoPatched = false;
let symbolProtoPatched = false;
let nodeListSpeciesPatched = false;
let signatureProtoPatched = false;

// ── Per-session memo for Type/Symbol object methods ──────────────────
// tsgo's TypeObject / Symbol methods (getSymbol, getTarget, getTypes,
// getMembers, getExports, …) each issue an `apiRequest` IPC on first
// access. The object registry caches the *resulting objects* by id, but
// the method call itself still round-trips every time the method is
// invoked — even when the same caller asks repeatedly. These maps add a
// result-level memo keyed by the owning object's numeric id, so the
// second+ call for the same id is a Map lookup, not a sync IPC.
// Cleared in clearAllCheckerMemoCaches (session/snapshot boundary).
let typeMethodMemo: Map<string, unknown> | undefined;
let symbolMethodMemo: Map<string, unknown> | undefined;

function memoTypeMethod<T>(this: { id: number }, key: string, fn: () => T): T {
	const k = this.id + ':' + key;
	const cache = typeMethodMemo!;
	const cached = cache.get(k);
	if (cached !== undefined) return cached as T;
	const v = fn();
	cache.set(k, v ?? (null as unknown as T));
	return v;
}
function memoSymbolMethod<T>(this: { id: number }, key: string, fn: () => T): T {
	const k = this.id + ':' + key;
	const cache = symbolMethodMemo!;
	const cached = cache.get(k);
	if (cached !== undefined) return cached as T;
	const v = fn();
	cache.set(k, v ?? (null as unknown as T));
	return v;
}

function patchTsgoNodeListSpecies(sample: object): void {
	if (nodeListSpeciesPatched) return;
	const ctor = (sample as { constructor?: any }).constructor;
	if (!ctor) return;
	if (ctor[Symbol.species] !== Array) {
		Object.defineProperty(ctor, Symbol.species, {
			configurable: true,
			get: () => Array,
		});
	}
	nodeListSpeciesPatched = true;
}

// tsgo's Node interface exposes `pos` / `end` (raw parser offsets,
// leading trivia included), `parent`, `kind`, `forEachChild`,
// `getSourceFile()`. It does NOT provide ts.Node's instance methods
// `getStart` / `getEnd` / `getText` — TS adds these on the runtime
// NodeObject prototype, and rule code (lazy-estree's range computation,
// plenty of compat-eslint utilities) calls them as if every Node is a
// ts.Node.
//
// Tsgo nodes returned from the API are `RemoteNode` / `RemoteSourceFile`
// instances (separate class hierarchy from the locally-instantiable
// `NodeObject` that `/ast/factory` exposes). The Remote classes live at
// dist paths NOT listed in the package's `exports` map — we can't
// `require` them by name. Instead we walk up the prototype chain from a
// live Node sample to the topmost non-Object prototype (RemoteNodeBase)
// and patch there. One-time; the chain shape is stable per tsgo version.
//
// Math: `getStart` = `pos` advanced past leading trivia (whitespace +
// comments), `getEnd` = `end`, `getText` = `sf.text.slice(getStart, end)`.
// tsgo's scanner emits standard TS trivia, so reusing real `ts.skipTrivia`
// gives bit-identical positions to ts.Node.
function patchTsgoNodeProto(sample: Node): void {
	if (nodeProtoPatched) return;
	let proto: any = Object.getPrototypeOf(sample);
	while (proto && Object.getPrototypeOf(proto) !== Object.prototype) {
		proto = Object.getPrototypeOf(proto);
	}
	if (!proto) {
		throw new Error('tsgo backend: could not locate Node prototype to patch');
	}
	// `skipTrivia` is technically `@internal` in ts's published .d.ts but
	// has been runtime-exported since 0.x — every linter / codemod tool
	// uses it. The runtime check survives if a future ts removes it.
	const skipTrivia = (ts as unknown as {
		skipTrivia?: (
			text: string,
			pos: number,
			stopAfterLineBreak?: boolean,
			stopAtComments?: boolean,
		) => number;
	}).skipTrivia;
	if (!skipTrivia) {
		throw new Error('tsgo backend: ts.skipTrivia not available — getStart shim cannot be installed');
	}
	if (typeof proto.getStart !== 'function') {
		proto.getStart = function (
			sf?: { text: string },
			includeJsDocComments?: boolean,
		): number {
			const text = (sf ?? this.getSourceFile()).text;
			return skipTrivia(text, this.pos, false, includeJsDocComments);
		};
	}
	if (typeof proto.getEnd !== 'function') {
		proto.getEnd = function (): number {
			return this.end;
		};
	}
	if (typeof proto.getText !== 'function') {
		proto.getText = function (sf?: { text: string }): string {
			const file = sf ?? this.getSourceFile();
			return file.text.slice(this.getStart(file), this.end);
		};
	}
	if (typeof proto.getFullStart !== 'function') {
		proto.getFullStart = function (): number {
			return this.pos;
		};
	}
	if (typeof proto.getFullText !== 'function') {
		proto.getFullText = function (sf?: { text: string }): string {
			const file = sf ?? this.getSourceFile();
			return file.text.slice(this.pos, this.end);
		};
	}
	if (typeof proto.getWidth !== 'function') {
		proto.getWidth = function (sf?: { text: string }): number {
			return this.end - this.getStart(sf);
		};
	}
	if (typeof proto.getFullWidth !== 'function') {
		proto.getFullWidth = function (): number {
			return this.end - this.pos;
		};
	}
	// `SourceFile.getLineAndCharacterOfPosition(pos)` — used by
	// compat-eslint (and by ts itself for diagnostic span rendering)
	// to convert offsets to line/character. Real ts caches `lineMap` on
	// the SF; tsgo doesn't, so we compute lineStarts lazily and stash
	// on the SF instance the first time it's asked.
	if (typeof proto.getLineAndCharacterOfPosition !== 'function') {
		proto.getLineAndCharacterOfPosition = function (
			this: { text?: string; getSourceFile(): { text: string }; _lineStarts?: number[] },
			position: number,
		): { line: number; character: number } {
			const text = this.text ?? this.getSourceFile().text;
			let starts = this._lineStarts;
			if (!starts) {
				starts = [0];
				for (let i = 0; i < text.length; i++) {
					const c = text.charCodeAt(i);
					if (c === 10) starts.push(i + 1);
					else if (c === 13) {
						if (text.charCodeAt(i + 1) === 10) i++;
						starts.push(i + 1);
					}
				}
				this._lineStarts = starts;
			}
			// Binary search for the largest lineStart ≤ position.
			let lo = 0, hi = starts.length - 1;
			while (lo < hi) {
				const mid = (lo + hi + 1) >>> 1;
				if (starts[mid] <= position) lo = mid; else hi = mid - 1;
			}
			return { line: lo, character: position - starts[lo] };
		};
	}
	if (typeof proto.getLineStarts !== 'function') {
		proto.getLineStarts = function (this: { _lineStarts?: number[]; getLineAndCharacterOfPosition(p: number): unknown }) {
			// Trigger the lazy build via a no-op call; cache lives on `_lineStarts`.
			this.getLineAndCharacterOfPosition(0);
			return this._lineStarts!;
		};
	}
	// Inverse: convert (line, character) → position. compat-eslint's
	// ESLint→TSSLint report converter calls this to map ESTree's
	// loc-based descriptors back to file offsets. Without it, the
	// converter's swallowing try/catch defaults start/end to 0 → all
	// diagnostics collapse to (line=1, col=1) at file start.
	if (typeof proto.getPositionOfLineAndCharacter !== 'function') {
		proto.getPositionOfLineAndCharacter = function (
			this: { getLineStarts(): number[] },
			line: number,
			character: number,
		): number {
			const starts = this.getLineStarts();
			return (starts[line] ?? 0) + character;
		};
	}
	nodeProtoPatched = true;
}

// `ts.Type` exposes a clutch of flag-based predicates as instance
// methods (`isLiteral`, `isStringLiteral`, `isUnion`, `getSymbol`, …).
// Rule code (typescript-eslint's `no-unnecessary-type-assertion`,
// many compat-eslint paths) calls these. tsgo's TypeObject only has
// `getSymbol` and the data fields; we patch the missing predicates onto
// its prototype using tsgo's TypeFlags enum values (different from ts).
//
// Located via prototype walk from a sample Type — TypeObject isn't in
// the package exports map. One-shot per process.
function getTypePrototype(sample: object): any {
	let proto: any = Object.getPrototypeOf(sample);
	while (proto && Object.getPrototypeOf(proto) !== Object.prototype) {
		proto = Object.getPrototypeOf(proto);
	}
	return proto ?? undefined;
}

function installTypePredicateShims(target: { flags?: number }, sync: TsgoSync): void {
	if (typeof (target as { isUnionOrIntersection?: unknown }).isUnionOrIntersection === 'function') {
		return;
	}
	if (typeof target.flags !== 'number') return;
	const TF = (sync as any).TypeFlags as Record<string, number>;
	const has = (flag: number) => function (this: { flags: number }) { return (this.flags & flag) !== 0; };
	const t = target as Record<string, unknown>;
	if (!t.isStringLiteral) t.isStringLiteral = has(TF.StringLiteral);
	if (!t.isNumberLiteral) t.isNumberLiteral = has(TF.NumberLiteral);
	if (!t.isBooleanLiteral) t.isBooleanLiteral = has(TF.BooleanLiteral);
	if (!t.isBigIntLiteral) t.isBigIntLiteral = has(TF.BigIntLiteral);
	if (!t.isEnumLiteral) t.isEnumLiteral = has(TF.EnumLiteral);
	if (!t.isLiteral) t.isLiteral = has(
		TF.StringLiteral | TF.NumberLiteral | TF.BigIntLiteral | TF.BooleanLiteral,
	);
	if (!t.isUnion) t.isUnion = has(TF.Union);
	if (!t.isIntersection) t.isIntersection = has(TF.Intersection);
	if (!t.isUnionOrIntersection) {
		t.isUnionOrIntersection = has(TF.UnionOrIntersection ?? (TF.Union | TF.Intersection));
	}
	if (!t.isTypeParameter) t.isTypeParameter = has(TF.TypeParameter);
	if (!t.isClassOrInterface) t.isClassOrInterface = () => false;
	if (!t.isClass) t.isClass = () => false;
	if (!t.isIndexType) t.isIndexType = has(TF.Index);
	if (!t.getFlags) t.getFlags = function (this: { flags: number }) { return this.flags; };
	if (!t.isNullableType) t.isNullableType = has((TF.Null ?? 0) | (TF.Undefined ?? 0));
}

function patchTsgoTypeProto(sample: object, sync: TsgoSync): void {
	const proto = getTypePrototype(sample);
	if (!proto || patchedTypeProtos.has(proto)) {
		installTypePredicateShims(sample as { flags?: number }, sync);
		return;
	}
	patchedTypeProtos.add(proto);
	installTypePredicateShims(proto, sync);
	// `types` property — typescript-eslint's ts-api-utils
	// (`unionConstituents`) reads `type.types` directly on Union /
	// Intersection types. tsgo exposes the constituents via `getTypes()`
	// instead. Lazy getter preserves the no-RPC-on-bind contract.
	if (!Object.getOwnPropertyDescriptor(proto, 'types')) {
		Object.defineProperty(proto, 'types', {
			configurable: true,
			get(this: { getTypes?: () => unknown[] }) {
				const types = this.getTypes ? this.getTypes() : undefined;
				if (types && fixupTypeRef.fn) {
					for (const child of types) fixupTypeRef.fn(child);
				}
				return types;
			},
		});
	}
	// Do NOT add an `aliasTypeArguments` getter — tsgo's
	// `getAliasTypeArguments()` reads `this.aliasTypeArguments` as a
	// handle cache, so a getter that calls the method loops forever.
	// `getCallSignatures()` / `getConstructSignatures()` — instance shims
	// that delegate to the Checker. We can't reach the Checker from here
	// without a closure; install via patchTsgoTypeProtoWithChecker
	// (separate hook called from wrapChecker).

	// ── Memoize IPC-backed Type object methods ──────────────────────
	// tsgo's TypeObject.getSymbol/getTarget/getTypes/etc. each issue an
	// `apiRequest` on first access. Wrap them with a per-id result cache
	// so repeat calls are Map lookups, not sync IPC.
	const wrap0 = (name: string) => {
		const desc = Object.getOwnPropertyDescriptor(proto, name);
		if (!desc || typeof desc.value !== 'function') return;
		const orig = desc.value;
		proto[name] = function (this: { id: number }) {
			return memoTypeMethod.call(this, name, () => {
				const r = orig.call(this);
				if (r && fixupTypeRef.fn) {
					if (Array.isArray(r)) for (const c of r) fixupTypeRef.fn(c);
					else fixupTypeRef.fn(r);
				}
				return r;
			});
		};
	};
	for (const m of [
		'getSymbol', 'getTarget', 'getFreshType', 'getRegularType',
		'getTypes', 'getTypeParameters', 'getOuterTypeParameters',
		'getLocalTypeParameters', 'getAliasTypeArguments',
		'getObjectType', 'getIndexType', 'getCheckType', 'getExtendsType',
		'getBaseType', 'getConstraint',
	]) wrap0(m);
}

// Type instance methods that need a Checker reference (signatures,
// properties). Patched per prototype chain as types are fixup'd.
const patchedTypeCheckerProtos = new WeakSet<object>();
function patchTsgoTypeCheckerMethods(sample: object, sync: TsgoSync, _project: Project): void {
	const proto = getTypePrototype(sample);
	if (!proto || patchedTypeCheckerProtos.has(proto)) return;
	patchedTypeCheckerProtos.add(proto);
	const SK = (sync as any).SignatureKind as Record<string, number>;
	const TF = (sync as any).TypeFlags as Record<string, number>;
	// Primitive/literal/never-like types can never carry call/construct signatures.
	const noSigMask =
		(TF.Never ?? 0) | (TF.Undefined ?? 0) | (TF.Null ?? 0) | (TF.Void ?? 0) |
		(TF.StringLiteral ?? 0) | (TF.NumberLiteral ?? 0) | (TF.BooleanLiteral ?? 0) |
		(TF.BigIntLiteral ?? 0) | (TF.EnumLiteral ?? 0) | (TF.TemplateLiteral ?? 0) |
		(TF.StringMapping ?? 0) | (TF.UniqueESSymbol ?? 0) | (TF.Enum ?? 0);
	if (!proto.getCallSignatures) {
		proto.getCallSignatures = function (this: { id: string; flags: number }) {
			if (typeof this.flags === 'number' && (this.flags & noSigMask) !== 0) return [];
			return wrappedCheckerRef.checker!.getSignaturesOfType(this as any, SK.Call as any);
		};
	}
	if (!proto.getConstructSignatures) {
		proto.getConstructSignatures = function (this: { id: string; flags: number }) {
			if (typeof this.flags === 'number' && (this.flags & noSigMask) !== 0) return [];
			return wrappedCheckerRef.checker!.getSignaturesOfType(this as any, SK.Construct as any);
		};
	}
	if (!proto.getProperties) {
		proto.getProperties = function (this: any) {
			return wrappedCheckerRef.checker!.getPropertiesOfType(this);
		};
	}
	if (!proto.getProperty) {
		proto.getProperty = function (this: any, name: string) {
			return this.getProperties().find((p: any) => p.name === name);
		};
	}
	if (!proto.getBaseTypes) {
		proto.getBaseTypes = function (this: any) {
			return wrappedCheckerRef.checker!.getBaseTypes(this);
		};
	}
	if (!proto.getNonNullableType) {
		proto.getNonNullableType = function (this: any) {
			return wrappedCheckerRef.checker!.getNonNullableType(this);
		};
	}
}

// `Signature` on tsgo lacks ts.Signature's accessor methods
// (`getReturnType`, `getDeclaration`, `getTypeParameters`,
// `getParameters`). Add thin wrappers — `getReturnType` delegates via
// the current project's checker; the rest read existing data fields.
function patchTsgoSignatureProto(sync: TsgoSync): void {
	if (signatureProtoPatched) return;
	const Signature = (sync as any).Signature;
	if (!Signature?.prototype) return;
	const proto = Signature.prototype;
	if (!proto.getReturnType) {
		proto.getReturnType = function (this: { id: string }) {
			const t = wrappedCheckerRef.checker!.getReturnTypeOfSignature(this as any);
			if (fixupTypeRef.fn) fixupTypeRef.fn(t);
			return t;
		};
	}
	if (!proto.getDeclaration) {
		proto.getDeclaration = function (this: { declaration: unknown }) {
			return this.declaration;
		};
	}
	if (!proto.getTypeParameters) {
		proto.getTypeParameters = function (this: { typeParameters: unknown[] }) {
			return this.typeParameters;
		};
	}
	if (!proto.getParameters) {
		proto.getParameters = function (this: { parameters: unknown[] }) {
			return this.parameters;
		};
	}
	signatureProtoPatched = true;
}

// `Symbol` on tsgo carries data fields and a few RPC-backed methods,
// but is missing ts.Symbol's instance-method facade (`getDeclarations`,
// `getName`, `getEscapedName`, `getFlags`). Rule code reads those — add
// thin getters that read the data fields.
function patchTsgoSymbolProto(sync: TsgoSync): void {
	if (symbolProtoPatched) return;
	const Symbol = (sync as any).Symbol;
	if (!Symbol?.prototype) return;
	const proto = Symbol.prototype;
	if (!proto.getDeclarations) {
		proto.getDeclarations = function (this: { declarations: unknown[] }) {
			return this.declarations;
		};
	}
	if (!proto.getName) {
		proto.getName = function (this: { name: string }) {
			return this.name;
		};
	}
	if (!proto.getEscapedName) {
		// tsgo doesn't have escapedName / __String distinction the way
		// ts does; the regular `name` is fine for rule comparisons.
		proto.getEscapedName = function (this: { name: string }) {
			return this.name;
		};
	}
	if (!proto.getFlags) {
		proto.getFlags = function (this: { flags: number }) {
			return this.flags;
		};
	}
	// Mirror `escapedName` field too — typescript-estree reads it
	// directly on the symbol object.
	if (!Object.getOwnPropertyDescriptor(proto, 'escapedName')) {
		Object.defineProperty(proto, 'escapedName', {
			configurable: true,
			get(this: { name: string }) { return this.name; },
		});
	}
	// ── Memoize IPC-backed Symbol object methods ────────────────────
	// getMembers / getExports / getParent / getExportSymbol each issue
	// an `apiRequest` on first access. Wrap with per-id result cache.
	const wrapSym = (name: string) => {
		const desc = Object.getOwnPropertyDescriptor(proto, name);
		if (!desc || typeof desc.value !== 'function') return;
		const orig = desc.value;
		proto[name] = function (this: { id: number }) {
			return memoSymbolMethod.call(this, name, () => {
				const r = orig.call(this);
				if (r && fixupTypeRef.fn) {
					if (Array.isArray(r)) for (const c of r) fixupTypeRef.fn(c);
					else fixupTypeRef.fn(r);
				}
				return r;
			});
		};
	};
	for (const m of ['getMembers', 'getExports', 'getParent', 'getExportSymbol']) {
		wrapSym(m);
	}
	symbolProtoPatched = true;
}

// `Symbol.declarations` on tsgo is `NodeHandle[]` — lazy stubs with
// `kind / pos / end / path` and a `resolve(project)` method. Rule code
// expects real `ts.Node[]` and reads `.parent` / calls `.getSourceFile()`
// directly. Patch NodeHandle's prototype to upgrade-on-access:
//
//   - `getSourceFile()` short-circuits to `project.program.getSourceFile(path)`
//     — common in scope-manager lib-symbol checks; doesn't need full Node
//     materialisation since `project.isSourceFileDefaultLibrary(sf)` is
//     fed straight back to the wrapped Program.
//
//   - `parent` getter resolves the handle once via `resolve(project)`, then
//     reads parent off the resolved Node. Cached on the instance so repeat
//     reads skip the `findDescendant` walk.
//
// Multi-project: `currentProjectRef.project` is rebound in createTsgoBackend()
// every setup. The prototype patch closes over the holder, not the project
// instance — so NodeHandles produced under project A but accessed after
// the worker switches to project B route through B's live API. Safe
// because lint() processes one file at a time within one project and
// hands no cross-project handles around.
// Set in wrapChecker so proto `types` getter can fixup union constituents.
const fixupTypeRef: { fn?: (t: unknown) => unknown } = {};
const rpcProfileRef: { current: RpcProfile | undefined } = { current: undefined };
const currentProjectRef: { project: Project | undefined } = { project: undefined };
// The wrapped, memoized checker — set in wrapChecker so that
// patchTsgoTypeCheckerMethods can route type.getProperties() etc.
// through the memo layer instead of the raw project.checker (which
// would issue a fresh IPC per call with no caching).
const wrappedCheckerRef: { checker: ts.TypeChecker | undefined } = { checker: undefined };

function installNodeHandleHooks(sync: TsgoSync): void {
	if (nodeHandleProtoPatched) return;
	const NodeHandle = (sync as any).NodeHandle;
	if (!NodeHandle?.prototype) return;
	const proto = NodeHandle.prototype;
	if (typeof proto.getSourceFile !== 'function') {
		proto.getSourceFile = function (this: { path: string }) {
			const project = currentProjectRef.project;
			if (!project) return undefined;
			return project.program.getSourceFile(this.path);
		};
	}
	if (!Object.getOwnPropertyDescriptor(proto, 'parent')) {
		Object.defineProperty(proto, 'parent', {
			configurable: true,
			get(this: { _resolvedNode?: Node | null; resolve: (p: Project) => Node | undefined }) {
				if (this._resolvedNode === undefined) {
					const project = currentProjectRef.project;
					this._resolvedNode = project ? this.resolve(project) ?? null : null;
				}
				return this._resolvedNode?.parent;
			},
		});
	}
	nodeHandleProtoPatched = true;
}

export function createTsgoBackend(
	tsconfig: string,
	options?: { deferPerFileRelease?: boolean },
): TsgoBackend {
	// Lazy require so users without the optional peer dep don't crash on
	// load. The CLI gates this behind `--tsgo` so non-tsgo users never
	// reach here.
	const trace = process.env.TSSLINT_TIME_TSGO === '1';
	const t0 = Date.now();
	const { sync, ast } = loadTsgoModules();
	const tImport = Date.now();
	const api = acquireSharedTsgoApi();
	const tApi = Date.now();
	const snapshot: Snapshot = api.updateSnapshot({ openProject: tsconfig });
	const tSnap = Date.now();
	const project = snapshot.getProject(tsconfig);
	const tProject = Date.now();
	if (!project) {
		throw new Error(`tsgo: project not found for ${tsconfig}`);
	}
	if (trace) {
		console.error(
			`[tsgo-time] createBackend total=${tProject - t0}ms `
			+ `(import=${tImport - t0} api=${tApi - tImport} `
			+ `updateSnapshot=${tSnap - tApi} getProject=${tProject - tSnap})`,
		);
	}

	const deferPerFileRelease = options?.deferPerFileRelease ?? false;

	// Per-fileName Symbol cache, populated by `prepareFile`. Keyed by the
	// tsgo Node object reference (not its position) — the AST tree is
	// hydrated client-side and walks return the same Node instances each
	// time within a snapshot.
	const nodeToSymbol = new Map<Node, TsgoSymbol | undefined>();
	// Files prepass'd this snapshot. Skip re-walk on repeat lint() calls.
	const preparedFiles = new Set<string>();

	// Per-backend JS Symbol resolver. Owns the bound-SF + position-map
	// caches; releases them on close(). Replaces the module-level singleton
	// so two backends in the same worker (multi-project lint) don't share
	// stale caches across snapshots.
	const jsSymbolResolver: import('./tsgo-js-symbols.js').JsSymbolResolver
		= require('./tsgo-js-symbols.js').createJsSymbolResolver({
			tsgoSyntaxKind: ast.SyntaxKind,
		});
	jsSymbolResolverRef.current = jsSymbolResolver;

	const { program, prefetchTypesForFile, clearCheckerMemoCaches, clearAllCheckerMemoCaches } = wrapProgram(
		project,
		nodeToSymbol,
	);
	currentProjectRef.project = project;
	installNodeHandleHooks(sync);

	// ── Debug: instrument ALL apiRequest calls ──────────────────────
	if (trace) {
		const client = (project as any).client;
		if (client && typeof client.apiRequest === 'function' && !client.__tsslintInstrumented) {
			client.__tsslintInstrumented = true;
			const origReq = client.apiRequest.bind(client);
			const allStats = new Map<string, { calls: number; ms: number }>();
			client.apiRequest = function (method: string, params: unknown) {
				const t0 = performance.now();
				try { return origReq(method, params); }
				finally {
					const e = allStats.get(method) ?? { calls: 0, ms: 0 };
					e.calls++; e.ms += performance.now() - t0;
					allStats.set(method, e);
				}
			};
			const origBin = client.apiRequestBinary?.bind(client);
			if (origBin) {
				client.apiRequestBinary = function (method: string, params: unknown) {
					const t0 = performance.now();
					try { return origBin(method, params); }
					finally {
						const e = allStats.get(method + '(bin)') ?? { calls: 0, ms: 0 };
						e.calls++; e.ms += performance.now() - t0;
						allStats.set(method + '(bin)', e);
					}
				};
			}
			(project as any).__tsslintPrintAllRpc = () => {
				const rows = [...allStats.entries()].sort((a, b) => b[1].ms - a[1].ms);
				const total = rows.reduce((n, [, e]) => n + e.calls, 0);
				const totalMs = rows.reduce((n, [, e]) => n + e.ms, 0);
				console.error(`[tsgo-all-rpc] TOTAL: ${total} calls, ${totalMs.toFixed(0)}ms`);
				for (const [m, e] of rows) {
					console.error(`[tsgo-all-rpc]   ${m}: ${e.calls} calls, ${e.ms.toFixed(1)}ms`);
				}
			};
		}
	}

	let prepareTotalMs = 0;
	let prepareCount = 0;

	const disposeProject = () => {
		if (trace) {
			const s = getPrepareTimingSnapshot();
			console.error(
				`[tsgo-time] dispose prepareFiles=${prepareCount} `
				+ `prepareTotal=${prepareTotalMs}ms `
				+ `(getSF=${s.getSF}ms bind=${s.bind}ms prefetch=${s.prefetch}ms)`,
			);
		}
		preparedFiles.clear();
		clearAllCheckerMemoCaches();
		jsSymbolResolver.clear();
		if (jsSymbolResolverRef.current === jsSymbolResolver) {
			jsSymbolResolverRef.current = undefined;
		}
		if (currentProjectRef.project === project) {
			currentProjectRef.project = undefined;
		}
		rpcProfileRef.current?.printSummary(path.basename(project.configFileName));
		(project as any).__tsslintPrintAllRpc?.();
		rpcProfileRef.current?.reset();
		rpcProfileRef.current = undefined;
	};

	return {
		getProgram: () => program,
		prepareFile(fileName: string, prefetchPlan?: PrefetchPlan) {
			if (preparedFiles.has(fileName)) return;
			preparedFiles.add(fileName);
			const t = Date.now();
			prepareFile(project, fileName, jsSymbolResolver, () => {
				prefetchTypesForFile(fileName, prefetchPlan);
			});
			prepareTotalMs += Date.now() - t;
			prepareCount++;
			if (trace && (prepareCount % 100 === 0 || prepareCount === 1)) {
				console.error(`[tsgo-time] prepareFile #${prepareCount} cumul=${prepareTotalMs}ms`);
			}
		},
		// Drop the JS-side bind for a single file. Called by the worker
		// after `--fix` rewrites file content, so the next prepareFile
		// re-binds against the new text and returns fresh symbols.
		invalidateFile(fileName: string) {
			preparedFiles.delete(fileName);
			jsSymbolResolver.invalidate(fileName);
			clearAllCheckerMemoCaches();
		},
		// Drop per-file memo + JS bind after lint. Memo Maps are cleared
		// every time (lint is sequential); JS bind is kept when deferring
		// release on large monorepos to cap re-bind cost.
		releaseFile(fileName: string) {
			clearCheckerMemoCaches();
			preparedFiles.delete(fileName);
			if (deferPerFileRelease) return;
			jsSymbolResolver.invalidate(fileName);
		},
		dispose() {
			disposeProject();
		},
		close() {
			disposeProject();
			closeSharedTsgoApi();
		},
	};
}

// Bridge so wrapChecker.getSymbolAtLocation can reach the active
// backend's resolver without re-threading the wiring through every
// adapter method. Set by createTsgoBackend on construction; cleared on
// close(). Multi-project worker swaps it on each setup.
const jsSymbolResolverRef: { current: import('./tsgo-js-symbols.js').JsSymbolResolver | undefined } = { current: undefined };


// Cumulative timers — printed by createBackend.close() under
// TSSLINT_TIME_TSGO=1. Negligible cost when the flag is off (single
// env-var read per call).
let _prepareGetSF = 0;
let _prepareBind = 0;
let _preparePrefetch = 0;

export function getPrepareTimingSnapshot() {
	return { getSF: _prepareGetSF, bind: _prepareBind, prefetch: _preparePrefetch };
}

// Per-file setup before rules run. Two pieces of essential work:
//
//   1. Prototype patches on the tsgo Node hierarchy — adds the
//      ts.Node-shaped instance methods (`getStart` / `getEnd` /
//      `getText` / `getLineAndCharacterOfPosition` / etc.) that rule
//      code calls directly. One-shot per process; subsequent calls
//      short-circuit inside the patch helpers.
//
//   2. Real-ts bind of the file. Symbol resolution then runs in-process
//      via `wrapChecker.getSymbolAtLocation` — JS-side scope walker
//      first, tsgo IPC fallback only on miss. Replaces the previous
//      tsgo `getSymbolAtPosition` batched RPC prepass which cost ~11s
//      on Dify (5000 files); JS-side bind costs ~1.8s for the same
//      workload and produces real ts.Symbol objects with stable
//      identity.
function prepareFile(
	project: Project,
	fileName: string,
	jsSymbolResolver: import('./tsgo-js-symbols.js').JsSymbolResolver,
	prefetchTypes?: () => void,
): void {
	const trace = process.env.TSSLINT_TIME_TSGO === '1';
	const t0 = trace ? Date.now() : 0;
	const sf = project.program.getSourceFile(fileName);
	if (trace) _prepareGetSF += Date.now() - t0;
	if (!sf) return;

	patchTsgoNodeProto(sf);
	// RemoteNodeList extends Array; without species override, derived
	// methods (`statements.map(...)` etc.) try to construct a fresh
	// RemoteNodeList and crash in its binary-view getter. Override to
	// plain Array.
	const sample = (sf as unknown as { statements?: object }).statements;
	if (sample) patchTsgoNodeListSpecies(sample);

	const text = (sf as unknown as { text: string }).text;
	const tBind = trace ? Date.now() : 0;
	jsSymbolResolver.prepareFile(fileName, text);
	if (trace) _prepareBind += Date.now() - tBind;

	const tPrefetch = trace ? Date.now() : 0;
	prefetchTypes?.();
	if (trace) _preparePrefetch += Date.now() - tPrefetch;
}

// Wraps tsgo Program + Checker as a `ts.Program`-shape. Only the methods
// tsslint actually consumes are populated; the rest throw on access so
// any caller pulling on a missing capability fails loudly instead of
// returning silent garbage.
function wrapProgram(
	project: Project,
	nodeToSymbol: Map<Node, TsgoSymbol | undefined>,
): {
	program: ts.Program;
	prefetchTypesForFile: (fileName: string, plan?: PrefetchPlan) => void;
	clearCheckerMemoCaches: () => void;
	clearAllCheckerMemoCaches: () => void;
} {
	const { checker, prefetchTypesForFile, clearCheckerMemoCaches, clearAllCheckerMemoCaches } = wrapChecker(
		project,
		nodeToSymbol,
	);
	const cwd = path.dirname(project.configFileName);

	// tsgo's lib files live inside the binary's own bundled stdlib. The
	// path check looks at whether the SF path traces to a /lib.*.d.ts
	// inside the tsgo executable's directory, the only place defaultlib
	// SFs originate.
	const isLib = (sf: ts.SourceFile) => {
		const fn = sf.fileName;
		return /\/lib\.[^/]+\.d\.ts$/.test(fn);
	};

	const stub = (name: string) => () => {
		throw new Error(`tsgo backend: ts.Program.${name}() not implemented`);
	};

	const program: Partial<ts.Program> = {
		getSourceFile(fileName: string) {
			return project.program.getSourceFile(fileName) as unknown as ts.SourceFile | undefined;
		},
		getSourceFiles() {
			// tsgo's Program doesn't expose all SFs in one call; pull via
			// rootFiles plus their transitive deps. For the linter's
			// purpose (cache-flow / BuilderProgram drain) this is fine —
			// the hot path is per-file lookup.
			const out: ts.SourceFile[] = [];
			for (const fn of project.rootFiles) {
				const sf = project.program.getSourceFile(fn);
				if (sf) out.push(sf as unknown as ts.SourceFile);
			}
			return out;
		},
		getRootFileNames() {
			return project.rootFiles as readonly string[];
		},
		getCurrentDirectory() {
			return cwd;
		},
		getCompilerOptions() {
			return project.compilerOptions as ts.CompilerOptions;
		},
		getTypeChecker() {
			return checker;
		},
		isSourceFileDefaultLibrary: isLib,
		isSourceFileFromExternalLibrary(sf: ts.SourceFile) {
			return /\/node_modules\//.test(sf.fileName);
		},
		// Methods the linter never calls but ts.Program's interface
		// declares. Stub them so a stray dynamic-typed access blows up
		// with a clear message rather than `undefined is not a function`.
		getSemanticDiagnostics: stub('getSemanticDiagnostics') as any,
		getSyntacticDiagnostics: stub('getSyntacticDiagnostics') as any,
		getDeclarationDiagnostics: stub('getDeclarationDiagnostics') as any,
		getGlobalDiagnostics: stub('getGlobalDiagnostics') as any,
		getConfigFileParsingDiagnostics: stub('getConfigFileParsingDiagnostics') as any,
		emit: stub('emit') as any,
	};

	return {
		program: program as ts.Program,
		prefetchTypesForFile,
		clearCheckerMemoCaches,
		clearAllCheckerMemoCaches,
	};
}

function wrapChecker(
	project: Project,
	nodeToSymbol: Map<Node, TsgoSymbol | undefined>,
): {
	checker: ts.TypeChecker;
	prefetchTypesForFile: (fileName: string, plan?: PrefetchPlan) => void;
	clearCheckerMemoCaches: () => void;
	clearAllCheckerMemoCaches: () => void;
} {
	const { sync, ast } = loadTsgoModules();
	const stub = (name: string) => () => {
		throw new Error(`tsgo backend: ts.TypeChecker.${name}() not implemented`);
	};
	const fixupType = (t: unknown) => {
		if (Array.isArray(t)) {
			for (const item of t) fixupType(item);
			return t;
		}
		if (t && typeof t === 'object') {
			const obj = t as {
				flags?: number;
				aliasTypeArguments?: unknown[];
				getTypes?: () => unknown[];
				getAliasTypeArguments?: () => unknown[];
				__tsslintFixupGetTypes?: boolean;
				__tsslintFixupAliasArgs?: boolean;
			};
			// Drop tsgo's handle cache so rules fall through to
			// `checker.getTypeArguments()` (fixup'd) instead of reading
			// unresolved handles via the own property.
			if ('aliasTypeArguments' in obj) {
				delete obj.aliasTypeArguments;
			}
			if (typeof (obj as { getSymbol?: () => unknown }).getSymbol === 'function'
				&& !(obj as { __tsslintFixupSymbol?: boolean }).__tsslintFixupSymbol) {
				(obj as { __tsslintFixupSymbol?: boolean }).__tsslintFixupSymbol = true;
				try {
					const sym = (obj as { getSymbol: () => unknown }).getSymbol();
					if (sym) (obj as { symbol?: unknown }).symbol = sym;
				}
				catch { /* best-effort */ }
			}
			patchTsgoTypeProto(t, sync);
			patchTsgoTypeCheckerMethods(t, sync, project);
			installTypePredicateShims(obj, sync);
			if (typeof obj.getTypes === 'function' && !obj.__tsslintFixupGetTypes) {
				obj.__tsslintFixupGetTypes = true;
				const origGetTypes = obj.getTypes.bind(obj);
				obj.getTypes = () => {
					const types = origGetTypes();
					if (types) {
						for (const child of types) fixupType(child);
					}
					return types;
				};
			}
			if (typeof obj.getAliasTypeArguments === 'function' && !obj.__tsslintFixupAliasArgs) {
				obj.__tsslintFixupAliasArgs = true;
				const orig = obj.getAliasTypeArguments.bind(obj);
				obj.getAliasTypeArguments = () => {
					const args = orig();
					if (args) {
						for (const child of args) fixupType(child);
					}
					return args;
				};
			}
		}
		return t;
	};
	fixupTypeRef.fn = fixupType;

	const rpc = isTsgoRpcProfileEnabled() ? createRpcProfile() : undefined;
	rpcProfileRef.current = rpc;

	const nodeTypeCache = new Map<Node, ts.Type | null>();
	const typeFromTypeNodeCache = new Map<Node, ts.Type | null>();
	const contextualTypeCache = new Map<Node, ts.Type | null>();
	const symbolAtLocationTypeCache = new Map<object, Map<object, ts.Type | null>>();
	const apparentTypeCache = new Map<object, ts.Type | null>();
	const indexInfosCache = new Map<object, unknown | null>();
	const propertiesOfTypeCache = new Map<object, unknown | null>();
	const signaturesOfTypeCache = new Map<object, Map<number, unknown | null>>();
	const typeOfSymbolCache = new Map<object, ts.Type | null>();
	const typeArgumentsCache = new Map<object, unknown | null>();
	const resolvedSignatureCache = new Map<Node, ts.Signature | null>();
	const returnTypeOfSignatureCache = new Map<object, ts.Type | null>();
	const widenedTypeCache = new Map<object, ts.Type | null>();
	const shorthandValueSymbolCache = new Map<Node, ts.Symbol | null>();

	// Initialise per-session Type/Symbol method memo tables. The prototype
	// patches (patchTsgoTypeProto / patchTsgoSymbolProto) close over these
	// via the module-level `typeMethodMemo` / `symbolMethodMemo` refs.
	typeMethodMemo = new Map();
	symbolMethodMemo = new Map();

	const clearCheckerMemoCaches = () => {
		// Node-keyed — tsgo Node refs are per SourceFile; drop after each lint.
		nodeToSymbol.clear();
		nodeTypeCache.clear();
		typeFromTypeNodeCache.clear();
		contextualTypeCache.clear();
		resolvedSignatureCache.clear();
		shorthandValueSymbolCache.clear();
	};

	const clearAllCheckerMemoCaches = () => {
		clearCheckerMemoCaches();
		// Type/symbol-keyed — tsgo object ids are stable for the snapshot.
		symbolAtLocationTypeCache.clear();
		apparentTypeCache.clear();
		indexInfosCache.clear();
		propertiesOfTypeCache.clear();
		signaturesOfTypeCache.clear();
		typeOfSymbolCache.clear();
		typeArgumentsCache.clear();
		returnTypeOfSignatureCache.clear();
		widenedTypeCache.clear();
		// Type/Symbol object-method memo (getSymbol/getTarget/getTypes/…).
		typeMethodMemo?.clear();
		symbolMethodMemo?.clear();
	};

	const rpcCall = <T>(method: string, fn: () => T): T => {
		if (!rpc) return fn();
		const t0 = performance.now();
		try {
			return fn();
		}
		finally {
			rpc.record(method, performance.now() - t0);
		}
	};

	patchTsgoSymbolProto(sync);
	patchTsgoSignatureProto(sync);

	// Forward to tsgo's Checker, casting Node/Symbol/Type shapes (tsgo's
	// runtime classes are structurally compatible with ts.* for the
	// methods we proxy — tsgo Symbol carries `name`/`flags`/`declarations`,
	// tsgo Type carries `flags` plus the prototype shims from
	// patchTsgoTypeProto). Non-existent methods surface as throw or soft
	// no-op depending on caller tolerance.
	const fwd = <K extends string>(name: K, fixup?: (r: unknown) => void) =>
		(...args: unknown[]) => {
			return rpcCall(name, () => {
				const fn = (project.checker as any)[name];
				if (typeof fn !== 'function') return undefined;
				const r = fn.apply(project.checker, args);
				if (fixup) fixup(r);
				return r;
			});
		};

	// Forward reference so computeGetTypeAtLocation can call memo-wrapped
	// checker methods without raw project.checker RPC bypass.
	const checkerHolder: { checker?: ts.TypeChecker } = {};

	const computeGetTypeAtLocation = (node: ts.Node): ts.Type | undefined => {
		const c = checkerHolder.checker!;
		const tsgoNode = node as unknown as Node;
		const k = tsgoNode.kind;
		const SK = ast.SyntaxKind;
		if (
			(k === SK.AsExpression
				|| k === SK.TypeAssertionExpression
				|| k === SK.SatisfiesExpression)
			&& (tsgoNode as unknown as { type?: Node }).type
		) {
			return c.getTypeFromTypeNode!(
				(tsgoNode as unknown as { type: Node }).type as unknown as ts.TypeNode,
			);
		}
		if (k === SK.CallExpression || k === SK.NewExpression) {
			try {
				const sig = c.getResolvedSignature!(node as any);
				if (sig) {
					return c.getReturnTypeOfSignature!(sig);
				}
			}
			catch { /* fall through to plan B */ }
			const sk = (sync as any).SignatureKind as Record<string, number>;
			try {
				// Raw on the call node — must not recurse through getTypeAtLocation memo.
				const funcType = rpcCall('getTypeAtLocation(raw)', () =>
					project.checker.getTypeAtLocation(tsgoNode));
				if (funcType) {
					fixupType(funcType);
					const sigs = c.getSignaturesOfType!(funcType as unknown as ts.Type, sk.Call);
					if (sigs.length > 0) {
						return c.getReturnTypeOfSignature!(sigs[0]);
					}
				}
			}
			catch { /* try plan C */ }
			try {
				const callee = (tsgoNode as unknown as { expression?: Node }).expression;
				if (callee) {
					const targetForSymbol =
						(callee as unknown as { name?: Node }).name ?? callee;
					const sym = c.getSymbolAtLocation!(targetForSymbol as unknown as ts.Node);
					if (sym) {
						const methodType = c.getTypeOfSymbolAtLocation!(
							sym,
							callee as unknown as ts.Node,
						);
						const sigs = c.getSignaturesOfType!(methodType, sk.Call);
						if (sigs.length > 0) {
							return c.getReturnTypeOfSignature!(sigs[0]);
						}
					}
				}
			}
			catch { /* fall through to default */ }
		}
		if (k === SK.PropertyAccessExpression || k === SK.ElementAccessExpression) {
			if (nodeTypeCache.has(tsgoNode)) {
				const cached = nodeTypeCache.get(tsgoNode)!;
				return cached === null ? undefined : cached;
			}
			const sfPath = ((tsgoNode as unknown as { getSourceFile?: () => { fileName: string } })
				.getSourceFile?.() ?? { fileName: '' }).fileName;
			if (sfPath) {
				const t = rpcCall('getTypeAtPosition', () =>
					project.checker.getTypeAtPosition(sfPath, tsgoNode.end));
				if (t) {
					fixupType(t);
					return t as unknown as ts.Type;
				}
			}
		}
		if (k === SK.NonNullExpression) {
			const inner = (tsgoNode as unknown as { expression: Node }).expression;
			const innerT = c.getTypeAtLocation!(inner as unknown as ts.Node);
			if (innerT) {
				return c.getNonNullableType!(innerT);
			}
		}
		const t = rpcCall('getTypeAtLocation', () =>
			project.checker.getTypeAtLocation(tsgoNode));
		fixupType(t);
		return t as unknown as ts.Type;
	};

	const checker: Partial<ts.TypeChecker> = {
		getSymbolAtLocation(node: ts.Node) {
			const tsgoNode = node as unknown as Node;
			if (nodeToSymbol.has(tsgoNode)) {
				rpc?.memoHit('getSymbolAtLocation');
				return nodeToSymbol.get(tsgoNode) as unknown as ts.Symbol | undefined;
			}
			const tsgoSf = (tsgoNode as unknown as { getSourceFile?: () => { fileName: string; text: string } })
				.getSourceFile?.();
			const resolver = jsSymbolResolverRef.current;
			if (resolver && tsgoSf) {
				const local = resolver.resolveIdentifier(tsgoNode, tsgoSf.fileName, tsgoSf.text);
				if (local) {
					nodeToSymbol.set(tsgoNode, local as unknown as TsgoSymbol);
					return local as unknown as ts.Symbol;
				}
			}
			let sym: TsgoSymbol | undefined;
			if (tsgoSf) {
				sym = rpcCall('getSymbolAtPosition', () =>
					project.checker.getSymbolAtPosition(tsgoSf.fileName, tsgoNode.end));
			}
			if (!sym) {
				sym = rpcCall('getSymbolAtLocation', () =>
					project.checker.getSymbolAtLocation(tsgoNode));
			}
			nodeToSymbol.set(tsgoNode, sym);
			return sym as unknown as ts.Symbol | undefined;
		},
		getTypeAtLocation(node: ts.Node) {
			const tsgoNode = node as unknown as Node;
			return memoGet(
				nodeTypeCache,
				tsgoNode,
				() => computeGetTypeAtLocation(node),
				() => rpc?.memoHit('getTypeAtLocation'),
			) as ts.Type;
		},
		getShorthandAssignmentValueSymbol(node) {
			if (!node) return undefined;
			const n = node as unknown as Node;
			return (memoGet(shorthandValueSymbolCache, n, () =>
				rpcCall('getShorthandAssignmentValueSymbol', () =>
					project.checker.getShorthandAssignmentValueSymbol(n)) as unknown as ts.Symbol | undefined,
			() => rpc?.memoHit('getShorthandAssignmentValueSymbol')) ?? undefined) as ts.Symbol | undefined;
		},
		getTypeOfSymbolAtLocation(symbol, location) {
			const sym = symbol as unknown as object;
			const loc = location as unknown as object;
			return memoGet2(symbolAtLocationTypeCache, sym, loc, () => {
				const t = rpcCall('getTypeOfSymbolAtLocation', () =>
					project.checker.getTypeOfSymbolAtLocation(
						symbol as unknown as TsgoSymbol,
						location as unknown as Node,
					));
				fixupType(t);
				return t as unknown as ts.Type;
			}, () => rpc?.memoHit('getTypeOfSymbolAtLocation')) as ts.Type;
		},
		// Direct forwards — tsgo Checker has these on its surface.
		getTypeOfSymbol(symbol) {
			if (!symbol) return undefined as unknown as ts.Type;
			return memoGet(typeOfSymbolCache, symbol as object, () => {
				const t = rpcCall('getTypeOfSymbol', () =>
					project.checker.getTypeOfSymbol(symbol as unknown as TsgoSymbol));
				fixupType(t);
				return t as unknown as ts.Type;
			}, () => rpc?.memoHit('getTypeOfSymbol')) as ts.Type;
		},
		getDeclaredTypeOfSymbol: fwd('getDeclaredTypeOfSymbol', fixupType) as any,
		getSignaturesOfType(type, kind) {
			if (!type) return [] as ts.Signature[];
			const key = type as object;
			let inner = signaturesOfTypeCache.get(key);
			if (!inner) {
				inner = new Map();
				signaturesOfTypeCache.set(key, inner);
			}
			const cached = inner.get(kind as number);
			if (cached !== undefined) {
				rpc?.memoHit('getSignaturesOfType');
				return (cached ?? []) as ts.Signature[];
			}
			const r = rpcCall('getSignaturesOfType', () =>
				project.checker.getSignaturesOfType(type as any, kind as number));
			inner.set(kind as number, r ?? null);
			return (r ?? []) as unknown as ts.Signature[];
		},
		getResolvedSignature(node) {
			const n = node as unknown as Node;
			return memoGet(resolvedSignatureCache, n, () =>
				rpcCall('getResolvedSignature', () =>
					project.checker.getResolvedSignature(n)) as ts.Signature | undefined,
			() => rpc?.memoHit('getResolvedSignature'));
		},
		getReturnTypeOfSignature(signature) {
			if (!signature) return undefined as unknown as ts.Type;
			return memoGet(returnTypeOfSignatureCache, signature as object, () => {
				const t = rpcCall('getReturnTypeOfSignature', () =>
					project.checker.getReturnTypeOfSignature(signature as any));
				fixupType(t);
				return t as unknown as ts.Type;
			}, () => rpc?.memoHit('getReturnTypeOfSignature')) as ts.Type;
		},
		getTypePredicateOfSignature: fwd('getTypePredicateOfSignature') as any,
		getNonNullableType: fwd('getNonNullableType', fixupType) as any,
		getBaseTypes: fwd('getBaseTypes', fixupType) as any,
		getPropertiesOfType(type) {
			if (!type) return [] as ts.Symbol[];
			return (memoGet(propertiesOfTypeCache, type as object, () =>
				rpcCall('getPropertiesOfType', () =>
					project.checker.getPropertiesOfType(type as any)),
			() => rpc?.memoHit('getPropertiesOfType')) ?? []) as ts.Symbol[];
		},
		getIndexInfosOfType(type) {
			if (!type) return [] as ts.IndexInfo[];
			return (memoGet(indexInfosCache, type as object, () =>
				rpcCall('getIndexInfosOfType', () =>
					project.checker.getIndexInfosOfType(type as any)),
			() => rpc?.memoHit('getIndexInfosOfType')) ?? []) as ts.IndexInfo[];
		},
		getTypeArguments(type) {
			if (!type) return [] as ts.Type[];
			return (memoGet(typeArgumentsCache, type as object, () => {
				const args = rpcCall('getTypeArguments', () =>
					project.checker.getTypeArguments(type as any));
				if (args) fixupType(args);
				return args;
			}, () => rpc?.memoHit('getTypeArguments')) ?? []) as ts.Type[];
		},
		getWidenedType(type) {
			if (!type) return type;
			return memoGet(widenedTypeCache, type as object, () => {
				const t = rpcCall('getWidenedType', () =>
					project.checker.getWidenedType(type as any));
				fixupType(t);
				return t as unknown as ts.Type;
			}, () => rpc?.memoHit('getWidenedType')) as ts.Type;
		},
		getTypeFromTypeNode(typeNode) {
			const n = typeNode as unknown as Node;
			return memoGet(typeFromTypeNodeCache, n, () => {
				const t = fwd('getTypeFromTypeNode', fixupType)(typeNode);
				return t as ts.Type | undefined;
			}, () => rpc?.memoHit('getTypeFromTypeNode')) as ts.Type;
		},
		getContextualType(node) {
			const n = node as unknown as Node;
			return memoGet(contextualTypeCache, n, () => {
				const t = fwd('getContextualType', fixupType)(node);
				return t as ts.Type | undefined;
			}, () => rpc?.memoHit('getContextualType'));
		},
		typeToString: fwd('typeToString') as any,
		isArrayLikeType: fwd('isArrayLikeType') as any,
		// Type-parameter constraint — tsgo only has the type-parameter
		// variant; for non-TypeParameter inputs ts returns undefined too.
		getBaseConstraintOfType: ((type: any) => {
			if ((type?.flags & loadTsgoModules().sync.TypeFlags.TypeParameter) !== 0) {
				const r = rpcCall('getConstraintOfTypeParameter', () =>
					project.checker.getConstraintOfTypeParameter(type));
				fixupType(r);
				return r;
			}
			return undefined;
		}) as any,
		getApparentType: ((type: any) => {
			if (!type) return type;
			return memoGet(apparentTypeCache, type as object, () => {
				const TF = (sync as any).TypeFlags as Record<string, number>;
				if ((type.flags & TF.TypeParameter) !== 0) {
					const c = rpcCall('getConstraintOfTypeParameter', () =>
						project.checker.getConstraintOfTypeParameter(type));
					if (c) { fixupType(c); return c; }
					return type;
				}
				const literalMask = TF.StringLiteral | TF.NumberLiteral
					| TF.BooleanLiteral | TF.BigIntLiteral | TF.EnumLiteral;
				if ((type.flags & literalMask) !== 0) {
					const w = checkerHolder.checker!.getWidenedType!(type);
					if (w) { fixupType(w); return w; }
				}
				fixupType(type);
				return type;
			}, () => rpc?.memoHit('getApparentType'));
		}) as any,
		// tsgo's Checker doesn't expose these. compat-eslint's callsites
		// (parameter-property shadowing, ExportSpecifier alias unwrap)
		// have fallback paths that handle empty / undefined gracefully —
		// degrades scope-manager precision in those edge cases but keeps
		// the rest of the pipeline functional.
		getSymbolsInScope: ((..._args: unknown[]) => []) as any,
		getExportSpecifierLocalTargetSymbol: ((..._args: unknown[]) => undefined) as any,
		// `isTypeAssignableTo` — tsgo doesn't expose subtype checking.
		// Best-effort structural cover: identity, any/unknown/never
		// sentinels, union decomposition (∀ on source / ∃ on target),
		// literal-to-base widening. Returns `false` for the long tail
		// of structural compatibility (object shape compat, signature
		// variance, conditional types) that requires the full checker
		// subtype machinery — sound (no false `true`) over those
		// branches; consumers should treat unknown answers as "can't
		// prove" rather than "definitely false".
		isTypeAssignableTo: ((source: any, target: any): boolean => {
			if (!source || !target) return false;
			if (source === target || source.id === target.id) return true;
			const TF = (sync as any).TypeFlags as Record<string, number>;
			if ((target.flags & (TF.Any | TF.Unknown)) !== 0) return true;
			if ((source.flags & TF.Never) !== 0) return true;
			if ((source.flags & TF.Any) !== 0) return true;
			const self = (s: any, t: any): boolean => (checker.isTypeAssignableTo as any)(s, t);
			if ((source.flags & TF.Union) !== 0) {
				const ts_ = source.getTypes?.() as any[] | undefined;
				if (ts_) return ts_.every(s => self(s, target));
			}
			if ((target.flags & TF.Union) !== 0) {
				const tt = target.getTypes?.() as any[] | undefined;
				if (tt) return tt.some(t => self(source, t));
			}
			const literalMask = TF.StringLiteral | TF.NumberLiteral
				| TF.BooleanLiteral | TF.BigIntLiteral;
			if ((source.flags & literalMask) !== 0) {
				const widened = checkerHolder.checker!.getWidenedType!(source);
				if (widened && (widened as { id?: string }).id !== (source as { id?: string }).id) {
					return self(widened, target);
				}
			}
			return false;
		}) as any,
	};
	checkerHolder.checker = checker as ts.TypeChecker;
	// `stub` is held for future use as gaps surface; reference it here
	// to satisfy noUnusedLocals without a separate unused-method line.
	void stub;

	const prefetchTypesForFile = (fileName: string, plan: PrefetchPlan = EMPTY_PREFETCH_PLAN) => {
		const sf = project.program.getSourceFile(fileName);
		if (!sf) return;
		const text = (sf as unknown as { text: string }).text;
		batchPrefetchTypes(project, sf as unknown as Node, fileName, {
			astSyntaxKind: ast.SyntaxKind as unknown as Record<string, number>,
			fixupType,
			rpcCall,
			rpc,
			jsSymbolResolver: jsSymbolResolverRef.current,
			fileText: text,
			caches: {
				nodeTypeCache,
				typeFromTypeNodeCache,
				indexInfosCache,
				propertiesOfTypeCache,
				contextualTypeCache,
				nodeToSymbol,
				typeOfSymbolCache,
			},
		}, plan);
	};

	wrappedCheckerRef.checker = checker as ts.TypeChecker;

	return {
		checker: checker as ts.TypeChecker,
		prefetchTypesForFile,
		clearCheckerMemoCaches,
		clearAllCheckerMemoCaches,
	};
}
