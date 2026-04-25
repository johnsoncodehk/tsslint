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
