# Tests for `@tsslint/compat-eslint`

## Coverage

| Module                       | Test approach                                                                                                                                                  |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `lib/ts-scope-manager.ts`    | (1) Vendored upstream `@typescript-eslint/scope-manager` tests under `upstream/`, run via `upstream-runner.ts`. (2) Focused fixture diff in `scope-compat.test.ts` against the upstream analyzer. |
| `lib/skip-type-converter.ts` | Integration coverage only — `upstream-runner.ts` calls `astConvertSkipTypes` (the same patched converter as production), so any breakage caused by the patch shows up there. No unit tests for the patch logic itself. |

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
```
