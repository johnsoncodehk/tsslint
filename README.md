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
| Type-aware rules | Yes (its own `Program`) | Yes (its own `Program`) | Yes (via `tsgolint`, alpha) | Yes (shared `TypeChecker`; CLI `--tsgo` beta uses ts-go shim) |
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

Diagnostics are cached on disk under `os.tmpdir()/tsslint-cache/` in two layers, picked per rule:

- **Layer 1** — invalidated by the linted file's mtime. Used for rules that don't read `ctx.program` (purely syntactic).
- **Layer 2** — invalidated by TypeScript's `BuilderProgram` affected-file diff (transitive, includes ambient `.d.ts`). Used for rules that touch `ctx.program`. The first time a rule reads `ctx.program` it's classified type-aware and stays type-aware across sessions.

A diagnostic whose correctness depends on inputs neither layer tracks — external resources, env vars, sibling files the rule reads directly via `fs` — should opt out per-diagnostic via `.withoutCache()` on the reporter. The diagnostic still surfaces on the current run; it just isn't written to disk, so the next warm hit on this file won't replay it (the rule has to re-run to surface it again).

For diagnostics that depend on cross-file types, prefer reading `ctx.program` once instead — that re-classifies the rule type-aware and layer 2 handles invalidation properly.

Pass `--force` to the CLI to ignore the cache. `--list-rules` prints each rule's classification (type-aware vs syntactic) after the run.

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
| `--tsgo` | Use `@typescript/native-preview` (ts-go) as the type backend — plain `--project` only; see [ts-go backend](#ts-go-backend-cli) |
| `--tsgo-fast` | With `--tsgo`: always use the fast path (skip disk cache, eager-prepare) |
| `--no-tsgo-fast` | With `--tsgo`: disable auto fast path on multi-file projects |
| `-h`, `--help` | |

TSSLint produces diagnostics and edits — it does not format. Run dprint or Prettier after `--fix`.

### ts-go backend (CLI)

The default CLI path uses the Node `typescript` package (**Strada**). For plain TypeScript projects you can opt into the Go-based compiler via [`@typescript/native-preview`](https://www.npmjs.com/package/@typescript/native-preview):

```bash
npm install @typescript/native-preview --save-dev   # optional peer of @tsslint/cli
npx tsslint --project tsconfig.json --tsgo
```

| | Strada (default) | `--tsgo` |
|---|---|---|
| Runtime | Node `typescript` in-process | `tsgo` child process + TypeScript API shim |
| Framework flags | Vue / MDX / Astro / … | Not supported — `--project` only |
| Multi-file | Layer 1 + 2 disk cache | Skip layer-1 cache; **one tsgo child** reused across `--project` entries via `updateSnapshot` |
| `--tsgo-fast` | — | Also eager-prepare all files at setup (opt-in; can regress type-heavy runs) |
| Editor plugin | N/A (CLI) | N/A — `tsserver` plugin still requires Strada today |

On this repo (ts-eslint type-aware, ~37 files in `packages/{cli,core,config}`): Strada ~1.6–3s, `--tsgo` ~1.8–2s. Full monorepo (~59 files, 8 tsconfigs): Strada ~4–8s, `--tsgo` ~6–11s (IPC-bound on compat-eslint); shared child + lazy prepare helps multi-`--project` runs.

Dogfood (`pnpm run lint` vs `pnpm run lint:tsgo -- --force` on this monorepo): Strada **76 passed** / 1 message; `--tsgo` **68 passed** / 24 messages. Shim sources (`tsgo-*.ts`) are scoped out of `no-unnecessary-type-assertion` (tsgo vs Strada checker disagree on assertion necessity). Remaining gap is the same rule firing on other files under the tsgo checker only.

Rules still author against the TypeScript compiler API; the shim translates ts-go's checker into `ts.Program` / `ts.TypeChecker` shapes. See `packages/poc-tsgo/` for a minimal parity/benchmark harness (`pnpm run poc:tsgo`, `pnpm run bench:tsgo`).

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
- **`@tsslint/typescript-plugin` (editor)**: requires the Node `typescript` package — not compatible with `typescript-go` / ts-go, which does not yet support Language Service Plugins
- **`@tsslint/cli --tsgo` (beta)**: optional `@typescript/native-preview` peer for the Go compiler backend on plain `--project` runs; see [ts-go backend](#ts-go-backend-cli)

## License

[MIT](LICENSE)
