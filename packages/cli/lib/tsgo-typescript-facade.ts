// `typescript` module facade for the --tsgo path. Substituted into
// `Module._cache[require.resolve('typescript')]` before tsslint config
// loads, so all rule code (compat-eslint, ESLint utility ports, custom
// rules) sees tsgo's enums, type guards, and walkers when it does
// `require('typescript')` / `import * as ts from 'typescript'`.
//
// This is selective: the worker / cache-flow / core consumed `ts.X` at
// module load time, before `--tsgo` substitution kicks in, so they keep
// the real ts for things tsgo doesn't expose (skipTrivia,
// createSemanticDiagnosticsBuilderProgram, parseJsonConfigFileContent,
// etc.). Only later-loaded code (the dynamic `import(configFile)` inside
// setup() and everything it transitively pulls in) gets this facade.
//
// Why facade vs in-place mutation: `ts.SyntaxKind.Identifier` etc. need
// tsgo's offset values for rule-side comparisons to hit, but the
// worker's already-bound `ts.skipTrivia` etc. need the real ts.SyntaxKind
// internally. A separate module object satisfies both.

import ts = require('typescript');

interface TsgoModules {
	ast: any; // /ast — SyntaxKind, NodeFlags, all is.* guards, visitor, utils, scanner
	factory: any; // /ast/factory — node creation helpers + NodeObject
	sync: any; // /api/sync — SymbolFlags, TypeFlags, DiagnosticCategory, ...
}

function loadTsgoModules(): TsgoModules {
	return {
		ast: require('@typescript/native-preview/ast'),
		factory: require('@typescript/native-preview/ast/factory'),
		sync: require('@typescript/native-preview/sync'),
	};
}

// Build a facade that mimics `typeof typescript`. Properties tsgo
// supplies route to tsgo; everything else falls back to real ts so the
// worker-internal calls keep working when accidental cross-imports happen.
export function createTypescriptFacade(): typeof ts {
	const tsgo = loadTsgoModules();
	const { ast, factory, sync } = tsgo;

	// Free-function `forEachChild` shape compat-eslint / typescript-eslint
	// expect: `ts.forEachChild(node, cbNode, cbNodes?)`. tsgo nodes carry
	// the method themselves; just delegate.
	const forEachChild = function (node: any, cbNode: any, cbNodes?: any) {
		if (node && typeof node.forEachChild === 'function') {
			return node.forEachChild(cbNode, cbNodes);
		}
		// Fall back to real ts for non-tsgo nodes (shouldn't happen on
		// this path, but cheap insurance).
		return (ts as any).forEachChild(node, cbNode, cbNodes);
	};

	// Free-function `getTokenAtPosition`-style helpers and a few of the
	// most-used ts.* utilities don't exist in tsgo's exports. Pass through
	// to real ts and accept the kind-mismatch fallout — flag them as gaps.

	// Plain object copy of ts. Why not `Object.create(ts)` (prototype
	// chain) or `Object.assign({}, ts)` (single shallow copy)?
	//
	// CJS interop helpers like tslib's `__importStar` iterate
	// `Object.getOwnPropertyNames(mod)` — they consume only OWN
	// properties, so prototype-inherited fallbacks are invisible to them.
	// typescript-estree compiles `import * as ts from 'typescript'` into
	// `__importStar(require('typescript'))`, so the consuming module sees
	// a snapshot built only from our own keys. Anything we don't own
	// (and don't surface as own) ends up `undefined` downstream — e.g.
	// `ts.Extension` → `undefined.Cjs` crash from the user's stack.
	//
	// So: copy every ts own-property up front. Some are getters; reading
	// them triggers the getter and gives us the value. Then overlay tsgo's
	// values — `SyntaxKind`, type guards, etc. — on top.
	const facade: any = {};
	for (const k of Object.getOwnPropertyNames(ts)) {
		try {
			facade[k] = (ts as any)[k];
		}
		catch {
			// Some ts internals throw on access (rare; defensive).
		}
	}

	// Enums from /ast (already aggregated): SyntaxKind, NodeFlags,
	// ModifierFlags, ScriptKind, ScriptTarget, TokenFlags, LanguageVariant,
	// RegularExpressionFlags, CommentDirectiveType, CharacterCodes.
	// Plus: all `is.*` predicates, visitor (visitNode/visitNodes/visitEachChild),
	// scanner, AST utils.
	for (const k of Object.keys(ast)) {
		facade[k] = ast[k];
	}

	// Enums from /api/sync that aren't in /ast: SymbolFlags, TypeFlags,
	// ObjectFlags, ElementFlags, SignatureKind, SignatureFlags,
	// NodeBuilderFlags, TypePredicateKind, DiagnosticCategory.
	for (const k of Object.keys(sync)) {
		// Skip API-level classes (API, Snapshot, Project, Program, Checker)
		// — those aren't typescript-module shape; only enum values are
		// useful here. Enums are objects with both numeric and reverse
		// string keys.
		const v = sync[k];
		if (typeof v !== 'object' || v === null) continue;
		// Heuristic: enum-shaped object has at least one numeric value.
		const hasNumeric = Object.values(v).some(x => typeof x === 'number');
		if (!hasNumeric) continue;
		// Don't clobber if already supplied by /ast.
		if (k in facade) continue;
		facade[k] = v;
	}

	// /ast/factory exports `factory` namespace + creation helpers. Real ts
	// rule code uses `ts.factory.createX(...)` for code-fix output. Wire
	// the namespace through.
	if (factory.factory) {
		facade.factory = factory.factory;
	}
	// Free-function `createX` + `updateX` from factory module too.
	for (const k of Object.keys(factory)) {
		if (k === 'factory' || k === 'NodeObject') continue;
		if (typeof factory[k] !== 'function') continue;
		if (k in facade && !k.startsWith('create')) continue;
		facade[k] = factory[k];
	}

	// `forEachChild` override — must come AFTER /ast spread (which may
	// already export it; tsgo's `/ast/visitor` exports `visitEachChild`
	// not `forEachChild`). We add the free-function form rule code expects.
	facade.forEachChild = forEachChild;

	// Sentinel marker so the worker can detect this isn't real ts when
	// debugging cache-substitution issues.
	facade.__tsgoFacade__ = true;

	return facade as typeof ts;
}

