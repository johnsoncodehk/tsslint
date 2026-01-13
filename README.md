# TSSLint: A Minimalist TS Server Diagnostic Extension Interface

<p align="center">
  <img src="logo.png" alt="TSSLint Logo" width="200">
</p>

<p align="center">
  <a href="https://npmjs.com/package/@tsslint/core"><img src="https://badgen.net/npm/v/@tsslint/core" alt="npm package"></a>
  <a href="https://discord.gg/NpdmPEUNjE"><img src="https://img.shields.io/discord/854968233938354226?color=7289DA&label=discord" alt="Discord"></a>
  <a href="https://github.com/johnsoncodehk/tsslint/tree/master/LICENSE"><img src="https://img.shields.io/github/license/johnsoncodehk/tsslint.svg?labelColor=18181B&color=1584FC" alt="License"></a>
</p>

TSSLint 是一個輕量級的診斷擴充介面，它直接在 TypeScript Language Server (`tsserver`) 內部運行。這讓你可以編寫自定義的程式碼品質規則，同時避免了運行獨立 Linter 或重複執行型別檢查的額外開銷。

## Why TSSLint?

TSSLint 的設計基於幾個核心理念：

*   **重用型別檢查器 (Type Checker)**：作為 `tsserver` 插件運行，TSSLint 重複利用了 TypeScript 編譯器已有的型別資訊。這使其極為快速和輕量。
*   **DX 優先的規則編寫**：規則編寫非常簡單。你可以直接存取 TypeScript AST，輕鬆編寫精確的規則，減少樣板程式碼。
*   **僅是介面，而非框架**：TSSLint 僅提供運行引擎，**沒有內建規則**。你需要引入自己的規則，或整合來自 ESLint/TSLint 的現有規則。
*   **乾淨的診斷輸出**：規則違規會以普通訊息 (message) 報告，而非錯誤 (error) 或警告 (warning)，確保編輯器的錯誤面板保持乾淨，專注於真正的 TypeScript 問題。

## How TSSLint Works

TSSLint 作為一個 TypeScript Language Server Plugin 運行，它重用了編輯器 `tsserver` 中的 `TypeChecker` 實例。這提供了自定義診斷能力，且沒有獨立型別檢查流程的額外負擔。

<p align="center">
  <img src="architecture.png" alt="TSSLint Architecture Diagram" width="700">
</p>

## Features

*   **整合式診斷**：規則訊息直接在編輯器中顯示。
*   **型別安全配置**：配置檔 `tsslint.config.ts` 提供完整的型別安全和自動補全。
*   **框架友好**：支援 Vue, Astro, MDX 等，只要底層有 TypeScript 語言服務即可。
*   **快速修復**：支援為規則違規提供重構動作 (Refactor Actions) 和快速修復 (Quick Fixes)。

## Getting Started

### 1. 安裝核心依賴

```bash
npm install @tsslint/config --save-dev
```

### 2. 建立配置檔

在專案根目錄建立 `tsslint.config.ts`：

```ts
import { defineConfig } from '@tsslint/config';

export default defineConfig({
  rules: {
    // 你的自定義規則或引入的規則
  },
});
```

### 3. 編輯器整合

#### VSCode

安裝 [TSSLint for VSCode 擴充套件](https://marketplace.visualstudio.com/items?itemName=johnsoncodehk.vscode-tsslint) 即可。

#### 其他編輯器 (手動設定)

對於其他編輯器，你可以將 TSSLint 配置為 TypeScript 插件：

1.  **安裝插件**:
    ```bash
    npm install @tsslint/typescript-plugin --save-dev
    ```
2.  **配置 `tsconfig.json`**:
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

TSSLint 讓自定義規則的編寫變得簡單，你可以直接存取 TypeScript AST。

**範例：一個簡單的 `no-debugger` 規則**

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

**在 `tsslint.config.ts` 中啟用規則**：

```ts
import { defineConfig } from '@tsslint/config';
import noDebuggerRule from './rules/no-debugger';

export default defineConfig({
  rules: {
    'no-debugger': noDebuggerRule,
  },
});
```

## 忽略規則 (Ignoring Rules)

TSSLint 透過插件系統支援忽略規則。你可以使用內建的 `createIgnorePlugin` 來配置自定義的忽略指令。

### 配置插件

在 `tsslint.config.ts` 中加入 `plugins` 配置：

```ts
import { defineConfig, createIgnorePlugin } from '@tsslint/config';

export default defineConfig({
  rules: {
    // ... rules
  },
  plugins: [
    createIgnorePlugin('tsslint-ignore', true), // 指令名稱, 是否報告未使用的註解
  ],
});
```

### 使用方式

在程式碼中使用註解來忽略特定的診斷訊息：

```ts
// tsslint-ignore
debugger;

// tsslint-ignore no-debugger
debugger;
```

如果註解位於行首，它會忽略**下一行**的錯誤。雖然技術上支援行尾註解，但建議使用行首註解以保持一致性，且自動修復功能會將註解插入到行首。

## 整合現有規則

### ESLint 兼容性

透過 `@tsslint/eslint` 套件，你可以將龐大的 ESLint 生態系統整合到 TSSLint 中。

1.  **安裝依賴**:
    ```bash
    npm install @tsslint/eslint @typescript-eslint/eslint-plugin eslint --save-dev
    ```

2.  **使用 `defineRules`**:
    `defineRules` 會自動解析 ESLint 插件名稱，並提供完整的型別安全和規則自動補全。

    ```ts
    // tsslint.config.ts
    import { defineConfig } from '@tsslint/config';
    import { defineRules } from '@tsslint/eslint';

    export default defineConfig({
      rules: {
        ...await defineRules({
          // 核心規則
          'for-direction': true,
          // 插件規則
          '@typescript-eslint/await-thenable': true,
          // 帶選項的規則
          '@typescript-eslint/consistent-type-imports': [
            { disallowTypeAnnotations: false, fixStyle: 'inline-type-imports' },
          ],
        }),
      },
    });
    ```

### TSLint 兼容性

對於舊專案，TSSLint 也支援透過 `@tsslint/tslint` 套件轉換 TSLint 規則。

1.  **安裝依賴**:
    ```bash
    npm install @tsslint/tslint tslint --save-dev
    ```

2.  **轉換規則**:
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

`@tsslint/cli` 套件提供了用於建構流程和 CI/CD 的命令列工具。

*   **Lint 專案**:
    ```bash
    npx tsslint --project path/to/your/tsconfig.json
    ```
*   **自動修復**:
    ```bash
    npx tsslint --project path/to/your/tsconfig.json --fix
    ```
*   **Lint 多個專案** (例如 Vue, Astro):
    ```bash
    npx tsslint --project 'packages/*/tsconfig.json' --vue-project 'apps/web/tsconfig.json'
    ```

## Technical Notes

1.  **Node.js 23.6.0+ (v3.0+)**: `tsslint.config.ts` 現在是直接導入的，需要 Node.js 23.6.0+。
2.  **TypeScript v7 (typescript-go) 不兼容**: `typescript-go` 不支援 Language Service Plugins，因此 TSSLint 無法在採用它的 IDE 中運行。

## Contributing

歡迎貢獻！請隨時開啟 Issue 或提交 Pull Request。

## License

[MIT](LICENSE)
