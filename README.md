# TSSLint

<p align="center">
  <img src="logo.png" alt="TSSLint Logo" width="200">
</p>

<p align="center">
  <a href="https://npmjs.com/package/@tsslint/core"><img src="https://badgen.net/npm/v/@tsslint/core" alt="npm package"></a>
  <a href="https://discord.gg/NpdmPEUNjE"><img src="https://img.shields.io/discord/854968233938354226?color=7289DA&label=discord" alt="Discord"></a>
  <a href="https://github.com/johnsoncodehk/tsslint/tree/master/LICENSE"><img src="https://img.shields.io/github/license/johnsoncodehk/tsslint.svg?labelColor=18181B&color=1584FC" alt="License"></a>
  <a href="https://deepwiki.com/johnsoncodehk/tsslint"><img src="https://deepwiki.com/badge.svg" alt="Ask DeepWiki"></a>
</p>

A linter for TypeScript 7. Rules are plain functions over the TypeScript AST, with the TypeScript 7 checker available for type information.

Zero built-in rules.

## How it compares

TSLint (TS-AST, deprecated 2019) → ESLint took over via `typescript-eslint` → TSSLint revives the TS-AST approach (2023), on the TypeScript 7 API since v4.

```
             2013        2019                2023
              │            │                   │
              │            │                   │
  TSLint ─────●━━━━━━━━━━━✗ deprecated         │
                             ╲                 │
                              ╲                │
  ESLint ─────●━━━━━━━━━━━━━━━━╲━━━━━━━━━━━━━━━━━━━▶ (active)
                                ╲              │
                                 ╲             │
  TSSLint                         ╲────────────●━━▶  (revives TS-AST,
                                                     TypeScript 7 since v4)
```

| | ESLint | TSLint | Oxlint | TSSLint |
|---|---|---|---|---|
| Runtime | Node, separate process | Node, separate process | Rust, separate process | Node + TypeScript 7 |
| AST | ESTree | TS AST | Native Rust AST | TS AST |
| Type-aware rules | Yes (its own `Program`) | Yes (its own `Program`) | Yes (via `tsgolint`, alpha) | Yes (TypeScript 7 checker) |
| Built-in rules | Many | Deprecated | Subset of ESLint (+ JS plugins, alpha) | Zero (imports ESLint rules) |
| Status | Active standard | Deprecated 2019 | Active | Active |

**Pick by need.** Largest ecosystem → ESLint. Fastest standalone runtime → Oxlint. Rules on the TypeScript 7 AST and checker → TSSLint.

## Setup

```bash
npm install @tsslint/cli @tsslint/config --save-dev
```

`tsslint.config.ts`:

```ts
import { defineConfig } from '@tsslint/config';

export default defineConfig({
  rules: {
    // your rules
  },
});
```

