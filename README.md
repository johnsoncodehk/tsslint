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

A linter that runs as a `tsserver` plugin. It reuses the TypeChecker your editor already has — no second process, no AST conversion, no duplicated type-checking.

Zero built-in rules. Rules are plain functions over the TypeScript compiler API.

## Why?

ESLint runs in its own process and builds its own type information. On large projects this makes "Auto Fix on Save" slow.

TSSLint piggybacks on `tsserver`. Diagnostics show up in the same path TypeScript errors do, using the same `Program` instance.

```
   Traditional                       TSSLint
   ───────────                       ───────

      ┌─────┐                            ┌─────┐
      │ IDE │                            │ IDE │
      └──┬──┘                            └──┬──┘
         │                                  │
     ┌───┴────┐                             ▼
     ▼        ▼                    ┌─────────────────┐
  ┌──────┐ ┌──────┐                │    tsserver     │
  │ ts-  │ │linter│                │  ┌───────────┐  │
  │server│ │      │                │  │TypeChecker│  │
  │      │ │      │                │  └─────┬─────┘  │
  │ Type │ │ Type │                │        │        │
  │ Chk. │ │ Chk. │                │  ┌─────▼─────┐  │
  └──────┘ └──────┘                │  │  TSSLint  │  │
                                   │  └───────────┘  │
   ✗ two type-checkers             └─────────────────┘
     two parses                     ✓ one shared pass
```

## How it compares

TSLint (TS-AST, deprecated 2019) → ESLint took over via `typescript-eslint` → TSSLint revives the in-process TS-AST approach as a `tsserver` plugin (2023).

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
  TSSLint                         ╲────────────●━━▶  (tsserver plugin,
                                                     revives TS-AST)
```

| | ESLint | TSLint | Oxlint | TSSLint |
|---|---|---|---|---|
| Runtime | Node, separate process | Node, separate process | Rust, separate process | Node, in `tsserver` |
| AST | ESTree | TS AST | Native Rust AST | TS AST |
| Type-aware rules | Yes (its own `Program`) | Yes (its own `Program`) | Yes (via `tsgolint`, alpha) | Yes (shared `TypeChecker`) |
| Built-in rules | Many | Deprecated | Subset of ESLint (+ JS plugins, alpha) | Zero (imports ESLint / TSLint / TSL) |
| Status | Active standard | Deprecated 2019 | Active | Active |

**Pick by need.** Largest ecosystem → ESLint. Fastest standalone runtime → Oxlint. Type-aware without duplicate type-checking → TSSLint.

## Setup

```bash
npm install @tsslint/config --save-dev
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

