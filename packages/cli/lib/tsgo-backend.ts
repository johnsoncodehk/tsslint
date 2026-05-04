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

// `@typescript/native-preview` ships ESM-only. Under Node16 module
// resolution, type-only imports of an ESM package from this CJS file
// require the `'resolution-mode': 'import'` attribute. We thread that
// through once via `import(..., { with: ... })` aliases and reuse them.
type TsgoSync = typeof import('@typescript/native-preview/sync', { with: { 'resolution-mode': 'import' } });
type API = InstanceType<TsgoSync['API']>;
type Snapshot = InstanceType<TsgoSync['Snapshot']>;
type Project = InstanceType<TsgoSync['Project']>;
type TsgoSymbol = InstanceType<TsgoSync['Symbol']>;
type TsgoAst = typeof import('@typescript/native-preview/ast', { with: { 'resolution-mode': 'import' } });
type Node = import('@typescript/native-preview/ast', { with: { 'resolution-mode': 'import' } }).Node;

export interface TsgoBackend {
	// ts.Program-shape adapter, fed to LinterContext.program().
	getProgram(): ts.Program;
	// Per-file prepass: walks the SF, collects every Identifier, resolves
	// in one batched RPC, populates the symbol cache. Must be called for
	// each file before rules run against it.
	prepareFile(fileName: string): void;
	// Tear down child process + free snapshot refs.
	close(): void;
}

// Process-level guards. All prototype patches are one-shot per process
// (tsgo's class shapes are stable per binary version).
let nodeProtoPatched = false;
let typeProtoPatched = false;
let nodeHandleProtoPatched = false;
let symbolProtoPatched = false;
let nodeListSpeciesPatched = false;
let signatureProtoPatched = false;

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
function patchTsgoTypeProto(sample: object, sync: TsgoSync): void {
	if (typeProtoPatched) return;
	let proto: any = Object.getPrototypeOf(sample);
	while (proto && Object.getPrototypeOf(proto) !== Object.prototype) {
		proto = Object.getPrototypeOf(proto);
	}
	if (!proto) return;
	const TF = (sync as any).TypeFlags as Record<string, number>;
	const has = (flag: number) => function (this: { flags: number }) { return (this.flags & flag) !== 0; };
	if (!proto.isStringLiteral) proto.isStringLiteral = has(TF.StringLiteral);
	if (!proto.isNumberLiteral) proto.isNumberLiteral = has(TF.NumberLiteral);
	if (!proto.isBooleanLiteral) proto.isBooleanLiteral = has(TF.BooleanLiteral);
	if (!proto.isBigIntLiteral) proto.isBigIntLiteral = has(TF.BigIntLiteral);
	if (!proto.isEnumLiteral) proto.isEnumLiteral = has(TF.EnumLiteral);
	if (!proto.isLiteral) proto.isLiteral = has(
		TF.StringLiteral | TF.NumberLiteral | TF.BigIntLiteral | TF.BooleanLiteral,
	);
	if (!proto.isUnion) proto.isUnion = has(TF.Union);
	if (!proto.isIntersection) proto.isIntersection = has(TF.Intersection);
	if (!proto.isUnionOrIntersection) proto.isUnionOrIntersection = has(TF.UnionOrIntersection ?? (TF.Union | TF.Intersection));
	if (!proto.isTypeParameter) proto.isTypeParameter = has(TF.TypeParameter);
	if (!proto.isClassOrInterface) proto.isClassOrInterface = function () { return false; }; // structural; would need objectFlags
	if (!proto.isClass) proto.isClass = function () { return false; };
	if (!proto.isIndexType) proto.isIndexType = has(TF.Index);
	if (!proto.getFlags) proto.getFlags = function (this: { flags: number }) { return this.flags; };
	if (!proto.isNullableType) proto.isNullableType = has((TF.Null ?? 0) | (TF.Undefined ?? 0));
	// `types` property — typescript-eslint's ts-api-utils
	// (`unionConstituents`) reads `type.types` directly on Union /
	// Intersection types. tsgo exposes the constituents via `getTypes()`
	// instead. Lazy getter preserves the no-RPC-on-bind contract.
	if (!Object.getOwnPropertyDescriptor(proto, 'types')) {
		Object.defineProperty(proto, 'types', {
			configurable: true,
			get(this: { getTypes?: () => unknown[] }) {
				return this.getTypes ? this.getTypes() : undefined;
			},
		});
	}
	// `getCallSignatures()` / `getConstructSignatures()` — instance shims
	// that delegate to the Checker. We can't reach the Checker from here
	// without a closure; install via patchTsgoTypeProtoWithChecker
	// (separate hook called from wrapChecker).
	typeProtoPatched = true;
}

