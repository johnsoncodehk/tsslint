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

TSSLint is probably the smallest linter implementation ever. Built on the TypeScript Language Server (`tsserver`), it provides a minimalist diagnostic extension interface with zero default rules, allowing developers to implement custom rules with minimal overhead.

## Motivation

TSSLint is the **spiritual successor to TSLint**. We believe that **direct integration with native TypeScript APIs** is the most efficient way to lint TypeScript code.

General-purpose linters like ESLint, while powerful, operate as separate processes and often need to re-initialize type-checking context. This leads to a significant pain point in large-scale projects: **editor lag during "Auto Fix on Save"**.

TSSLint solves this by running directly as a `tsserver` plugin. By sharing the existing `TypeChecker` and operating on the native TypeScript AST (without ESTree/ES parser conversion), TSSLint provides **near-instant diagnostics and fixes**.

## Key Features

*   **Project-Centric**: Treats the **Project (tsconfig)** as a first-class citizen, enabling efficient cross-file type analysis and superior Monorepo support.
*   **High Performance**: Runs as a `tsserver` plugin, sharing the existing `TypeChecker` to provide near-instant diagnostics without redundant parsing.
*   **Minimalist Implementation**: Probably the smallest linter ever. Zero built-in rules and minimal code overhead by leveraging native TypeScript infrastructure.
*   **Rule Traceability**: Built-in debugging support. Jump from a reported error directly to the exact line in your **rule's source code** that triggered it.

## How It Works

TSSLint integrates into `tsserver` via the TypeScript plugin system, leveraging the semantic information already computed by your editor. Operating at the project level ensures accurate and performant diagnostics.

<p align="center">
  <img src="architecture.png" alt="TSSLint Architecture Diagram" width="700">
</p>

### Framework Support (Vue, MDX, Astro, etc.)

Since TSSLint operates directly within `tsserver`, it supports any framework that integrates with the TypeScript plugin system.

Tools like **Vue Official (Volar)**, **MDX**, or **Astro** virtualize non-TypeScript files into virtual TypeScript source files for `tsserver`. TSSLint seamlessly accesses and lints the TypeScript code within these virtual files without any additional configuration.

<p align="center">
  <img src="architecture_v2.png" alt="TSSLint Framework Support Diagram" width="700">
</p>

## Getting Started

### 1. Install

```bash
npm install @tsslint/config --save-dev
```

### 2. Configure `tsslint.config.ts`