**VSCode**: install [the extension](https://marketplace.visualstudio.com/items?itemName=johnsoncodehk.vscode-tsslint).

**Other editors**: install the plugin and register it in `tsconfig.json`:

```bash
npm install @tsslint/typescript-plugin --save-dev
```

```json
{
  "compilerOptions": {
    "plugins": [{ "name": "@tsslint/typescript-plugin" }]
  }
}
```

## Writing rules

A rule is a function. It receives the TypeScript module, the current `Program`, the `SourceFile`, and a `report()` callback.

```ts
import { defineRule } from '@tsslint/config';

export default defineRule(({ typescript: ts, file, report }) => {
  ts.forEachChild(file, function visit(node) {
    if (node.kind === ts.SyntaxKind.DebuggerStatement) {
      report('Debugger statement is not allowed.', node.getStart(file), node.getEnd());
    }
    ts.forEachChild(node, visit);
  });
});
```

Touch `program` only when you need type information — rules that don't are cached aggressively (see [Caching](#caching)).

### Severity, fixes, refactors

`report()` returns a chainable reporter:

```ts
report('No console.', node.getStart(file), node.getEnd())
  .asError()                     // default is Message; also: asWarning(), asSuggestion()
  .withDeprecated()              // strikethrough
  .withUnnecessary()             // faded
  .withFix('Remove call', () => [
    { fileName: file.fileName, textChanges: [{ span: { start, length }, newText: '' }] },
  ])
  .withRefactor('Wrap in if (DEBUG)', () => [/* ... */]);
```

`withFix` runs automatically as a quick fix; `withRefactor` shows up under the editor's refactor menu (user-initiated).

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

Diagnostics are cached on disk under `os.tmpdir()/tsslint-cache/`, keyed by file mtime. The cache is shared across rules and survives between editor sessions.

A diagnostic whose correctness depends on more than one file's mtime (e.g. anything that reads `ctx.program` for cross-file resolution and reports on the cached side) should opt out per-diagnostic via `.withoutCache()` on the reporter — the cached entry would otherwise go stale when an unrelated dependency file changes without invalidating its consumers' mtime.

Pass `--force` to the CLI to ignore the cache.

### Debugging

Every `report()` captures a stack trace. The diagnostic carries a "Related Information" link back to the exact line in your rule that triggered it — ⌘-click in the editor to jump there:

```
src/index.ts:3:1
  3 │ debugger;
    │ ~~~~~~~~~ Debugger statement is not allowed. (tsslint)
    │             ↳ rules/no-debugger.ts:5:7   ⌘-click to open
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
| `--vue-project <glob...>` | Vue projects |
| `--vue-vine-project <glob...>` | Vue Vine projects |
| `--mdx-project <glob...>` | MDX projects |
| `--astro-project <glob...>` | Astro projects |
| `--ts-macro-project <glob...>` | TS Macro projects |
| `--filter <glob...>` | Restrict to matching files |
| `--fix` | Apply fixes |
| `--force` | Ignore cache |
| `--failures-only` | Only print diagnostics that affect exit code |
| `-h`, `--help` | |

TSSLint produces diagnostics and edits — it does not format. Run dprint or Prettier after `--fix`.

## Framework support

The `--*-project` flags wire in [Volar](https://volarjs.dev/) language plugins so framework files (Vue SFCs, MDX, Astro components, etc.) are virtualized as TypeScript before linting. Anything `tsserver` can see, TSSLint can lint.

```
   .vue  ──┐
   .mdx  ──┤    ┌──────────────┐    ┌──────────────────┐
   .astro──┼───▶│  Framework   │───▶│     tsserver     │───▶  diagnostics
   .ts   ──┘    │   adapters   │    │                  │      in editor
                │              │    │  TypeChecker     │
                │  ─▶ virtual  │    │       +          │
                │     TS file  │    │  TSSLint plugin  │
                └──────────────┘    └──────────────────┘
```

Each flag resolves the language plugin from your project's `node_modules`, so you must install the corresponding package:

| Flag | Required package(s) |
|---|---|
| `--vue-project` | `@vue/language-core` or `vue-tsc` |
| `--vue-vine-project` | `@vue-vine/language-service` or `vue-vine-tsc` |
| `--mdx-project` | `@mdx-js/language-service` |
| `--astro-project` | `@astrojs/ts-plugin` |
| `--ts-macro-project` | `@ts-macro/language-plugin` or `@ts-macro/tsc` |

## Importing ESLint, TSLint, or TSL rules

### ESLint

```bash
npm install @tsslint/compat-eslint --save-dev
npm install @typescript-eslint/eslint-plugin --save-dev   # for @typescript-eslint/* rules
npx tsslint-docgen                                        # generates JSDoc for IDE autocomplete
```

For each non-built-in rule (`<plugin>/<rule>`), install the matching ESLint plugin (`eslint-plugin-<plugin>` or `@scope/eslint-plugin`).

```ts
import { defineConfig, importESLintRules } from '@tsslint/config';

export default defineConfig({
  rules: {
    ...await importESLintRules({
      'no-unused-vars': true,
      '@typescript-eslint/no-explicit-any': 'warn',
    }),
  },
});
```

### TSLint

```bash
npm install tslint --save-dev      # required for built-in rules
npx tsslint-docgen
```

```ts
import { defineConfig, importTSLintRules } from '@tsslint/config';

export default defineConfig({
  rules: await importTSLintRules({
    'no-console': true,
  }),
});
```

### TSL

```bash
npm install tsl --save-dev
```

```ts
import { defineConfig, fromTSLRules } from '@tsslint/config';
import { core } from 'tsl';

export default defineConfig({
  rules: fromTSLRules(core.all()),
});
```

## Plugins

Plugins can rewrite rules per file, filter diagnostics, and inject code fixes. Three are bundled:

```ts
import {
  defineConfig,
  createIgnorePlugin,
  createCategoryPlugin,
  createDiagnosticsPlugin,
  isCLI,
} from '@tsslint/config';
import ts from 'typescript';

export default defineConfig({
  rules: { /* ... */ },
  plugins: [
    // // tsslint-ignore [rule-id]  — single-line, or *-start / *-end pairs
    createIgnorePlugin('tsslint-ignore', /* report unused */ true),

    // Override severity by rule-id pattern
    createCategoryPlugin({
      'style/*': ts.DiagnosticCategory.Warning,
    }),

    // Forward TypeScript's own diagnostics through the same pipeline.
    // Guard with `isCLI()` — tsserver already surfaces these in editors,
    // so emitting them again from the plugin would double-report there.
    ...(isCLI() ? [createDiagnosticsPlugin('semantic')] : []),
  ],
});
```

Build your own with the `Plugin` type from `@tsslint/types`.

## Requirements

- Node.js **22.6.0+** (uses `--experimental-strip-types` to load `tsslint.config.ts` directly — no transpile step)
- Any TypeScript version with Language Service Plugin support
- Not compatible with `typescript-go` (v7), which does not yet support Language Service Plugins

## License

[MIT](LICENSE)
