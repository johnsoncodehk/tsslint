# `@tsslint/compat-eslint` changelog

## Unreleased

### Behaviour breaks

- **`tsToEstreeOrStub` returns `undefined` for kinds with no ESTree counterpart.** Previously it returned a `GenericTSNode` stub with a synthetic `'TS<KindName>'` type for tokens / JSDoc / certain TS-internal containers (`SyntaxList`, `NamedExports`, `TemplateSpan`, etc.). The stub was never structurally meaningful — it would either confuse rules that pattern-matched on `node.type` or, in the worst case, trigger the `VisitorBase.visitChildren` `Object.keys` fall-back into walking up `LazyNode._parent`, producing `Maximum call stack size exceeded` (the BigIntLiteral-on-`adapter-mariadb/conversion.test.ts` symptom that surfaced this whole work). The signature was already typed as `T | undefined`; this change just routes those kinds through the typed `NoESTreeCounterpartError` thrown by `materialize()` and caught by `tsToEstreeOrStub`. Net effect: external consumers of `tsToEstreeOrStub` who relied on the truthy stub return must add a nullable check (`?? null`, `if (real) ...`, etc.). The call sites in this package's own `ts-scope-manager.ts` were audited and already nullable-aware.

### Added

- **`hasNoEstreeCounterpart(kind: ts.SyntaxKind): boolean`** — `@internal` predicate marking which TS `SyntaxKind` values have no ESTree counterpart by design (range-based: trivia / EOF / punctuation / reserved + contextual keywords minus the explicit `KEYWORD_HAS_ESTREE_COUNTERPART` exempt set / JSDoc family — plus an explicit `NO_COUNTERPART_NODE_KINDS` set for TS-internal containers). Exported only for tsslint's own test coverage; external consumers should `instanceof NoESTreeCounterpartError`.
- **`NoESTreeCounterpartError` class, exported from `@tsslint/compat-eslint`.** Thrown by `materialize()` for kinds in the no-counterpart set. Tools doing bottom-up walks can catch and walk further up; `tsToEstreeOrStub` does this for its callers.
- **`TSSLINT_STRICT_GENERIC=1` env var.** Makes `convertChildInner`'s `GenericTSNode` safety-net fall-through THROW `GenericTSNodeFallbackError` so CI can detect any TS `SyntaxKind` that slips past the explicit handlers. Read once at module load. See README → Environment variables.
- **`Literal` shape for `BigIntLiteral`.** Was previously falling through to `GenericTSNode` with `type: 'TSBigIntLiteral'` (not a real ESTree type). Mirrors `typescript-estree convert.js:1532` — `Literal` with `bigint` / `value` / `raw` (the latter lazily reads `getText`).
- **`TemplateElement` shape for `TemplateHead` / `TemplateMiddle` / `TemplateTail`.** Bottom-up `materialize()` on a stand-alone template-part TS node now produces the canonical shape rather than a phantom `'TSTemplateHead'`-style type.
- **`TypeKeywordNode`-routed cases for the 9 modifier keywords** (`AbstractKeyword`, `AsyncKeyword`, `DeclareKeyword`, `ExportKeyword`, `PrivateKeyword`, `ProtectedKeyword`, `PublicKeyword`, `ReadonlyKeyword`, `StaticKeyword`).
- **Pre-materialize hook for class / interface / enum / module members** (`LISTENER_PRE_MATERIALIZE`). Drilled inside `dispatchTarget` right before `runEntries` when there's at least one listener — touches `body.body` once so each member converts and registers in the cache. Fixes `no-misused-promises` crashing `Cannot read properties of undefined (reading 'type')` inside `isStaticMember(undefined)` on every class file.

### Fixed

- **`declare global { ... }` no longer triggers fake `no-unused-vars` fires** on the synthetic `__global` symbol or its inner `var`/`fn` declarations. Three correlated defects in lazy-estree (`TSModuleDeclaration` `kind` collapsed `'global'`→`'module'`; `_collectStatementBindings` pushed the TS-internal `__global` symbol; `sf.locals.forEach` didn't filter TS-internal escaped names) plus a `variableScope` getter missing `tsModule` in `ts-scope-manager`.
- **`LazyNode._parent` is now non-enumerable.** Defends against `VisitorBase.visitChildren`'s `Object.keys(node)` fall-back walking UP the parent chain when a node's `type` isn't in upstream visitor-keys. Closes the stack-overflow class of bug for any future unhandled `SyntaxKind`.
- **JSX wrapper-route trigger drills into `JSXMemberExpression` / `JSXNamespacedName`** so inner `JSXIdentifier`s register in the cache. Fixes 698 false `no-debugger` fires on shadcn-ui `apps/v4` (the `<MenuPrimitive.Root />` pattern).
- **`config(ignore)` parses `eslint-disable a, b` as a comma-separated rule list** and gates the cmd-boundary so `eslint-disable` no longer matches `eslint-disable-line ...`. Previously both fell back to disable-ALL.

## Earlier (pre-this-changelog)

See git history. The above documents the cycle that landed `NoESTreeCounterpartError` and the surrounding correctness / defense work.
