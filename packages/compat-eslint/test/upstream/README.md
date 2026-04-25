# Upstream scope-manager tests

These are the tests from `@typescript-eslint/scope-manager` (typescript-eslint
v8.x), used to validate that `TsScopeManager` is structurally compatible with
the upstream analyzer.

Source: https://github.com/typescript-eslint/typescript-eslint/tree/main/packages/scope-manager/tests

Licensed under MIT (see https://github.com/typescript-eslint/typescript-eslint/blob/main/LICENSE).
The test files are vendored unchanged so their import paths
(`../../src/index.js`, `../test-utils/index.js`) are intercepted by
`upstream-runner.ts`, which routes them to a TsScopeManager-backed shim.

Run with: `node packages/compat-eslint/test/upstream-runner.js [pattern]`

## Known failures (209/225 passing)

The 16 remaining failures fall into four buckets, none of which are bugs
in `TsScopeManager`:

- **ES6 destructuring with default values (8 tests)**: upstream's analyzer
  emits two references for each binding identifier in patterns like
  `[c=d]` (one for the read of `c`, one for the write). TS's checker
  produces a single identifier-symbol mapping per occurrence, so we emit
  one reference. Reflected in counts being off by 1–3.
- **`globalReturn` option (2 tests)**: ESLint's CommonJS-wrapper
  convention that synthesizes a function scope around the program. Not a
  TS concept; we do not support the option.
- **`impliedStrict` option (3 tests)**: ESLint's flag forcing strict mode
  on all scopes regardless of source. Not a TS concept; we do not support
  the option.
- **ESTree-traversal of type-position nodes (3 tests)**: the runner uses
  the same patched converter as production (`astConvertSkipTypes`), which
  returns `null` for `TSTypeReference`, `TSTypeParameter`, etc. so the
  traverser skips them. Tests that walk the ESTree to collect
  type-position nodes therefore find none. This is the intended
  perf/integration tradeoff — rules that need type information are
  expected to query the TS checker.
