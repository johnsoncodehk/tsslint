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

TSSLint is a minimalist diagnostic extension interface built on the TypeScript Language Server (`tsserver`). It provides zero default rules, allowing developers to implement custom rules that complement TypeScript's native checks with minimal overhead.

## Motivation

TSSLint was created to solve a specific pain point: **editor lag during "Auto Fix on Save"**.

In large-scale TypeScript projects, traditional linters (like ESLint) often cause noticeable delays when performing auto-fixes on save, as they frequently need to re-initialize type-checking or run in separate processes. By running directly as a `tsserver` plugin and sharing the existing type-checking context, TSSLint provides near-instant diagnostics and fixes, ensuring a smooth and uninterrupted development experience.

## Key Features

*   **Zero Assumptions**: Comes with no built-in rules. It does not enforce any specific coding style or patterns, leaving full control to the developer.
*   **High Performance**: Runs as a `tsserver` plugin, sharing the existing `TypeChecker` instance to avoid redundant parsing and type-checking.
*   **Low Noise**: Violations are reported as "Message" diagnostics, ensuring they don't interfere with actual compiler errors or warnings.
*   **Direct AST Access**: Rule authoring uses native TypeScript APIs directly, without unnecessary abstraction layers.

## How It Works

TSSLint integrates into `tsserver` via the TypeScript plugin system, leveraging the semantic information already computed by your editor.

<p align="center">
  <img src="architecture.png" alt="TSSLint Architecture Diagram" width="700">
</p>

### Framework Support (Vue, MDX, Astro, etc.)

Since TSSLint operates directly within `tsserver`, it naturally supports any framework that integrates with the TypeScript plugin system.

In editors like VSCode, when using extensions like **Vue Official (Volar)**, **MDX**, or **Astro**, these tools virtualize non-TypeScript files (like `.vue`, `.mdx`, or `.astro`) into virtual TypeScript source files for `tsserver`. Because TSSLint is a `tsserver` plugin, it can seamlessly access and lint the TypeScript code within these virtual files without any additional configuration.

<p align="center">
  <img src="architecture_v2.png" alt="TSSLint Framework Support Diagram" width="700">
</p>

## Getting Started

### 1. Install

```bash
npm install @tsslint/config --save-dev
```

### 2. Configure `tsslint.config.ts`

A minimal configuration looks like this. For a complete, real-world example, see the [vuejs/language-tools tsslint.config.ts](https://github.com/vuejs/language-tools/blob/master/tsslint.config.ts).

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
    2. (Optional) If you encounter issues importing `tsslint.config.ts` due to Node.js version mismatches, you can configure `typescript.tsserver.nodePath` to point to a Node.js 23.6.0+ executable:
       ```json
       {
         "typescript.tsserver.nodePath": "/path/to/node-23.6.0"
       }
       ```
*   **Other Editors**: Configure TSSLint as a plugin in your `tsconfig.json`:
    ```json
    {
      "compilerOptions": {
        "plugins": [{ "name": "@tsslint/typescript-plugin" }]
      }
    }
    ```

## Rule Example

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

> [!NOTE]
> The brace expansion pattern (`{a,b}`) is handled by your shell (e.g., bash, zsh) before the command is executed. The CLI receives a list of arguments.
> 
> For glob patterns (`*`), TSSLint uses an internal `glob` library to ensure cross-platform compatibility (especially on Windows) and to support advanced features like file watching, where the original pattern is needed.
> 
> **CLI Caching**: The CLI uses a file system cache to speed up subsequent runs. The cache files are stored in your operating system's temporary directory (`os.tmpdir()`) to avoid polluting your project's file system. The cache is automatically invalidated when the project's `tsslint.config.ts` or the CLI arguments change.
```

> [!TIP]
> TSSLint focuses on diagnostic fixes and does not include a built-in formatter. It is recommended to run a dedicated formatter like **Prettier**, **dprint**, or **oxfmt** after running TSSLint with `--fix`.

## Extensions

### Ignoring Rules
```ts
import { defineConfig, createIgnorePlugin } from '@tsslint/config';

export default defineConfig({
  plugins: [
    createIgnorePlugin('tsslint-ignore', true)
  ],
});
```
*Usage: Use `// tsslint-ignore` comments in your code.*

### Ecosystem Integration
*   **ESLint**: Convert rules via `@tsslint/eslint`.
*   **TSLint**: Convert rules via `@tsslint/tslint`.

## Technical Notes

*   **Node.js**: Requires 22.6.0+ (v3.0+).
*   **TypeScript**: Incompatible with `typescript-go` (v7) as it does not support Language Service Plugins.

## License

[MIT](LICENSE)
