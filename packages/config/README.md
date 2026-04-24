# @tsslint/config

Public API for `tsslint.config.ts`: `defineConfig`, `defineRule`, `definePlugin`, bundled plugin factories (`createIgnorePlugin`, `createCategoryPlugin`, `createDiagnosticsPlugin`), and importers for ESLint / TSLint / TSL rules.

## Usage

```bash
npm install @tsslint/config --save-dev
```

```ts
import { defineConfig } from '@tsslint/config';

export default defineConfig({
  rules: {
    'no-debugger': ({ typescript: ts, file, report }) => {
      ts.forEachChild(file, function visit(node) {
        if (node.kind === ts.SyntaxKind.DebuggerStatement) {
          report('Debugger statement is not allowed.', node.getStart(file), node.getEnd());
        }
        ts.forEachChild(node, visit);
      });
    },
  },
});
```

`defineRule` / `definePlugin` are available for authoring rules or plugins in their own files, where the context type can't be inferred from the surrounding config.

The package also ships a `tsslint-docgen` binary that generates JSDoc for imported ESLint/TSLint rules so they autocomplete in your config.

See the [root README](../../README.md) for rule authoring, ESLint/TSLint/TSL interop, plugins, and caching.
