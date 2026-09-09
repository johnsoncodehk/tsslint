# Migrating to TSSLint v4

v4 moves the lint engine onto TypeScript 7 and replaces the Volar-based
framework support with TypeScript's own content mapper.

## Breaking changes

### 1. The CLI bundles its own TypeScript engine

`@tsslint/cli` no longer declares `typescript` as a peer dependency. It depends
on [`typescript-native-bridge`](https://github.com/johnsoncodehk/typescript-native-bridge)
(exact-pinned), which keeps the classic `typescript` API surface but runs the
TS 7 (tsgo) checker in-process.

- You no longer need to install or pin `typescript` for linting, and package
  manager overrides that redirected `typescript` to the bridge are no longer
  required for TSSLint itself.
- Diagnostics come from the tsgo checker. On a real project the output can
  differ from TS 6.x in edge cases — that difference is the engine, not a
  TSSLint regression.
- The bridge does not support custom module resolvers or JS custom transformers.
  If your setup remaps imports to different files on disk, those remappings are
  not honoured.

### 2. Framework flags are gone

The Volar integration — and with it the five project flags — has been removed:

| v3 | v4 |
|---|---|
| `tsslint --project tsconfig.json --vue-project tsconfig.json` | declare `contentMappers` in `tsconfig.json`, then `tsslint --project tsconfig.json` |
| `--vue-vine-project`, `--mdx-project`, `--astro-project`, `--ts-macro-project` | same — mapper entries in `tsconfig.json` |

There is no replacement flag; the tsconfig is the single source of truth.

### 3. Platform requirements

- Node.js **22.6.0+** (unchanged) — the bridge itself needs ≥ 20.19.
- **musl-based systems (Alpine) are not supported.** The bridge links a glibc
  native binary; run the lint step in a glibc image and copy results into your
  Alpine deploy stage.
- Peak memory on checker-heavy runs rises to roughly 1.9× the previous engine.

## Framework projects

Framework files are checked through TypeScript 7.1's content mapper. Add the
mapper package for your framework to `tsconfig.json`:

```jsonc
{
  "compilerOptions": { },
  "contentMappers": [
    { "package": "vue-content-mapper", "extensions": [".vue"], "options": { } }
  ],
  "include": ["src"]
}
```

The mapper package declares how it runs in its own `package.json`:

```jsonc
{
  "typescript": {
    "contentMapper": {
      "exec": ["node", "dist/server.js"],
      "compilerOptions": ["module", "jsx", "jsxImportSource"]
    }
  }
}
```

Notes that affect what you can lint:

- Rules run on the transformed TypeScript. Diagnostics and fixes are mapped back
  to the original file through the mapper's span map; **fixes are only offered
  on exact (verbatim) spans**, matching the edit-safety rule `tsc` applies.
- The protocol has no per-diagnostic-code filtering and does not drop diagnostics
  on unmapped (synthetic) regions — both are deliberate design choices upstream.
- `tsc` requires `--runExternalCode` to execute mappers; TSSLint runs them as
  part of loading the project.

**Availability**: content mapper support activates once `typescript-native-bridge`
rebases onto tsgo 7.1. Until then the CLI checks plain TypeScript files only.
Mapper packages per framework follow their own ecosystems' adoption.

## Editors

`@tsslint/typescript-plugin` still targets a classic TypeScript tsserver and is
unaffected by the CLI change. The TS 7 language server path (LSP middleware plus
content mapper registration) is being rebuilt on the TS 7.1 APIs; until that
lands, editor diagnostics for framework files keep using the previous setup.
