# Tests for `@tsslint/compat-eslint`

## Coverage

| Module                       | Test approach                                                                                                                                                  |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `lib/ts-scope-manager.ts`    | (1) Vendored upstream `@typescript-eslint/scope-manager` tests under `upstream/`, run via `upstream-runner.ts`. (2) Focused fixture diff in `scope-compat.test.ts` against the upstream analyzer. |
| `lib/skip-type-converter.ts` | Unit tests in `skip-type-converter.test.ts` (selector-aware behaviour: kinds whose ESTree counterpart appears in any registered rule's visitor are NOT skipped). Plus integration via `upstream-runner.ts`. |

`upstream-runner.ts` is the production code path: same patched converter,
same scope manager, same wiring. The 16 known failures (out of 225) are
documented in [`upstream/README.md`](upstream/README.md) and reflect
intentional design tradeoffs, not bugs.

`scope-compat.test.ts` uses the unpatched `astConverter` for an
apples-to-apples comparison with `@typescript-eslint/scope-manager`'s
`analyze()` (both sides need the same ESTree input).

## Running

```bash
# Upstream parity tests (vendored from typescript-eslint)
node packages/compat-eslint/test/upstream-runner.js [pattern] [-v]

# Focused fixture diff (TsScopeManager vs @typescript-eslint/scope-manager)
node --experimental-strip-types --no-warnings packages/compat-eslint/test/scope-compat.test.ts

# Skip-type-converter unit tests (after `tsc -b`)
node packages/compat-eslint/test/skip-type-converter.test.js
```
