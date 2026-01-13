# TSSLint

<p align="center">
  <img src="logo.png" alt="TSSLint Logo" width="200">
</p>

<p align="center">
  <a href="https://npmjs.com/package/@tsslint/core"><img src="https://badgen.net/npm/v/@tsslint/core" alt="npm package"></a>
  <a href="https://discord.gg/NpdmPEUNjE"><img src="https://img.shields.io/discord/854968233938354226?color=7289DA&label=discord" alt="Discord"></a>
  <a href="https://github.com/johnsoncodehk/tsslint/tree/master/LICENSE"><img src="https://img.shields.io/github/license/johnsoncodehk/tsslint.svg?labelColor=18181B&color=1584FC" alt="License"></a>
</p>

TSSLint 是一個基於 TypeScript Language Server (`tsserver`) 的極簡診斷擴充介面。它不提供任何預設規則，旨在讓開發者能以最低的開銷編寫補充 TypeScript 原生檢查之外的自定義規則。

## 核心特點

*   **零預設 (Zero-config by default)**：內建零規則，不對程式碼風格或規範做任何假設。
*   **高效能**：作為 `tsserver` 插件運行，直接共享已有的 `TypeChecker` 實例，避免重複解析與型別計算。
*   **低干擾**：診斷結果以「訊息 (Message)」類別報告，不干擾原有的編譯錯誤或警告。
*   **直接存取 AST**：規則編寫直接使用 TypeScript 原生 API，無需學習額外的抽象層。

## 運作原理

TSSLint 透過 TypeScript 插件機制整合進 `tsserver`，直接利用編輯器已計算好的語義資訊。

<p align="center">
  <img src="architecture.png" alt="TSSLint Architecture Diagram" width="700">
</p>

## 快速開始

### 1. 安裝

```bash
npm install @tsslint/config --save-dev
```

### 2. 配置 `tsslint.config.ts`

```ts
import { defineConfig } from '@tsslint/config';

export default defineConfig({
  rules: {
    // 在這裡定義或引入規則
  },
});
```

### 3. 編輯器整合

*   **VSCode**: 安裝 [TSSLint 擴充套件](https://marketplace.visualstudio.com/items?itemName=johnsoncodehk.vscode-tsslint)。
*   **其他編輯器**: 在 `tsconfig.json` 中配置：
    ```json
    {
      "compilerOptions": {
        "plugins": [{ "name": "@tsslint/typescript-plugin" }]
      }
    }
    ```

## 編寫規則範例

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

## 擴充功能

### 忽略規則 (Ignore)
```ts
import { defineConfig, createIgnorePlugin } from '@tsslint/config';

export default defineConfig({
  plugins: [
    createIgnorePlugin('tsslint-ignore', true)
  ],
});
```
*使用：在程式碼中使用 `// tsslint-ignore` 註解。*

### 整合現有生態
*   **ESLint**: 透過 `@tsslint/eslint` 轉換規則。
*   **TSLint**: 透過 `@tsslint/tslint` 轉換規則。

## 技術限制

*   **Node.js**: 需 23.6.0+ (v3.0+)。
*   **TypeScript**: 不支援 `typescript-go` (v7)，因其不支援 Language Service Plugins。

## 授權

[MIT](LICENSE)
