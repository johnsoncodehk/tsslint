# Migrating to TSSLint v4

v4 runs on TypeScript 7 only. Rules see the TypeScript 7 AST (`typescript/ast`)
and the TypeScript 7 checker (`typescript/sync`), and framework files are linted
through TypeScript's own content mapper instead of Volar language plugins.

## Breaking changes

### 1. TypeScript 7 is bundled as a dependency

TSSLint depends on TypeScript 7 directly, so there is nothing extra to
install, and it does not use the `typescript` your project compiles with.
There is no TypeScript 5/6 code path and no compatibility layer.

- Node.js **22.15.0+** is required (the `typescript` 7 package needs 22.12, and the
  CLI cache tracks the modules your config imports with `Module.registerHooks`,
  added in 22.15).
- Diagnostics come from the TypeScript 7 checker. Output can differ from
  TypeScript 5/6 in edge cases; that difference is the engine, not a TSSLint
  regression.

### 2. Rule context

| v3 | v4 |
|---|---|
| `typescript` — the classic `typescript` module | `typescript` — the `typescript/ast` module (`SyntaxKind`, `is*` guards, AST utilities) |
| `program` — `ts.Program` | `program` — `Program` from `typescript/sync` |
| `program.getTypeChecker()` | `checker` — `Checker` from `typescript/sync` |
| `ts.forEachChild(node, cb)` | `node.forEachChild(cb)` |
| `ts.sys`, `ts.findConfigFile`, … | use `node:fs` / `node:path` |

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

Results use TypeScript 7.1's own types. A rule report is a `Diagnostic` from
`typescript/sync` (`pos`, `end`, `text`) plus a `ruleId`, and `withFix` /
`withRefactor` callbacks return `TextEdit[]` (`{ pos, end, newText }`) for the
reported file. Plugin `resolveDiagnostics` and `resolveCodeFixes` receive the
lint target (`{ program, checker, file }`) instead of the file.

### 3. Removed packages and importers

- `@tsslint/typescript-plugin` and the VS Code extension are removed. TypeScript 7
  has no tsserver plugin API.
- `importTSLintRules` and `fromTSLRules` are removed. Both depend on the classic
  `typescript` API.

### 4. Framework flags are replaced by `contentMappers`

| v3 | v4 |
|---|---|
| `tsslint --project tsconfig.json --vue-project tsconfig.json` | declare `contentMappers` in `tsconfig.json`, then `tsslint --project tsconfig.json` |
| `--vue-vine-project`, `--mdx-project`, `--astro-project`, `--ts-macro-project` | same — mapper entries in `tsconfig.json` |

See [Framework projects](#framework-projects).

### 5. Caching

The cache format is bumped, so the first v4 run re-lints everything.

Rules are no longer split into syntactic and type-aware. Each file's result is
reused until the file changes or a file it depends on changes its declaration
signature, like `tsc --incremental`, or the text of a file a rule read beyond
its declarations changes. Changes that can affect any file (compiler options,
config and rule modules, the declarations of globals) re-lint everything. See
[Caching](../README.md#caching). `--list-rules` is removed, since there is no
classification left to print.

`Reporter.withoutCache()` is removed. Rules must only depend on the program;
inputs outside it (`fs`, environment variables) are not tracked, and `--force`
re-lints every file.

### 6. ESLint interop

`importESLintRules` still works for ESLint core rules and for plugins that
don't import `typescript`.

`@typescript-eslint/eslint-plugin` does not load with `typescript@7`: its
dependencies read the classic `typescript` API at module load. Remove
`@typescript-eslint/*` rules from the config until typescript-eslint supports
TypeScript 7.

### 7. `@tsslint/core` API

Only relevant if you embed the linter directly:

- `createLinter(ctx, rootDir, config, …)` takes
  `ctx: { typescript: typeof import('typescript/ast') }`.
- `linter.lint(target, …)` takes `target: { program, checker, file }` instead of a
  file name.
- `applyTextEdits(text, edits)` works on strings.
- `linter.getTouchedFiles(fileName)` lists the other files the rules read beyond
  their declarations during the last `lint` of the file.

## Framework projects

Framework files are linted through TypeScript 7.1's content mapper. Add the
mapper for your framework to `tsconfig.json`:

```jsonc
{
  "compilerOptions": { },
  "contentMappers": [
    { "package": "@vue/content-mapper", "extensions": [".vue"], "options": { } }
  ],
  "include": ["src"]
}
```

`package` is resolved through `node_modules`. The mapper package declares how it
runs in its own `package.json`:

```jsonc
{
  "typescript": {
    "contentMapper": {
      "exec": ["node", "server.js"],
      "dynamicConfig": true
    }
  }
}
```

What this means for rules:

- Rules run on the transformed TypeScript (`file.text`); `file.fileName` is the
  original file. Report positions in the transformed text.
- Diagnostics are mapped back to the original file through the mapper's span map.
  Diagnostics that only cover generated code are dropped.
- `--fix` applies a fix only when every edit in it maps exactly onto original
  text. Other fixes are skipped.
- TSSLint runs mappers as part of loading the project; there is no equivalent of
  `tsc --runExternalCode` to pass.
