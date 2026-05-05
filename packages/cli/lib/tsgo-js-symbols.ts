// JS-side Symbol provider for the tsgo backend.
//
// Architecture: tsgo provides AST + Type (cross-file aware via RPC). Symbol
// resolution at the binder level — variable references, declaration names,
// import bindings, in-file type references — runs entirely in-process via
// real ts.createSourceFile + ts.bindSourceFile + a scope walker.
//
// Why: the previous tsgo-Symbol prepass cost 11s on Dify web/ (5000 files)
// for batched cross-process `getSymbolAtPosition` calls. Real ts in-process
// answers the same questions in ~360ms. Symbol is binder-level — type
// computation isn't required, so the JS-side checker is bypassed entirely
// (we use bind only, no createTypeChecker).
//
// PoC measurement showed:
//   - parse + bind: ~0.36ms/file
//   - lint-relevant query recall: 87% (vs whole-program ts.Program 94%)
//   - the missing 7% are globals (Array, Promise — rules check by text
//     anyway) and type-driven property access (falls back to tsgo for
//     full precision)

// Use captured-at-startup real ts. Plain `require('typescript')` here
// would route through the tsgo facade installed by the worker — that
// shape doesn't behave correctly for parse/bind work.
import ts = require('./real-ts.js');

// Bind option set: minimal — we only want symbol/locals on the AST.
const BIND_OPTIONS: ts.CompilerOptions = {
	target: ts.ScriptTarget.ES2022,
	module: ts.ModuleKind.ESNext,
	jsx: ts.JsxEmit.Preserve,
	allowJs: true,
};

// Per-file bound JS SourceFile cache. Keyed by fileName.
const jsSourceFiles = new Map<string, ts.SourceFile>();

// Per-file position → JS Node lookup. Built lazily on first symbol query
// for a file, walks the JS AST once to index nodes by `pos:end:kind`.
// Hash key matches tsgo Node's identity (same source positions, same
// kind via the kind-name remap below).
type PosKey = string;
const positionMaps = new Map<string, Map<PosKey, ts.Node>>();

// tsgo SyntaxKind → ts SyntaxKind name → ts SyntaxKind value remap.
// tsgo's enum values are offset-shifted from ts's, but the names are
// almost-identical (~98% overlap). Build the map lazily on first use.
let kindRemap: Map<number, number> | undefined;

function buildKindRemap(tsgoSyntaxKind: Record<string, string | number>): Map<number, number> {
	const m = new Map<number, number>();
	for (const k of Object.keys(tsgoSyntaxKind)) {
		const v = tsgoSyntaxKind[k];
		if (typeof v !== 'number') continue;
		const tsValue = (ts.SyntaxKind as unknown as Record<string, number>)[k];
		if (typeof tsValue === 'number') m.set(v, tsValue);
	}
	return m;
}

function tsgoKindToTs(tsgoKind: number, tsgoSyntaxKind: Record<string, string | number>): number {
	if (!kindRemap) kindRemap = buildKindRemap(tsgoSyntaxKind);
	return kindRemap.get(tsgoKind) ?? tsgoKind;
}

function key(pos: number, end: number, kind: number): PosKey {
	return pos + ':' + end + ':' + kind;
}

function getJsSourceFile(fileName: string, text: string): ts.SourceFile {
	let sf = jsSourceFiles.get(fileName);
	if (sf) return sf;
	sf = ts.createSourceFile(fileName, text, BIND_OPTIONS.target!, /*setParentNodes*/ true);
	(ts as any).bindSourceFile(sf, BIND_OPTIONS);
	jsSourceFiles.set(fileName, sf);
	return sf;
}

function getPositionMap(sf: ts.SourceFile): Map<PosKey, ts.Node> {
	let map = positionMaps.get(sf.fileName);
	if (map) return map;
	map = new Map();
	(function walk(n: ts.Node) {
		map!.set(key(n.pos, n.end, n.kind), n);
		ts.forEachChild(n, walk);
	})(sf);
	positionMaps.set(sf.fileName, map);
	return map;
}

// Scope walk: nearest enclosing scope's locals.has(name).
function resolveByScope(jsNode: ts.Identifier): ts.Symbol | undefined {
	const name = jsNode.text;
	for (let n: ts.Node | undefined = jsNode; n; n = n.parent) {
		const locals = (n as unknown as { locals?: ts.SymbolTable }).locals;
		if (locals?.has(name as ts.__String)) {
			return locals.get(name as ts.__String);
		}
	}
	return undefined;
}

export interface JsSymbolResolverOptions {
	tsgoSyntaxKind: Record<string, string | number>;
}

export function createJsSymbolResolver(opts: JsSymbolResolverOptions) {
	return {
		// Parse + bind a file. Idempotent.
		prepareFile(fileName: string, text: string): void {
			getJsSourceFile(fileName, text);
		},
		// Resolve an Identifier node's symbol via the JS-side bound AST.
		// `tsgoNode` is from tsgo's AST; we map by (pos, end, kind) to the
		// corresponding JS node, then run the standard binder lookups.
		// Returns ts.Symbol (real one from JS bind) or undefined if no
		// in-file binding (caller decides whether to fall back).
		resolveIdentifier(
			tsgoNode: { kind: number; pos: number; end: number; getSourceFile?: () => { fileName: string; text: string } },
			fileName: string,
			text: string,
		): ts.Symbol | undefined {
			const sf = getJsSourceFile(fileName, text);
			const map = getPositionMap(sf);
			const tsKind = tsgoKindToTs(tsgoNode.kind, opts.tsgoSyntaxKind);
			const jsNode = map.get(key(tsgoNode.pos, tsgoNode.end, tsKind));
			if (!jsNode) return undefined;
			// Declaration name: parent has the symbol directly.
			const parent = jsNode.parent;
			if (parent && (parent as any).name === jsNode && (parent as any).symbol) {
				return (parent as any).symbol;
			}
			// Specifier (import/export): parent has the symbol.
			if (parent && (parent.kind === ts.SyntaxKind.ImportSpecifier
				|| parent.kind === ts.SyntaxKind.ExportSpecifier)) {
				return (parent as any).symbol;
			}
			// Otherwise: scope walk for value/type references.
			if (jsNode.kind === ts.SyntaxKind.Identifier) {
				return resolveByScope(jsNode as ts.Identifier);
			}
			return undefined;
		},
		clear(): void {
			jsSourceFiles.clear();
			positionMaps.clear();
		},
	};
}
