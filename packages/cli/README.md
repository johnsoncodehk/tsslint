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

See the [root README](../../README.md) for framework project flags (`--vue-project`, `--mdx-project`, …), caching behavior, and how diagnostics are emitted.
