# @tsslint/core

The linting engine. Runs rules over TypeScript source files, manages the on-disk cache, and produces diagnostics.

End users don't install this directly — it's a runtime dependency of [`@tsslint/typescript-plugin`](../typescript-plugin) (editor integration) and [`@tsslint/cli`](../cli) (batch linting), so both share one implementation.

See the [root README](../../README.md) for TSSLint itself.
