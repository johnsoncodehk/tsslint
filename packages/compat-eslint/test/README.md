# Tests for `@tsslint/compat-eslint`

## Coverage

| Module                    | Test approach                                                                                                                                                                                              |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `lib/lazy-estree.ts`      | `lazy-estree.test.ts` — parity sweep (every TS file under `packages/`), identity invariants, bottom-up `materialize`, smoke under `visitorKeys` traversal.                                                  |
| `lib/ts-scope-manager.ts` | (1) Vendored upstream `@typescript-eslint/scope-manager` tests under `upstream/`, run via `upstream-runner.ts`. (2) Focused fixture diff in `scope-compat.test.ts` against the upstream analyzer.          |

`upstream-runner.ts` uses typescript-estree's eager `astConverter` for
the runner — upstream tests do shape comparisons (`parent === referencingNode`)
that need stable node identity, which lazy mode would break unless the
entire tree pre-materialised. Production-wise compat-eslint defaults to
lazy via `index.ts`; the runner uses eager to keep parity tests reliable.

`scope-compat.test.ts` uses the unpatched eager `astConverter` for an
apples-to-apples comparison with `@typescript-eslint/scope-manager`'s
`analyze()` (both sides need the same ESTree input).

The 13 known upstream failures are documented in
[`upstream/README.md`](upstream/README.md) and reflect intentional
design tradeoffs, not bugs.

## Running

```bash
# Lazy ESTree tests (parity + identity + smoke)
node packages/compat-eslint/test/lazy-estree.test.js

# Upstream scope-manager parity tests (vendored from typescript-eslint)
node packages/compat-eslint/test/upstream-runner.js [pattern] [-v]

# Focused fixture diff (TsScopeManager vs @typescript-eslint/scope-manager)
node --experimental-strip-types --no-warnings packages/compat-eslint/test/scope-compat.test.ts
```
