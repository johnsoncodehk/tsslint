# @tsslint/typescript-plugin

Registers TSSLint as a `tsserver` language-service plugin. Diagnostics and code fixes flow through the same path as TypeScript's own errors, using the `Program` the editor already built — no second type-check.

## Usage

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

For VS Code, the [TSSLint extension](https://marketplace.visualstudio.com/items?itemName=johnsoncodehk.vscode-tsslint) wires this up automatically.

See the [root README](../../README.md) for rules, config, and framework support.