Then run `npx tsslint --project tsconfig.json` (see [CLI](#cli)).

There is no editor integration in v4: TypeScript 7 has no tsserver plugin API.

## Writing rules

A rule is a function. It receives the `typescript/ast` module, the current `Program` and `Checker` (from `typescript/sync`), the `SourceFile`, and a `report()` callback.

```ts
import { defineRule } from '@tsslint/config';

export default defineRule(({ typescript: ts, file, report }) => {
  file.forEachChild(function visit(node): void {
    if (node.kind === ts.SyntaxKind.DebuggerStatement) {
      report('Debugger statement is not allowed.', node.getStart(file), node.getEnd());
    }
    node.forEachChild(visit);
  });
});
```

### Severity, fixes, refactors

`report()` returns a chainable reporter:

```ts
report('No console.', node.getStart(file), node.getEnd())
  .asError()                     // default is Message; also: asWarning(), asSuggestion()
  .withDeprecated()              // strikethrough
  .withUnnecessary()             // faded
  .withFix('Remove call', () => [
    { pos: node.getStart(file), end: node.getEnd(), newText: '' },
  ])
  .withRefactor('Wrap in if (DEBUG)', () => [/* ... */]);
```

`withFix` is applied by `tsslint --fix`; `withRefactor` registers a user-initiated edit for hosts that expose refactors.

### Real-world example

[vuejs/language-tools tsslint.config.ts](https://github.com/vuejs/language-tools/blob/master/tsslint.config.ts).

### Organizing rules

Rules can nest; the path becomes the rule id:

```ts
defineConfig({
  rules: {
    style: {
      'no-debugger': debuggerRule,   // reported as "style/no-debugger"
    },
  },
});
```

`defineConfig` also accepts an array — each entry can scope rules with `include` / `exclude` minimatch patterns.

### Caching

The CLI caches each file's diagnostics on disk under `os.tmpdir()/tsslint-cache/`, and re-lints a file only when its result may have changed, the way `tsc --incremental` decides what to re-check:

- the file itself changed (mtime or size), or
- a file it imports or references changed its declaration signature (its `.d.ts` emit). Editing a function body re-lints only that file; changing an exported type re-lints its importers, and keeps going through files whose own signature changes as a result (e.g. re-exports).

Everything is re-linted when a change can affect any file: compiler options or a tsconfig file, the content mappers, `tsslint.config.ts` or any module it imports, files added to or removed from the program, files under `node_modules`, or a changed declaration signature of a file that declares globals (a script without imports or exports, `declare global`, `declare module '...'`).

Rules must only depend on the program they are given (`ctx.file`, `ctx.program`, `ctx.checker`). Anything outside it — files read directly via `fs`, environment variables, network resources — is not tracked; pass `--force` to re-lint every file.

### Debugging

Every `report()` captures a stack trace. The diagnostic carries a "Related Information" entry pointing at the exact line in your rule that triggered it:

```
src/index.ts:3:1
  3 │ debugger;
    │ ~~~~~~~~~ Debugger statement is not allowed. (tsslint)
    │             ↳ rules/no-debugger.ts:5:7
```

## CLI

```bash
npm install @tsslint/cli --save-dev
```

```bash
npx tsslint --project tsconfig.json
npx tsslint --project tsconfig.json --fix
npx tsslint --project 'packages/*/tsconfig.json' --filter 'src/**/*.ts'
```

Flags:

| Flag | |
|---|---|
| `--project <glob...>` | TypeScript projects to lint |
| `--filter <glob...>` | Restrict to matching files |
| `--fix` | Apply fixes |
| `--force` | Ignore cache |
| `--failures-only` | Only print diagnostics that affect exit code |
| `-h`, `--help` | |

TSSLint produces diagnostics and edits — it does not format. Run dprint or Prettier after `--fix`.

## Framework support

Since v4, framework files (`.vue`, `.astro`, `.mdx`, `.svelte`, …) are linted through TypeScript 7.1's **content mapper** — the same mechanism `tsc` uses — instead of Volar language plugins. Declare the mappers in `tsconfig.json`; TSSLint picks them up with the project:

```jsonc
{
  "contentMappers": [
    { "package": "@vue/content-mapper", "extensions": [".vue"] }
  ]
}
```

Rules run against the transformed TypeScript, and diagnostics are mapped back to the original file through the mapper's span map. Diagnostics that only cover generated code are dropped, and `--fix` only applies fixes whose edits all map exactly onto original text.

The v3 flags `--vue-project`, `--vue-vine-project`, `--mdx-project`, `--astro-project`, and `--ts-macro-project` are gone; the mapper configuration in `tsconfig.json` replaces them. See [docs/migration-v4.md](docs/migration-v4.md).

## Importing ESLint rules

```bash
npm install @tsslint/compat-eslint --save-dev
npx tsslint-docgen                                        # generates JSDoc for IDE autocomplete
```

For each non-built-in rule (`<plugin>/<rule>`), install the matching ESLint plugin (`eslint-plugin-<plugin>` or `@scope/eslint-plugin`).

```ts
import { defineConfig, importESLintRules } from '@tsslint/config';

export default defineConfig({
  rules: {
    ...await importESLintRules({
      'no-unused-vars': true,
      'eqeqeq': 'warn',
    }),
  },
});
```

`@typescript-eslint/eslint-plugin` does not load with `typescript@7` yet (its dependencies read the classic `typescript` API at load time), so `@typescript-eslint/*` rules are unavailable until typescript-eslint supports TypeScript 7.

## Plugins

Plugins can rewrite rules per file, filter diagnostics, and inject code fixes. Three are bundled:

```ts
import {
  defineConfig,
  createIgnorePlugin,
  createCategoryPlugin,
  createDiagnosticsPlugin,
} from '@tsslint/config';
import { DiagnosticCategory } from 'typescript/sync';

export default defineConfig({
  rules: { /* ... */ },
  plugins: [
    // // tsslint-ignore [rule-id]  — single-line, or *-start / *-end pairs
    createIgnorePlugin('tsslint-ignore', /* report unused */ true),

    // Override severity by rule-id pattern
    createCategoryPlugin({
      'style/*': DiagnosticCategory.Warning,
    }),

    // Forward TypeScript's own diagnostics through the same pipeline.
    createDiagnosticsPlugin('semantic'),
  ],
});
```

Build your own with the `Plugin` type from `@tsslint/types`.

## Requirements

- Node.js **22.12.0+** (`tsslint.config.ts` is loaded with `--experimental-strip-types` — no transpile step)
- TypeScript 7 comes bundled as a dependency, separate from the `typescript` your project compiles with. TypeScript 5/6 are not supported; see [docs/migration-v4.md](docs/migration-v4.md)

## License

[MIT](LICENSE)
