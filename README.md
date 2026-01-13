# TSSLint: A Minimalist TS Server Diagnostic Extension Interface

<p align="center">
  <img src="logo.png" alt="TSSLint Logo" width="200">
</p>

<p align="center">
  <a href="https://npmjs.com/package/@tsslint/core"><img src="https://badgen.net/npm/v/@tsslint/core" alt="npm package"></a>
  <a href="https://discord.gg/NpdmPEUNjE"><img src="https://img.shields.io/discord/854968233938354226?color=7289DA&label=discord" alt="Discord"></a>
  <a href="https://github.com/johnsoncodehk/tsslint/tree/master/LICENSE"><img src="https://img.shields.io/github/license/johnsoncodehk/tsslint.svg?labelColor=18181B&color=1584FC" alt="License"></a>
</p>

**TSSLint** is a minimalist diagnostic extension interface for the TypeScript Language Server (`tsserver`), enabling custom code quality rules with efficiency and directness.

## Our Philosophy

TSSLint's design is guided by a philosophy that prioritizes developer experience and minimalist implementation:

1.  **DX-First Rule Authoring**: We believe writing custom rules should be intuitive. By providing direct access to the TypeScript AST, TSSLint empowers developers to author rules with minimal cognitive overhead, valuing developer ease over complex abstractions.
2.  **Minimalist Interface, Not a Framework**: TSSLint is a diagnostic extension interface for `tsserver`, not a full-fledged linter framework. It intentionally avoids complex plugin patterns and comes with **no built-in rules**, offering complete control and transparency to the user.
3.  **Lightest, Not Fastest**: Our goal is to be the lightest linter, not necessarily the fastest. By leveraging the existing `tsserver` instance, TSSLint minimizes resource consumption and avoids redundant type-checking, ensuring a lightweight footprint.
4.  **Preserving Diagnostic Integrity**: TSSLint reports rule violations as messages, not errors or warnings. This design choice maintains the reliability and clarity of TypeScript's native error reporting, preventing signal noise and reducing developer cognitive load.

## How TSSLint Works

TSSLint operates as a TypeScript Language Server Plugin, reusing the `TypeChecker` instance from your editor's `tsserver`. This provides custom diagnostic capabilities without the overhead of separate type-checking processes.

<p align="center">
  <img src="architecture.png" alt="TSSLint Architecture Diagram" width="700">
</p>

## Features

*   **Integrated Diagnostics**: Custom messages directly in your editor via `tsserver`.
*   **TypeScript Configuration**: Rules and configs defined in TypeScript for type safety and autocompletion.
*   **Meta-Framework Friendly**: Supports Vue, Astro, MDX, etc., through underlying TypeScript language services.
*   **Direct Rule Development**: Direct access to TypeScript AST for precise custom rules, prioritizing DX.
*   **Refactor Support**: Supports providing refactor actions (quick fixes) for rule violations.
*   **No Built-in Rules**: TSSLint provides the engine, not the rules. It comes with no built-in rules, giving users complete control to define their own or integrate from external sources like ESLint or TSLint.

## Getting Started

### Using in VSCode

