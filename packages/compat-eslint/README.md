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

---

The rest of this file is for tsslint maintainers — internal architecture, debug knobs. Surface API consumed by `@tsslint/config` is just `convertRule`; everything else is implementation detail without API-stability guarantees.

## Debug environment variables

Both flags below are read **once at module load** (when `@tsslint/compat-eslint` is first `require`/`import`-ed). Setting them later — e.g. inside a Vitest `beforeAll` after the module has been imported — has no effect. Set them in the shell or in your CI workflow before invoking `node` / `tsslint`.

### `TSSLINT_STRICT_GENERIC=1`

Makes `convertChildInner`'s `GenericTSNode` safety-net fall-through THROW `GenericTSNodeFallbackError` instead of silently producing a phantom `'TS<KindName>'` ESTree node. Combine with the test suite (or your own bench fixtures) to detect any TS `SyntaxKind` that slips past the explicit handlers.

```bash
TSSLINT_STRICT_GENERIC=1 npm run lint
```

Production runs should leave it UNSET — the GenericTSNode fall-back is the safety net for unknown future TS `SyntaxKind` values, paired with the `_parent` non-enumerable defense in `LazyNode` so phantom nodes never trigger the visitor's stack-overflow recursion path.

### `TSSLINT_DEBUG_ESTREE=1`

Enables instance-construction counters in `lazy-estree`. Reads back via `getNodeTypeCounts()` / `getNodeTypeSourceCounts()` on `globalThis` (so the counter is shared across `require()` instances of the module). Used by tsslint's own conversion-cost benchmarks.
