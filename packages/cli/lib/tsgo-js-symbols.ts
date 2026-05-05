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

type PosKey = string;

function key(pos: number, end: number, kind: number): PosKey {
	return pos + ':' + end + ':' + kind;
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

export type JsSymbolResolver = ReturnType<typeof createJsSymbolResolver>;

export function createJsSymbolResolver(opts: JsSymbolResolverOptions) {
	// All caches live in this closure. Each backend gets its own resolver
	// instance; backend.close() invokes resolver.clear() to release memory.
	const jsSourceFiles = new Map<string, ts.SourceFile>();

	// Per-file position → JS Node lookup. Built lazily on first symbol
	// query for a file. Walks the JS AST once and indexes nodes by
	// `pos:end:tsKind`. Two index entries per node are populated when both
	// kinds map (the node's tsgo-equivalent kind and an unkeyed (pos,end,0)
	// fallback for unmapped tsgo kinds — see lookup logic below).
	const positionMaps = new Map<string, Map<PosKey, ts.Node>>();
	// Position-only fallback (pos:end → first node at that span). Used when
	// the tsgo SyntaxKind name has no ts equivalent (e.g. tsgo-only
	// `JSImportDeclaration`); we still return SOMETHING reasonable so the
	// scope walker can attempt resolution.
	const positionMapsFallback = new Map<string, Map<string, ts.Node>>();

	// tsgo SyntaxKind value → ts SyntaxKind value, by name correspondence.
	// 98% overlap; gaps fall through to the position-only fallback.
	let kindRemap: Map<number, number> | undefined;
	function getKindRemap(): Map<number, number> {
		if (kindRemap) return kindRemap;
		const m = new Map<number, number>();
		for (const k of Object.keys(opts.tsgoSyntaxKind)) {
			const v = opts.tsgoSyntaxKind[k];
			if (typeof v !== 'number') continue;
			const tsValue = (ts.SyntaxKind as unknown as Record<string, number>)[k];
			if (typeof tsValue === 'number') m.set(v, tsValue);
		}
		kindRemap = m;
		return m;
	}

	function bindFile(fileName: string, text: string): ts.SourceFile {
		const sf = ts.createSourceFile(fileName, text, BIND_OPTIONS.target!, /*setParentNodes*/ true);
		(ts as any).bindSourceFile(sf, BIND_OPTIONS);
		return sf;
	}

	function getJsSourceFile(fileName: string, text: string): ts.SourceFile {
		const cached = jsSourceFiles.get(fileName);
		// Text-equality check: detects --fix rewrites (worker stashes new
		// text in `fileTextOverrides`, next prepareFile passes the new
		// text through to us). Stale binding would resolve to the wrong
		// scope / declarations.
		if (cached && cached.text === text) return cached;
		if (cached) {
			// Text changed; drop position maps too — node positions may
			// have shifted.
			positionMaps.delete(fileName);
			positionMapsFallback.delete(fileName);
		}
		const sf = bindFile(fileName, text);
		jsSourceFiles.set(fileName, sf);
		return sf;
	}

	function getPositionMap(sf: ts.SourceFile): Map<PosKey, ts.Node> {
		let map = positionMaps.get(sf.fileName);
		if (map) return map;
		map = new Map();
		const fb = new Map<string, ts.Node>();
		(function walk(n: ts.Node) {
			map!.set(key(n.pos, n.end, n.kind), n);
			// Position-only fallback: keep the first node we see at this
			// span. Multiple nodes can share `pos:end` (e.g. an Identifier
			// and its parent ExpressionStatement); first-write-wins is
			// arbitrary but stable.
			const k = n.pos + ':' + n.end;
			if (!fb.has(k)) fb.set(k, n);
			ts.forEachChild(n, walk);
		})(sf);
		positionMaps.set(sf.fileName, map);
		positionMapsFallback.set(sf.fileName, fb);
		return map;
	}

	return {
		// Parse + bind a file (idempotent on unchanged text). On text
		// change (e.g. --fix rewrite), drops the cached SF + position
		// maps and re-binds.
		prepareFile(fileName: string, text: string): void {
			getJsSourceFile(fileName, text);
		},
		// Resolve an Identifier node's symbol via the JS-side bound AST.
		// `tsgoNode` is from tsgo's AST; we map by (pos, end, kind) to the
		// corresponding JS node, then run the standard binder lookups.
		// Returns ts.Symbol (real one from JS bind) or undefined if no
		// in-file binding (caller decides whether to fall back).
		resolveIdentifier(
			tsgoNode: { kind: number; pos: number; end: number },
			fileName: string,
			text: string,
		): ts.Symbol | undefined {
			const sf = getJsSourceFile(fileName, text);
			const map = getPositionMap(sf);
			const remap = getKindRemap();
			const tsKind = remap.get(tsgoNode.kind);
			let jsNode = tsKind !== undefined
				? map.get(key(tsgoNode.pos, tsgoNode.end, tsKind))
				: undefined;
			// Position-only fallback when kind name didn't map (rare;
			// covers tsgo-only kinds like JSImportDeclaration).
			if (!jsNode) {
				jsNode = positionMapsFallback.get(sf.fileName)!.get(tsgoNode.pos + ':' + tsgoNode.end);
			}
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
		// Drop a single file's bind + maps. Used by the worker after
		// --fix writes new content, so the next prepareFile re-binds
		// against fresh text. Idempotent.
		invalidate(fileName: string): void {
			jsSourceFiles.delete(fileName);
			positionMaps.delete(fileName);
			positionMapsFallback.delete(fileName);
		},
		// Drop everything. Called by backend.close() to release per-CLI
		// invocation memory and avoid retaining ~MBs of bound ASTs across
		// project setups in a long-running worker.
		clear(): void {
			jsSourceFiles.clear();
			positionMaps.clear();
			positionMapsFallback.clear();
			kindRemap = undefined;
		},
	};
}