// Install the facade so `require('typescript')` returns it from anywhere
// in the dependency graph — including transitive dependencies that pnpm
// resolves to a sibling typescript instance under `.pnpm/typescript@x.y`.
// Cache-slot substitution alone misses those because they're keyed by a
// different absolute path than `require.resolve('typescript')` from our
// cwd. We override `Module._resolveFilename` so every literal
// `'typescript'` request resolves to a single canonical id, then prime
// that one cache slot with the facade.
//
// Limitations: does NOT intercept resolutions like
// `require('typescript/lib/typescript')` (literal subpath) — those keep
// the real ts. That's intentional: anything reaching for an internal
// path probably wants real ts implementation, not enum re-routing.
export function installFacade(): typeof ts {
	const Module = require('module') as any;
	const FACADE_ID = '@tsslint-tsgo-facade';
	if (Module._cache[FACADE_ID]?.exports?.__tsgoFacade__) {
		return Module._cache[FACADE_ID].exports;
	}
	const facade = createTypescriptFacade();
	// Synthetic cache entry — not a real disk path, but Node's loader
	// only consults `_cache[id]` when looking up an already-resolved
	// module, so any string id is fine as long as the slot exists.
	const wrapper = new Module(FACADE_ID, null);
	wrapper.id = FACADE_ID;
	wrapper.filename = FACADE_ID;
	wrapper.loaded = true;
	wrapper.exports = facade;
	Module._cache[FACADE_ID] = wrapper;

	// Resolve hook — must be installed AFTER the facade is in cache so
	// the very first `require('typescript')` after this point hits the
	// facade slot.
	const origResolve = Module._resolveFilename;
	Module._resolveFilename = function (
		request: string,
		parent: unknown,
		...rest: unknown[]
	) {
		if (request === 'typescript') {
			return FACADE_ID;
		}
		return origResolve.call(this, request, parent, ...rest);
	};
	return facade;
}
