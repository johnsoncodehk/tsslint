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

A linter that runs inside `tsserver`. No separate process, no re-parsing, no ESTree conversion. It uses the TypeChecker your editor already has.

Zero built-in rules. You write what you need with the full TypeScript compiler API.

## Why?

ESLint works, but it runs separately and sets up its own type-checking. On large projects, "Auto Fix on Save" gets laggy.

TSSLint avoids this by running as a `tsserver` plugin. It reuses the existing TypeChecker, works on native TypeScript AST, and skips the parser conversion layer.

<p align="center">
  <img src="architecture.png" alt="TSSLint Architecture" width="700">
</p>

## Setup

```bash
npm install @tsslint/config --save-dev
```

Create `tsslint.config.ts`:

```ts
import { defineConfig } from '@tsslint/config';

export default defineConfig({
  rules: {
    // your rules here
  },
});
```

**VSCode**: Install the [TSSLint extension](https://marketplace.visualstudio.com/items?itemName=johnsoncodehk.vscode-tsslint).

**Other editors**: Add the plugin to `tsconfig.json`:

```json
{
  "compilerOptions": {
    "plugins": [{ "name": "@tsslint/typescript-plugin" }]
  }
}
```

## Writing Rules

```ts
import { defineRule } from '@tsslint/config';

export default defineRule(({ typescript: ts, file, report }) => {
  ts.forEachChild(file, function cb(node) {
    if (node.kind === ts.SyntaxKind.DebuggerStatement) {
      report('Debugger statement is not allowed.', node.getStart(file), node.getEnd());
    }
    ts.forEachChild(node, cb);
  });
});
```

For a real-world example, see [vuejs/language-tools tsslint.config.ts](https://github.com/vuejs/language-tools/blob/master/tsslint.config.ts).

### Caching

Diagnostics are cached by default. The cache invalidates automatically when:

1. A rule accesses `RuleContext.program` (type-aware rules)
2. A rule calls `report().withoutCache()`

### Debugging

Every `report()` captures a stack trace. Click the diagnostic in your editor to jump to the exact line in your rule that triggered it.

<p align="center">
  <img src="traceability.png" alt="Rule Traceability" width="700">
</p>

## CLI

```bash
npx tsslint --project tsconfig.json
npx tsslint --project tsconfig.json --fix
npx tsslint --project packages/*/tsconfig.json
```

Run `npx tsslint --help` for all options.

TSSLint only does diagnostics and fixes. Run Prettier or dprint after `--fix`.

## Framework Support

TSSLint works with Vue, MDX, Astro, and anything else that plugs into tsserver. These tools virtualize their files as TypeScript for tsserver. TSSLint just sees and lints that TypeScript.

<p align="center">
  <img src="architecture_v2.png" alt="Framework Support" width="700">
</p>

## Using ESLint/TSLint Rules

You can load rules from ESLint and TSLint through compatibility layers.

### ESLint

```bash
npm install @tsslint/compat-eslint --save-dev
npm install eslint --save-dev  # optional, for built-in rules
npx tsslint-docgen              # generates JSDoc for IDE support
```

```ts
import { defineConfig, importESLintRules } from '@tsslint/config';

export default defineConfig({
  rules: {
    ...await importESLintRules({
      'no-unused-vars': true,
      '@typescript-eslint/no-explicit-any': true,
    }),
  },
});
```

### TSLint

```bash
npm install tslint --save-dev  # optional, for built-in rules
npx tsslint-docgen
```

```ts
import { defineConfig, importTSLintRules } from '@tsslint/config';

export default defineConfig({
  rules: {
    ...await importTSLintRules({
      'no-console': true,
    }),
  },
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

## Ignoring Rules

```ts
import { defineConfig, createIgnorePlugin } from '@tsslint/config';

export default defineConfig({
  rules: { ... },
  plugins: [createIgnorePlugin('tsslint-ignore', true)],
});
```

Then use `// tsslint-ignore` comments in your code.

## Notes

- Requires Node.js 22.6.0+
- Not compatible with typescript-go (v7) - it doesn't support Language Service Plugins

## License

[MIT](LICENSE)
