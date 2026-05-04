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

// Process-level guard so we patch the tsgo Node prototype exactly once,
// even if multiple backends spin up in the same worker.
let nodeProtoPatched = false;

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
	nodeProtoPatched = true;
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
	const stub = (name: string) => () => {
		throw new Error(`tsgo backend: ts.TypeChecker.${name}() not implemented`);
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
			return project.checker.getTypeAtLocation(node as unknown as Node) as unknown as ts.Type;
		},
		getShorthandAssignmentValueSymbol(node: ts.Node | undefined) {
			if (!node) return undefined;
			return project.checker.getShorthandAssignmentValueSymbol(node as unknown as Node) as unknown as ts.Symbol | undefined;
		},
		getTypeOfSymbolAtLocation(symbol: ts.Symbol, location: ts.Node) {
			return project.checker.getTypeOfSymbolAtLocation(
				symbol as unknown as TsgoSymbol,
				location as unknown as Node,
			) as unknown as ts.Type;
		},
		// tsgo Checker doesn't expose getSymbolsInScope or
		// getExportSpecifierLocalTargetSymbol. Stubbed for now —
		// compat-eslint's two callsites need workarounds (the
		// `arguments` symbol lookup and ExportSpecifier alias unwrap).
		getSymbolsInScope: stub('getSymbolsInScope') as any,
		getExportSpecifierLocalTargetSymbol: stub('getExportSpecifierLocalTargetSymbol') as any,
	};

	return checker as ts.TypeChecker;
}
