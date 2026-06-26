# @tsslint/cli

Command-line runner for TSSLint. Lints TypeScript projects — and Vue / Vue Vine / MDX / Astro / TS Macro projects via Volar language plugins — in CI or from the terminal.

## Usage

```bash
npm install @tsslint/cli --save-dev
```

```bash
npx tsslint --project tsconfig.json
npx tsslint --project tsconfig.json --fix
npx tsslint --project 'packages/*/tsconfig.json' --filter 'src/**/*.ts'
```

Run `tsslint --help` for the full flag list.

### Beta: `--tsgo` (TypeScript native / ts-go backend)

Use the Go-based TypeScript compiler (`@typescript/native-preview`) instead of the Node `typescript` package:

```bash
npx tsslint --project tsconfig.json --tsgo
```

- Requires optional peer `@typescript/native-preview` (pinned in this package).
- Plain `--project` only — no Vue / MDX / Astro framework flags.
- Multi-file projects automatically enable a fast path (skip disk cache, eager-prepare symbols). Override with `--no-tsgo-fast` or force with `--tsgo-fast`.
- Benchmark on this repo (~37 ts-eslint files): Strada ~3.4s, `--tsgo` ~2.1s; full repo (~59 files): within ~10% of Strada.
- Dogfood parity: `pnpm run lint:tsgo` — 62/69 files clean vs Strada (type-aware divergence on `tsgo-*` shim sources).

```bash
pnpm run lint:tsgo    # same projects as lint, with --tsgo --force
```

See the [root README](../../README.md) for framework project flags (`--vue-project`, `--mdx-project`, …), caching behavior, and how diagnostics are emitted.