1.  **Install VSCode Extension**: [TSSLint for VSCode](https://marketplace.visualstudio.com/items?itemName=johnsoncodehk.vscode-tsslint)
2.  **Add Dependencies**:
    ```bash
    npm install @tsslint/config --save-dev
    ```
3.  **Create `tsslint.config.ts`** in your project root:
    ```ts
    import { defineConfig } from '@tsslint/config';

    export default defineConfig({
      rules: {
        // Your custom rules or imported rules go here
      },
    });
    ```

### Manual Setup (Other Editors)

For editors other than VSCode, you can configure TSSLint as a TypeScript plugin in your `tsconfig.json`:

1.  **Install Plugin**:
    ```bash
    npm install @tsslint/typescript-plugin --save-dev
    ```
2.  **Configure `tsconfig.json`**:
    ```json
    {
      "compilerOptions": {
        "plugins": [
          {
            "name": "@tsslint/typescript-plugin"
          }
        ]
      }
    }
    ```

## Creating a Custom Rule

TSSLint simplifies custom rule authoring by providing direct access to the TypeScript AST, aligning with our DX philosophy.

**Example: A simple `no-debugger` rule**

```ts
// rules/no-debugger.ts
import { defineRule } from '@tsslint/config';

export default defineRule(({ typescript: ts, file, report }) => {
  ts.forEachChild(file, function cb(node) {
    if (node.kind === ts.SyntaxKind.DebuggerStatement) {
      report(
        'The `debugger` statement is not allowed.',
        node.getStart(file),
        node.getEnd()
      );
    }
    ts.forEachChild(node, cb);
  });
});
```

**Enable the rule in `tsslint.config.ts`**:

```ts
import { defineConfig } from '@tsslint/config';
import noDebuggerRule from './rules/no-debugger';

export default defineConfig({
  rules: {
    'no-debugger': noDebuggerRule,
  },
});
```

## ESLint Compatibility

TSSLint integrates with existing ESLint rules via the `@tsslint/eslint` package, extending its minimalist architecture to the vast ESLint ecosystem.

`defineRules` automatically resolves ESLint plugin names based on standard conventions:
*   **Core Rules**: Rules without a slash (e.g., `for-direction`) are treated as ESLint's built-in core rules.
*   **Plugin Rules**: Rules with a slash (e.g., `@typescript-eslint/await-thenable`) are resolved to their respective ESLint plugins (e.g., `@typescript-eslint/eslint-plugin`).

1.  **Install `@tsslint/eslint` and ESLint plugins**:
    ```bash
    npm install @tsslint/eslint @typescript-eslint/eslint-plugin eslint --save-dev
    ```

2.  **Type Definitions**: `@tsslint/eslint` generates type definitions for `defineRules` via a `postinstall` script. This provides full autocompletion for ESLint rules in your `tsslint.config.ts`.
    *   For **pnpm** users, ensure `postinstall` scripts are allowed (e.g., by setting `onlyBuiltDependencies=false` in `.npmrc`).

3.  **Use `defineRules` in `tsslint.config.ts`**:

    ```ts
    // tsslint.config.ts
    import { defineConfig } from '@tsslint/config';
    import { defineRules } from '@tsslint/eslint';

    export default defineConfig({
      rules: {
        ...await defineRules({
          'for-direction': true,
          'no-debugger': true,
          '@typescript-eslint/await-thenable': true,
          '@typescript-eslint/consistent-type-imports': [
            { disallowTypeAnnotations: false, fixStyle: 'inline-type-imports' },
          ],
        }),
      },
    });
    ```

## TSLint Compatibility

For legacy projects, TSSLint also supports TSLint rules via the `@tsslint/tslint` package.

1.  **Install `@tsslint/tslint`**:
    ```bash
    npm install @tsslint/tslint tslint --save-dev
    ```

2.  **Convert TSLint Rules**:
    ```ts
    import { defineConfig } from '@tsslint/config';
    import { convertRule } from '@tsslint/tslint';
    import { Rule as NoConsoleRule } from 'tslint/lib/rules/noConsoleRule';

    export default defineConfig({
      rules: {
        'no-console': convertRule(NoConsoleRule, ['log', 'error']),
      },
    });
    ```

## CLI Usage

The `@tsslint/cli` package provides a CLI for build processes and CI/CD.

*   **Lint a project**:
    ```bash
    npx tsslint --project path/to/your/tsconfig.json
    ```
*   **Auto-fix errors**:
    ```bash
    npx tsslint --project path/to/your/tsconfig.json --fix
    ```
*   **Lint multiple projects** (e.g., Vue, Astro):
    ```bash
    npx tsslint --project 'packages/*/tsconfig.json' --vue-project 'apps/web/tsconfig.json'
    ```

## Technical Considerations

1.  **Node.js 23.6.0+ Requirement (v3.0+)**: `tsslint.config.ts` is now directly imported, requiring Node.js 23.6.0+. For VSCode, you may need to set `typescript.tsserver.nodePath` to a local Node.js v23.6.0+ installation or use TSSLint v2.
2.  **TypeScript v7 (typescript-go) Incompatibility**: `typescript-go` does not support Language Service Plugins, so TSSLint will not function in IDEs using it.
3.  **Rules API Performance**: Direct AST traversal may be slower than optimized node visitors in other linters, but this cost is generally negligible compared to the type-checking time saved.

## Contributing

We welcome contributions! Please feel free to open an issue or submit a pull request.

## License

[MIT](LICENSE)
