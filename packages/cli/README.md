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
- Multi-file `--tsgo` skips layer-1 disk cache and reuses **one tsgo child** across `--project` entries. `--tsgo-fast` additionally eager-prepares all files at setup (opt-in).
- Benchmark on this repo (~37 ts-eslint files): Strada ~1.6–3s, `--tsgo` ~1.8–2s; full repo (~59 files, 8 tsconfigs): Strada ~1.8–2.2s, `--tsgo` ~5.6–5.9s (~2.7–3.1× Strada).
- Dogfood parity: `pnpm run lint:tsgo` — 68/76 files clean vs Strada (shim sources exempt from `no-unnecessary-type-assertion`; remaining gap is tsgo checker divergence on other files).

```bash
pnpm run lint:tsgo    # same projects as lint, with --tsgo --force
```

See the [root README](../../README.md) for framework project flags (`--vue-project`, `--mdx-project`, …), caching behavior, and how diagnostics are emitted.