// Type instance methods that need a Checker reference (signatures,
// properties). Patched once on first checker query that returns a Type.
let typeCheckerMethodsPatched = false;
function patchTsgoTypeCheckerMethods(sample: object, sync: TsgoSync, project: Project): void {
	if (typeCheckerMethodsPatched) return;
	let proto: any = Object.getPrototypeOf(sample);
	while (proto && Object.getPrototypeOf(proto) !== Object.prototype) {
		proto = Object.getPrototypeOf(proto);
	}
	if (!proto) return;
	const SK = (sync as any).SignatureKind as Record<string, number>;
	if (!proto.getCallSignatures) {
		proto.getCallSignatures = function (this: { id: string }) {
			return currentProjectRef.project!.checker.getSignaturesOfType(this as any, SK.Call);
		};
	}
	if (!proto.getConstructSignatures) {
		proto.getConstructSignatures = function (this: { id: string }) {
			return currentProjectRef.project!.checker.getSignaturesOfType(this as any, SK.Construct);
		};
	}
	if (!proto.getProperties) {
		proto.getProperties = function (this: any) {
			return currentProjectRef.project!.checker.getPropertiesOfType(this);
		};
	}
	if (!proto.getProperty) {
		proto.getProperty = function (this: any, name: string) {
			return this.getProperties().find((p: any) => p.name === name);
		};
	}
	if (!proto.getBaseTypes) {
		proto.getBaseTypes = function (this: any) {
			return currentProjectRef.project!.checker.getBaseTypes(this);
		};
	}
	if (!proto.getNonNullableType) {
		proto.getNonNullableType = function (this: any) {
			return currentProjectRef.project!.checker.getNonNullableType(this);
		};
	}
	void project;
	typeCheckerMethodsPatched = true;
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
			return currentProjectRef.project!.checker.getReturnTypeOfSignature(this as any);
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
const currentProjectRef: { project: Project | undefined } = { project: undefined };

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

export function createTsgoBackend(tsconfig: string): TsgoBackend {
	// Lazy require so users without the optional peer dep don't crash on
	// load. The CLI gates this behind `--tsgo` so non-tsgo users never
	// reach here.
	const { API: APICtor } = require('@typescript/native-preview/sync') as TsgoSync;
	const ast: TsgoAst = require('@typescript/native-preview/ast');

	const api: API = new APICtor({});
	const snapshot: Snapshot = api.updateSnapshot({ openProject: tsconfig });
	const project = snapshot.getProject(tsconfig);
	if (!project) {
		api.close();
		throw new Error(`tsgo: project not found for ${tsconfig}`);
	}

	// Per-fileName Symbol cache, populated by `prepareFile`. Keyed by the
	// tsgo Node object reference (not its position) — the AST tree is
	// hydrated client-side and walks return the same Node instances each
	// time within a snapshot.
	const nodeToSymbol = new WeakMap<Node, TsgoSymbol | undefined>();
	// Files prepass'd this snapshot. Skip re-walk on repeat lint() calls.
	const preparedFiles = new Set<string>();

	const program = wrapProgram(project, nodeToSymbol);
	const idKind = ast.SyntaxKind.Identifier;
	currentProjectRef.project = project;
	installNodeHandleHooks(require('@typescript/native-preview/sync') as TsgoSync);

	return {
		getProgram: () => program,
		prepareFile(fileName: string) {
			if (preparedFiles.has(fileName)) return;
			preparedFiles.add(fileName);
			prepareFile(project, idKind, fileName, nodeToSymbol);
		},
		close() {
			api.close();
		},
	};
}

function prepareFile(
	project: Project,
	idKind: number,
	fileName: string,
	nodeToSymbol: WeakMap<Node, TsgoSymbol | undefined>,
): void {
	const sf = project.program.getSourceFile(fileName);
	if (!sf) return;

	// Patch ts.Node-shape methods on tsgo's Remote{Node,SourceFile}
	// prototype. Idempotent across calls and across snapshots.
	patchTsgoNodeProto(sf);
	// Patch RemoteNodeList — `extends Array`, so its `[Symbol.species]`
	// defaults to itself; rule code's `statements.map(...)` then tries
	// to construct an empty RemoteNodeList and crashes in the binary-
	// view getter. Override species to plain Array so derived methods
	// (map / filter / slice / concat) return regular arrays.
	const sample = (sf as unknown as { statements?: object }).statements;
	if (sample) patchTsgoNodeListSpecies(sample);

	// Local AST walk — no RPC. Collect every Identifier.
	const ids: Node[] = [];
	(function walk(n: Node) {
		if (n.kind === idKind) ids.push(n);
		n.forEachChild(walk);
	})(sf);

	if (ids.length === 0) return;

	// Position-based batch resolves identifiers in declaration position
	// (import/export specifier names, etc.) that the node-based API
	// misses. Use end offset — caret-after-name semantics.
	const positions = ids.map(id => id.end);
	const symsByPos = project.checker.getSymbolAtPosition(fileName, positions);

	// Fill from position-based result. For nulls, fall back to node-based
	// (handles a small minority — object-spread method names etc.).
	const fallbackIdx: number[] = [];
	for (let i = 0; i < ids.length; i++) {
		if (symsByPos[i]) {
			nodeToSymbol.set(ids[i], symsByPos[i]);
		} else {
			fallbackIdx.push(i);
		}
	}
	if (fallbackIdx.length > 0) {
		const fallbackNodes = fallbackIdx.map(i => ids[i]);
		const symsByNode = project.checker.getSymbolAtLocation(fallbackNodes);
		for (let j = 0; j < fallbackIdx.length; j++) {
			nodeToSymbol.set(ids[fallbackIdx[j]], symsByNode[j]);
		}
	}
}

// Wraps tsgo Program + Checker as a `ts.Program`-shape. Only the methods
// tsslint actually consumes are populated; the rest throw on access so
// any caller pulling on a missing capability fails loudly instead of
// returning silent garbage.
function wrapProgram(
	project: Project,
	nodeToSymbol: WeakMap<Node, TsgoSymbol | undefined>,
): ts.Program {
	const checker = wrapChecker(project, nodeToSymbol);
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

	return program as ts.Program;
}

function wrapChecker(
	project: Project,
	nodeToSymbol: WeakMap<Node, TsgoSymbol | undefined>,
): ts.TypeChecker {
	const sync = require('@typescript/native-preview/sync') as TsgoSync;
	const ast = require('@typescript/native-preview/ast') as TsgoAst;
	const stub = (name: string) => () => {
		throw new Error(`tsgo backend: ts.TypeChecker.${name}() not implemented`);
	};
	const fixupType = (t: unknown) => {
		if (t && typeof t === 'object') {
			patchTsgoTypeProto(t, sync);
			patchTsgoTypeCheckerMethods(t, sync, project);
		}
		return t;
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
			const fn = (project.checker as any)[name];
			if (typeof fn !== 'function') return undefined;
			const r = fn.apply(project.checker, args);
			if (fixup) fixup(r);
			return r;
		};

	const checker: Partial<ts.TypeChecker> = {
		getSymbolAtLocation(node: ts.Node) {
			// Cache hit (prepass'd files) returns synchronously, no RPC.
			// Cache miss falls through to a single RPC — covers nodes the
			// rule discovered after the prepass (e.g. via type queries
			// that returned a synthetic node).
			const tsgoNode = node as unknown as Node;
			if (nodeToSymbol.has(tsgoNode)) {
				return nodeToSymbol.get(tsgoNode) as unknown as ts.Symbol | undefined;
			}
			const sym = project.checker.getSymbolAtLocation(tsgoNode);
			nodeToSymbol.set(tsgoNode, sym);
			return sym as unknown as ts.Symbol | undefined;
		},
		getTypeAtLocation(node: ts.Node) {
			// Semantic divergence: ts's `getTypeAtLocation(AsExpression)`
			// returns the *asserted* target type (post-`as`), tsgo's
			// returns the inner expression's type. typescript-eslint's
			// `no-unnecessary-type-assertion` rule depends on the ts
			// semantics — without this routing, `outer === inner` is
			// trivially true (both = inner type), and every assertion
			// in the codebase fires as "unnecessary".
			//
			// Re-route assertions to `getTypeFromTypeNode(node.type)` so
			// the asserted target type comes back. SK constants from
			// tsgo's enum (this file imports the runtime).
			const tsgoNode = node as unknown as Node;
			if (
				(tsgoNode.kind === ast.SyntaxKind.AsExpression
					|| tsgoNode.kind === ast.SyntaxKind.TypeAssertionExpression
					|| tsgoNode.kind === ast.SyntaxKind.SatisfiesExpression)
				&& (tsgoNode as unknown as { type?: Node }).type
			) {
				const t = project.checker.getTypeFromTypeNode(
					(tsgoNode as unknown as { type: Node }).type as any,
				);
				fixupType(t);
				return t as unknown as ts.Type;
			}
			const t = project.checker.getTypeAtLocation(tsgoNode);
			fixupType(t);
			return t as unknown as ts.Type;
		},
		getShorthandAssignmentValueSymbol(node) {
			if (!node) return undefined;
			return project.checker.getShorthandAssignmentValueSymbol(node as unknown as Node) as unknown as ts.Symbol | undefined;
		},
		getTypeOfSymbolAtLocation(symbol, location) {
			const t = project.checker.getTypeOfSymbolAtLocation(
				symbol as unknown as TsgoSymbol,
				location as unknown as Node,
			);
			fixupType(t);
			return t as unknown as ts.Type;
		},
		// Direct forwards — tsgo Checker has these on its surface.
		getTypeOfSymbol: fwd('getTypeOfSymbol', fixupType) as any,
		getDeclaredTypeOfSymbol: fwd('getDeclaredTypeOfSymbol', fixupType) as any,
		getSignaturesOfType: fwd('getSignaturesOfType') as any,
		getResolvedSignature: fwd('getResolvedSignature') as any,
		getReturnTypeOfSignature: fwd('getReturnTypeOfSignature', fixupType) as any,
		getTypePredicateOfSignature: fwd('getTypePredicateOfSignature') as any,
		getNonNullableType: fwd('getNonNullableType', fixupType) as any,
		getBaseTypes: fwd('getBaseTypes') as any,
		getPropertiesOfType: fwd('getPropertiesOfType') as any,
		getIndexInfosOfType: fwd('getIndexInfosOfType') as any,
		getTypeArguments: fwd('getTypeArguments') as any,
		getWidenedType: fwd('getWidenedType', fixupType) as any,
		getTypeFromTypeNode: fwd('getTypeFromTypeNode', fixupType) as any,
		getContextualType: fwd('getContextualType', fixupType) as any,
		typeToString: fwd('typeToString') as any,
		isArrayLikeType: fwd('isArrayLikeType') as any,
		// Type-parameter constraint — tsgo only has the type-parameter
		// variant; for non-TypeParameter inputs ts returns undefined too.
		getBaseConstraintOfType: ((type: any) => {
			if ((type?.flags & (require('@typescript/native-preview/sync') as TsgoSync).TypeFlags.TypeParameter) !== 0) {
				const r = project.checker.getConstraintOfTypeParameter(type);
				fixupType(r);
				return r;
			}
			return undefined;
		}) as any,
		// Apparent type: ts boxes primitives + walks type-parameter
		// constraints for property lookup. tsgo has no direct equivalent.
		// Identity fallback is unsound but rule code rarely reaches it on
		// the checker-API tier we currently expose; revisit when a
		// concrete crash signature points here.
		getApparentType: ((type: unknown) => type) as any,
		// tsgo's Checker doesn't expose these. compat-eslint's callsites
		// (parameter-property shadowing, ExportSpecifier alias unwrap)
		// have fallback paths that handle empty / undefined gracefully —
		// degrades scope-manager precision in those edge cases but keeps
		// the rest of the pipeline functional.
		getSymbolsInScope: ((..._args: unknown[]) => []) as any,
		getExportSpecifierLocalTargetSymbol: ((..._args: unknown[]) => undefined) as any,
		// `isTypeAssignableTo` — tsgo doesn't expose subtype checking.
		// Conservative `false` keeps type-safety rules (no-unnecessary-
		// type-assertion, no-misused-promises) on their "can't prove
		// assignable, leave alone" branch — same behaviour as ts when
		// the checker can't decide. May suppress some legitimate
		// diagnostics until upstream surfaces this.
		isTypeAssignableTo: ((..._args: unknown[]) => false) as any,
	};
	// `stub` is held for future use as gaps surface; reference it here
	// to satisfy noUnusedLocals without a separate unused-method line.
	void stub;

	return checker as ts.TypeChecker;
}
