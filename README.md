# TSSLint

<p align="center">
  <img src="logo.png" alt="TSSLint Logo" width="200">
</p>

<p align="center">
  <a href="https://npmjs.com/package/@tsslint/core"><img src="https://badgen.net/npm/v/@tsslint/core" alt="npm package"></a>
  <a href="https://discord.gg/NpdmPEUNjE"><img src="https://img.shields.io/discord/854968233938354226?color=7289DA&label=discord" alt="Discord"></a>
  <a href="https://github.com/johnsoncodehk/tsslint/tree/master/LICENSE"><img src="https://img.shields.io/github/license/johnsoncodehk/tsslint.svg?labelColor=18181B&color=1584FC" alt="License"></a>
</p>

**Linter 應該是 TypeScript 的延伸，而非負擔。**

目前的 Linter 生態系統往往過於臃腫且固執己見。TSSLint 的出現是為了打破「拿著錘子找釘子」的現狀。我們不提供任何預設假設，也不強加任何審美。TSSLint 的定位是 **TypeScript 的補完計畫**——它專注於補充 TS 本身未做或做不到的事，而不是重複 TS 已經做好的工作。

## 核心哲學

*   **不提供假設 (Zero Assumptions)**：TSSLint 內建 **零規則**。我們不定義什麼是「好」的程式碼，我們把定義標準的權力完全還給開發者。
*   **寄生於 tsserver**：直接作為 TypeScript Language Server 插件運行，共享已有的 `TypeChecker` 實例。沒有獨立進程，沒有重複的型別計算，極致輕量。
*   **直球對決的 DX**：規則編寫不經過多餘的抽象層。你直接與 TypeScript 的 AST 對話，用最原始、最精確的方式定義檢查邏輯。
*   **安靜的提醒**：違規行為被報告為「訊息 (Message)」而非錯誤。它是一個安靜的副駕駛，在旁邊遞張紙條提醒你，而不是搶過你的方向盤。

## 運作原理

TSSLint 重用了編輯器 `tsserver` 中的 `TypeChecker` 實例，這使其能在幾乎不佔用額外資源的情況下，提供即時的自定義診斷能力。

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
    // 在這裡定義或引入你的規則
  },
});
```

### 3. 編輯器整合

*   **VSCode**: 安裝 [TSSLint 擴充套件](https://marketplace.visualstudio.com/items?itemName=johnsoncodehk.vscode-tsslint)。
*   **其他編輯器**: 在 `tsconfig.json` 中加入插件配置：
    ```json
    {
      "compilerOptions": {
        "plugins": [{ "name": "@tsslint/typescript-plugin" }]
      }
    }
    ```

## 編寫規則：與 AST 對話

TSSLint 讓規則編寫回歸本質。

```ts
// rules/no-debugger.ts
import { defineRule } from '@tsslint/config';

export default defineRule(({ typescript: ts, file, report }) => {
  ts.forEachChild(file, function cb(node) {
    if (node.kind === ts.SyntaxKind.DebuggerStatement) {
      report(
        '這裡建議不要使用 debugger。',
        node.getStart(file),
        node.getEnd()
      );
    }
    ts.forEachChild(node, cb);
  });
});
```

## 功能擴充

### 規則忽略 (Ignore)
透過內建插件支援自定義忽略指令：
```ts
import { defineConfig, createIgnorePlugin } from '@tsslint/config';

export default defineConfig({
  plugins: [createIgnorePlugin('tsslint-ignore', true)],
});
```

### 生態系統整合
如果你仍需要傳統 Linter 的規則，可以透過兼容層引入：
*   **ESLint**: 使用 `@tsslint/eslint` 的 `defineRules` 或 `convertRule`。
*   **TSLint**: 使用 `@tsslint/tslint` 的 `convertRule`。

## 技術備註

*   **環境要求**: Node.js 23.6.0+ (v3.0+)。
*   **兼容性**: 不支援 `typescript-go` (TypeScript v7)，因為其不支援 Language Service Plugins。

## 授權

[MIT](LICENSE)
