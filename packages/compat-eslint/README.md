# @tsslint/compat-eslint

Adapter that lets ESLint rules run under TSSLint. Consumed by `importESLintRules` from [`@tsslint/config`](../config).

## Usage

```bash
npm install @tsslint/compat-eslint --save-dev
npm install @typescript-eslint/eslint-plugin --save-dev   # for @typescript-eslint/* rules
```

```ts
import { defineConfig, importESLintRules } from '@tsslint/config';

export default defineConfig({
  rules: {
    ...await importESLintRules({
      'no-unused-vars': true,
      '@typescript-eslint/no-explicit-any': 'warn',
    }),
  },
});
```

For each `<plugin>/<rule>` you reference, install the matching `eslint-plugin-<plugin>` (or `@scope/eslint-plugin`) package.

See the [root README](../../README.md) for full interop notes, including TSLint and TSL.

## Environment variables

Both flags below are read **once at module load** (when `@tsslint/compat-eslint` is first `require`/`import`-ed). Setting them later — e.g. inside a Vitest `beforeAll` after the module has been imported — has no effect. Set them in the shell or in your CI workflow before invoking `node` / `tsslint`.

### `TSSLINT_STRICT_GENERIC=1`

Makes `convertChildInner`'s `GenericTSNode` safety-net fall-through THROW `GenericTSNodeFallbackError` instead of silently producing a phantom `'TS<KindName>'` ESTree node. Combine with the test suite (or your own bench fixtures) to detect any regression where a TS `SyntaxKind` slips past the explicit handlers.

```bash
TSSLINT_STRICT_GENERIC=1 npm run lint
```

In production this should stay UNSET — the GenericTSNode fall-back is the safety net for unknown future TS `SyntaxKind` values, paired with the `_parent` non-enumerable defense in `LazyNode` so phantom nodes never trigger the visitor's stack-overflow recursion path.

### `TSSLINT_DEBUG_ESTREE=1`

Enables instance-construction counters in `lazy-estree`. Reads back via `getNodeTypeCounts()` / `getNodeTypeSourceCounts()` on `globalThis` (so the counter is shared across `require()` instances of the module). Used by tsslint's own conversion-cost benchmarks; not generally needed.

## Public API

In addition to the rule-runner machinery (`convertRule`, the lint-pipeline glue), this package exports a couple of materialise-related helpers for tooling that walks the lazy ESTree shim:

- `NoESTreeCounterpartError` — thrown by `materialize()` when called with a TS `SyntaxKind` that has no ESTree counterpart by design (tokens, JSDoc, certain TS-internal containers). Tools doing bottom-up walks (`tsToEstreeOrStub` and friends) can `instanceof`-check this and walk further up rather than treating it as an unexpected error.
- `getNodeTypeCounts` / `resetNodeTypeCounts` — debug instrumentation gated by `TSSLINT_DEBUG_ESTREE` (see above).

### Behaviour-break note (ts-scope-manager `tsToEstreeOrStub`)

Since the `NoESTreeCounterpartError` work landed, `tsToEstreeOrStub` returns `undefined` (instead of a `GenericTSNode` stub) for TS kinds with no ESTree counterpart — tokens, JSDoc, and the handful of TS-internal containers documented in `lib/lazy-estree.ts:NO_COUNTERPART_NODE_KINDS`. External consumers that previously relied on the stub's truthy-but-meaningless return must add a `?? null` / nullable check at the call site. Treat this as the API's source of truth — the stub never carried useful information for these kinds.
