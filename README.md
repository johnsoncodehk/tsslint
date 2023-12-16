# TSSLint

> The *zero overhead* "Linter" integrated with TypeScript Language Server.

Status: PoC

This is not the traditional Linter you know, the main purpose of TSSLinter is to expose the TypeScript Language Server diagnostic interface. You can add your own diagnostic rules without additional TypeChecker overhead, or modify TypeScript's original diagnostic results.

## Why?

The performance of TS in Editor has long been a topic that cannot be ignored. Most TS tools integrate TS libraries to obtain type checking capabilities, and query code types through LanguageService or TypeChecker API.

But for complex types or large code bases, tsserver may already take up a lot of memory and CPU. When Linter tools integrated with TS create and maintain their LanguageService instances, memory and CPU will continue to increase. More seriously, this has caused some projects to save for too long when codeActionOnSave is enabled in VSCode.

The purpose of TSSLint is to perfectly integrate tsserver to avoid the overhead that we should be able to avoid, and to expose linting capabilities on top of it.

TSSLint will also be compatible with TSLint rules to reduce duplication of work.

## Features

- Integrate with tsserver to minimize semantic linting overhead in IDE
- Integrate with tsc to minimize linting time in CI
- Traceable error reporting
- Support ESM config file

## Usage

To make TSSLint work in the IDE (here specifically refers to VSCode), you need to install the [TSSLint VSCode Extension](https://marketplace.visualstudio.com/items?itemName=johnsoncodehk.vscode-tsslint), and create a configuration file in the project root directory, the effective file name is `tsslint.config.js` (could be CJS or ESM, depending on the `type` field of `pakcage.json`) / `tsslint.config.cjs` (CJS) / `tsslint.config.mjs` (ESM).

`[project root]/tsslint.config.mjs`:

```js
import { defineConfig } from 'tsslint';

export default defineConfig({
	rules: {
		// ... your rules
	},
});
```

> Wrapping into `defineConfig()` is optional, it's just for having IntelliSense support.

### Create a Rule

Each rule is a function that receives the context of the current diagnostic task. You can call `reportError()` / `reportWarning()` to report an error.

Let's create a `no-console` rule under `[project root]/rules/` as an example.

`[project root]/rules/no-console.mjs`:

```js
import { defineRule } from 'tsslint';

export default defineRule(({ typescript: ts, sourceFile, reportWarning }) => {
    sourceFile.forEachChild(function walk(node) {
        if (
            ts.isPropertyAccessExpression(node) &&
            ts.isIdentifier(node.expression) &&
            node.expression.text === 'console'
        ) {
            reportWarning(
                `Calls to 'console.x' are not allowed.`,
                node.parent.getStart(sourceFile),
                node.parent.getEnd()
            ).withFix(
                'Remove this console expression',
                () => [{
                    fileName: sourceFile.fileName,
                    textChanges: [{
                        newText: '/* deleted */',
                        span: {
                            start: node.parent.getStart(sourceFile),
                            length: node.parent.end,
                        },
                    }],
                }]
            );
        }
        node.forEachChild(walk);
    });
});
```

Then add it to config.

`[project root]/tsslint.config.mjs`:

```js
import { defineConfig } from 'tsslint';
import noConsoleRule from './rules/no-console.mjs';

export default defineConfig({
	rules: {
		'no-console': noConsoleRule
	},
});
```

Execute the `TypeScript: Restart TS Server` command in VSCode. Now you can see in the editor that `console.log` is reporting errors. At the same time, the error message will display the actual code line reporting the error. When you click it, it will jump to the `reportWarning()` code at line 10 in `no-console.mjs`.

### Modify the Error

You cannot configure the severity of a rule, it should be determined internally by rules. But in the config file, you can modify the reported errors through the `resolveResult()` API, and even add additional errors.

The following example shows changing no-console from Warning to Error.

`[project root]/tsslint.config.mjs`:

```js
import { defineConfig } from 'tsslint';
import noConsoleRule from './rules/no-console.mjs';

export default defineConfig({
	rules: {
		'no-console': noConsoleRule
	},
	resolveResult({ typescript: ts }, errors) {
		for (const error of errors) {
			if (error.code === 'no-console') {
				error.category = ts.DiagnosticCategory.Error;
			}
		}
		return errors;
	},
});
```
