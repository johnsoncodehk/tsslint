# TSSLint VS Code Extension

This is the official Visual Studio Code extension for **TSSLint**.

TSSLint is a high-performance, project-centric linter that runs directly as a TypeScript Language Server (`tsserver`) plugin. This architecture allows TSSLint to provide **near-instant diagnostics and fixes** by sharing the existing type-checking context, eliminating the editor lag often experienced in large-scale TypeScript projects.

## Features

*   **Instant Diagnostics**: Violations from your custom TSSLint rules are reported instantly as you type.
*   **Auto Fix on Save**: Supports quick fixes and automatic application of fixes upon saving the file.
*   **Framework Support**: Seamlessly lints TypeScript code within virtual files created by extensions like **Vue Official (Volar)**, **Astro**, and **MDX**.

## Installation

1.  Search for `TSSLint` in the VS Code Extensions Marketplace.
2.  Click **Install**.

## Usage

Once installed, the extension automatically loads the TSSLint plugin into your workspace's TypeScript Language Server.

### 1. Configure Your Project

Ensure you have installed the necessary TSSLint packages and configured your rules in the project root:

```bash
npm install @tsslint/config --save-dev
```

Create your configuration file, `tsslint.config.ts`, in your project root.

### 2. Troubleshooting Node.js Version

TSSLint requires a modern Node.js environment (v22.6.0+ for v3.0+). If your VS Code's default Node.js version is older, the extension may fail to load the plugin.

To fix this, you can configure VS Code to use a specific Node.js executable for the TypeScript Language Server:

1.  Open VS Code Settings (`Ctrl+,` or `Cmd+,`).
2.  Search for `typescript.tsserver.nodePath`.
3.  Set the value to the absolute path of a Node.js 23.6.0+ executable:

```json
{
  "typescript.tsserver.nodePath": "/path/to/node-23.6.0"
}
```

### 3. Disabling the Extension

If you need to temporarily disable TSSLint for a specific workspace, you can:

1.  Go to the Extensions view (`Ctrl+Shift+X` or `Cmd+Shift+X`).
2.  Search for `TSSLint`.
3.  Click the gear icon next to the extension and select **Disable (Workspace)**.

## Development

This extension is primarily a thin wrapper that activates the `@tsslint/typescript-plugin` within VS Code's TypeScript Language Server.

For core TSSLint development (rules, core logic), please refer to the main repository's [README.md](../../README.md).
