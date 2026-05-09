# `@tsslint/compat-eslint` changelog

> Internal package. Surface API consumed by `@tsslint/config`'s `importESLintRules` is just `convertRule`. Everything else is implementation detail. This file documents what landed for the maintainer's own bisection / archaeology, not for downstream-consumer migration.

## Unreleased — fallback-path elimination cycle

### Materialise contract change

`materialize()` now throws a typed `NoESTreeCounterpartError` (instead of returning a `GenericTSNode` stub) for TS `SyntaxKind`s with no ESTree counterpart by design — tokens, JSDoc, and a small set of TS-internal containers (`SyntaxList`, `NamedExports`, `TemplateSpan`, etc., enumerated in `lib/lazy-estree.ts:NO_COUNTERPART_NODE_KINDS` plus the range checks in `hasNoEstreeCounterpart`). All in-package callers (`tsToEstreeOrStub`, `resolveParentInner`, `ts-ast-scan`'s predicate dispatcher) catch the error and either return undefined / walk further up / skip dispatch — auditing was scoped to this package only since nothing else in the tsslint workspace touches these helpers.

The catch-paths land in production. The throw is caught and converted into the same shape downstream behaviour (skip / walk-up) the prior stub-return implicitly produced, just typed and explicit instead of phantom-shaped. Users of `@tsslint/config` see no difference.

### Strict mode (`TSSLINT_STRICT_GENERIC=1`)

When set, `convertChildInner`'s `GenericTSNode` safety-net fall-through THROWS `GenericTSNodeFallbackError` instead of silently producing a phantom `'TS<KindName>'` ESTree node. Lets CI detect any TS `SyntaxKind` that slips past the explicit handlers — verified clean against prisma matched-type-aware (1263 files, 89 rules), shadcn-ui matched-syntactic (3156 files), tsslint self-lint, and 20 phantom-type fixtures.

Read once at module load. Production stays UNSET — the GenericTSNode fall-back is the safety net for unknown future TS `SyntaxKind` values, paired with the `_parent` non-enumerable defense in `LazyNode` so phantom nodes never trigger the visitor's stack-overflow recursion path.

### Added shapes

- `Literal` shape for `BigIntLiteral` (was `GenericTSNode → 'TSBigIntLiteral'`). Mirrors `typescript-estree convert.js:1532` — `Literal` with `bigint` / `value` / `raw` (the latter lazily reads `getText`).
- `TemplateElement` shapes for `TemplateHead` / `TemplateMiddle` / `TemplateTail`. Bottom-up `materialize()` on a stand-alone template-part TS node now produces the canonical shape rather than a phantom `'TSTemplateHead'`-style type.
- `TypeKeywordNode`-routed cases for the 9 modifier keywords (`AbstractKeyword`, `AsyncKeyword`, `DeclareKeyword`, `ExportKeyword`, `PrivateKeyword`, `ProtectedKeyword`, `PublicKeyword`, `ReadonlyKeyword`, `StaticKeyword`).
- Pre-materialize hook for class / interface / enum / module members (`LISTENER_PRE_MATERIALIZE`). Drilled inside `dispatchTarget` right before `runEntries` when there's at least one listener — touches `body.body` once so each member converts and registers in the cache. Fixes `no-misused-promises` crashing `Cannot read properties of undefined (reading 'type')` inside `isStaticMember(undefined)` on every class file.

### Fixed

- `declare global { ... }` no longer triggers fake `no-unused-vars` fires on the synthetic `__global` symbol or its inner `var`/`fn` declarations. Three correlated defects in lazy-estree (`TSModuleDeclaration` `kind` collapsed `'global'`→`'module'`; `_collectStatementBindings` pushed the TS-internal `__global` symbol; `sf.locals.forEach` didn't filter TS-internal escaped names) plus a `variableScope` getter missing `tsModule` in `ts-scope-manager`.
- `LazyNode._parent` is now non-enumerable. Defends against `VisitorBase.visitChildren`'s `Object.keys(node)` fall-back walking UP the parent chain when a node's `type` isn't in upstream visitor-keys. Closes the stack-overflow class of bug for any future unhandled `SyntaxKind`.
- JSX wrapper-route trigger drills into `JSXMemberExpression` / `JSXNamespacedName` so inner `JSXIdentifier`s register in the cache. Fixes 698 false `no-debugger` fires on shadcn-ui `apps/v4` (the `<MenuPrimitive.Root />` pattern).
- `config(ignore)` parses `eslint-disable a, b` as a comma-separated rule list and gates the cmd-boundary so `eslint-disable` no longer matches `eslint-disable-line ...`. Previously both fell back to disable-ALL.

## Earlier (pre-this-changelog)

See git history. The above documents the cycle that landed `NoESTreeCounterpartError` and the surrounding correctness / defense work.
