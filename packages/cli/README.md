# @tsslint/cli

Command-line runner for TSSLint. Lints TypeScript projects in CI or from the terminal.

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

See the [root README](../../README.md) for caching behavior and how diagnostics are emitted.