A minimal configuration looks like this. For a complete example, see the [vuejs/language-tools tsslint.config.ts](https://github.com/vuejs/language-tools/blob/master/tsslint.config.ts).

```ts
import { defineConfig } from '@tsslint/config';

export default defineConfig({
  rules: {
    // Define or import your rules here
  },
});
```

### 3. Editor Integration

*   **VSCode**: 
    1. Install the [TSSLint extension](https://marketplace.visualstudio.com/items?itemName=johnsoncodehk.vscode-tsslint).
    2. (Optional) If you encounter issues importing `tsslint.config.ts` due to Node.js version mismatches, you can configure `typescript.tsserver.nodePath` to point to a Node.js 23.6.0+ executable.
*   **Other Editors**: Configure TSSLint as a plugin in your `tsconfig.json`:
    ```json
    {
      "compilerOptions": {
        "plugins": [{ "name": "@tsslint/typescript-plugin" }]
      }
    }
    ```

## Rule Authoring

### Rule Example

```ts
// rules/no-debugger.ts
import { defineRule } from '@tsslint/config';

export default defineRule(({ typescript: ts, file, report }) => {
  ts.forEachChild(file, function cb(node) {
    if (node.kind === ts.SyntaxKind.DebuggerStatement) {
      report(
        'Debugger statement is not allowed.',
        node.getStart(file),
        node.getEnd()
      );
    }
    ts.forEachChild(node, cb);
  });
});
```

### Rule Caching Mechanism


TSSLint's high performance comes from its intelligent caching strategy, which automatically distinguishes between **Syntax-Aware** and **Type-Aware** rules.

All rule diagnostics are cached by default. The cache is automatically disabled for a rule in two scenarios:

1.  **Type-Aware Detection**: If a rule accesses `RuleContext.program` (e.g., to check types), TSSLint detects it as Type-Aware. The cache for this rule is then automatically managed and invalidated to ensure accuracy.
2.  **Manual Exclusion**: A rule can explicitly prevent a specific diagnostic from being cached by calling `report().withoutCache()`.

This automatic differentiation maximizes performance for simple syntax rules while maintaining correctness for complex type-aware rules.

### Rule Debugging & Traceability (The `.at()` Magic)

TSSLint is designed to make rule debugging trivial. Every time you call `report()`, TSSLint automatically captures the current JavaScript stack trace and attaches it to the diagnostic as **Related Information**.

This means: **You can click on the diagnostic in your editor and jump directly to the line in your rule's source code that triggered the report.**

<p align="center">
  <img src="traceability.png" alt="TSSLint Rule Traceability Demo" width="700">
</p>

The `.at()` method is generally not needed, but is provided for advanced scenarios where you wrap `report()` in a helper function and need to adjust the stack depth to point to the correct logic:

```ts
// Example of advanced usage to adjust stack depth
report('message', start, end)
  .at(new Error(), 2) // Adjusts the stack index to skip the helper function's frame
  .withFix(...);
```

## CLI Usage

The `@tsslint/cli` package provides a command-line tool for CI/CD and build processes.

```bash
# Lint a project
npx tsslint --project path/to/tsconfig.json

# Auto-fix violations
npx tsslint --project path/to/tsconfig.json --fix

# Lint multiple projects
npx tsslint --project packages/*/tsconfig.json --vue-project apps/web/tsconfig.json

# Using brace expansion for multiple patterns
npx tsslint --project {tsconfig.json,packages/*/tsconfig.json,extensions/*/tsconfig.json}
```

> [!TIP]
> TSSLint focuses on diagnostic fixes and does not include a built-in formatter. It is recommended to run a dedicated formatter like **Prettier**, **dprint**, or **oxfmt** after running TSSLint with `--fix`.

## Extensions & Ecosystem

### Ignoring Rules
```ts
import { defineConfig, createIgnorePlugin } from '@tsslint/config';

export default defineConfig({
  rules: {
    ...
  },
  plugins: [
    createIgnorePlugin('tsslint-ignore', true)
  ],
});
```
*Usage: Use `// tsslint-ignore` comments in your code.*

### Ecosystem Integration

TSSLint provides compatibility layers for existing linter ecosystems (ESLint, TSLint, and TSL). These integrations are coordinated through `@tsslint/config`, which acts as a bridge to load rules from other linters.

To use a compatibility layer, you must install the corresponding TSSLint compatibility package. If you wish to use the original linter's built-in rules, you must also install the original linter package itself.

#### 1. ESLint

**Installation:**

First, install the TSSLint compatibility package for ESLint.

```bash
npm install @tsslint/compat-eslint --save-dev
```

If you want to use ESLint's built-in rules (e.g., `no-unused-vars`), you must also install `eslint` (optional):

```bash
npm install eslint --save-dev
```

**Type Definition Update:**

After installing the original linter package, run the following command to update JSDoc for built-in rules, enabling better IDE support:

```bash
npx tsslint-config-update
```

**Usage in `tsslint.config.ts`:**

Use `importESLintRules` to load rules. This function automatically resolves and loads rules from ESLint plugins (e.g., `@typescript-eslint/eslint-plugin`) by searching your `node_modules`. Plugin rules are identified by their prefix (e.g., `@typescript-eslint/`).

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

#### 2. TSLint

**Installation:**

If you want to use TSLint's built-in rules, you need to install `tslint` (optional):

```bash
npm install tslint --save-dev
```

**Type Definition Update:**

After installing `tslint`, run the following command to update JSDoc for built-in rules:

```bash
npx tsslint-config-update
```

**Usage in `tsslint.config.ts`:**

Use `importTSLintRules` to load rules. This function automatically reads `rulesDirectory` from your `tslint.json` to support third-party TSLint plugins.

```ts
import { defineConfig, importTSLintRules } from '@tsslint/config';

export default defineConfig({
  rules: {
    ...await importTSLintRules({
      'no-console': true,
      'member-ordering': [true, { order: 'fields-first' }],
    }),
  },
});
```

#### 3. TSL

**Installation:**

TSL rules are imported directly from the `tsl` package.

```bash
npm install tsl --save-dev
```

**Usage in `tsslint.config.ts`:**

Use `fromTSLRules` to load TSL rules.

```ts
import { defineConfig, fromTSLRules } from '@tsslint/config';
import { core } from 'tsl';

export default defineConfig({
	rules: fromTSLRules(core.all()),
});
```

## Technical Notes

*   **Node.js**: Requires 22.6.0+ (v3.0+).
*   **TypeScript**: Incompatible with `typescript-go` (v7) as it does not support Language Service Plugins.

## License

[MIT](LICENSE)
