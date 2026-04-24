# @tsslint/compat-eslint

Adapter that lets ESLint rules run under TSSLint. Consumed by `importESLintRules` from [`@tsslint/config`](../config).

## Usage

```bash
npm install @tsslint/compat-eslint --save-dev
npm install @typescript-eslint/eslint-plugin --save-dev   # for @typescript-eslint/* rules
```

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

For each `<plugin>/<rule>` you reference, install the matching `eslint-plugin-<plugin>` (or `@scope/eslint-plugin`) package.

See the [root README](../../README.md) for full interop notes, including TSLint and TSL.
