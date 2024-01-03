# TSSLint

> A lightweight inspection tool that seamlessly integrates with TypeScript Language Server

TSSLint is not your typical linter. Its main purpose is to expose the TypeScript Language Server diagnostic interface, allowing you to add your own diagnostic rules without additional overhead to creating a TypeChecker.

Discord Server: https://discord.gg/NpdmPEUNjE

## Packages

This repository is a monorepo that we manage using [Lerna-Lite](https://github.com/lerna-lite/lerna-lite). That means that we actually publish several packages to npm from the same codebase, including:

- [`@tsslint/cli`](packages/cli): This package provides the command line interface for TSSLint.
- [`@tsslint/config`](packages/config): This package allows you to define and build configuration files for TSSLint.
- [`@tsslint/core`](packages/core): This is the core package for TSSLint, which provides the main functionality of the tool.
- [`@tsslint/typescript-plugin`](packages/typescript-plugin): This package integrates TSSLint with the TypeScript language server.
- [`@tsslint/vscode`](packages/vscode): This package is a Visual Studio Code extension that integrates TSSLint into the editor.

## Why TSSLint?

The performance of TypeScript in code editors has always been a crucial concern. Most TypeScript tools integrate TypeScript libraries to enable type checking and query code types through the LanguageService or TypeChecker API.

However, for complex types or large codebases, the tsserver process can consume significant memory and CPU resources. When linter tools integrate with TypeScript and create their own LanguageService instances, memory and CPU usage can continue to increase. In some cases, this has caused projects to experience long save times when codeActionOnSave is enabled in VSCode.

TSSLint aims to seamlessly integrate with tsserver to minimize unnecessary overhead and provide linting capabilities on top of it.

## Features

- Integration with tsserver to minimize semantic linting overhead in IDEs
- Writing config in typescript
- Direct support for meta framework files based on TS Plugin without a parser (e.g., Vue)

## Usage

To enable TSSLint in your IDE, follow these steps:

1. Install the [TSSLint VSCode Extension](https://marketplace.visualstudio.com/items?itemName=johnsoncodehk.vscode-tsslint)
2. Add the `@tsslint/config` dependency to your project.
3. Create the `tsslint.config.ts` config file:
	```js
	import { defineConfig } from '@tsslint/config';

	export default defineConfig({
		rules: {
			// ... your rules
		},
	});
	```

### Create a Rule

To create a rule, you need to define a function that receives the context of the current diagnostic task. Within this function, you can call `reportError()` or `reportWarning()` to report an error.

As an example, let's create a `no-console` rule under `[project root]/rules/`.

Here's the code for `[project root]/rules/noConsoleRule.ts`:

```js
import type { Rule } from '@tsslint/config';

const rule: Rule = ({ typescript: ts, sourceFile, reportWarning }) => {
	ts.forEachChild(sourceFile, function walk(node) {
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
							length: node.parent.getEnd() - node.parent.getStart(sourceFile),
						},
					}],
				}]
			);
		}
		ts.forEachChild(node, walk);
	});
}

export default rule;
```

Then add it to the `tsslint.config.ts` config file.

```diff
import { defineConfig } from '@tsslint/config';
+ import noConsoleRule from './rules/noConsoleRule.ts';

export default defineConfig({
	rules: {
+ 		'no-console': noConsoleRule
	},
});
```

After saving the config file, you will notice that `console.log` is now reporting errors in the editor. The error message will also display the specific line of code where the error occurred. Clicking on the error message will take you to line 11 in `noConsoleRule.ts`, where the `reportWarning()` code is located.

### Modify the Error

While you cannot directly configure the severity of a rule, you can modify the reported errors through the `resolveDiagnostics()` API in the config file. This allows you to customize the severity of specific rules and even add additional errors.

Here's an example of changing the severity of the `no-console` rule from Warning to Error in the `tsslint.config.ts` file:

```js
import { defineConfig } from 'tsslint';
import noConsoleRule from './rules/noConsoleRule.ts';

export default defineConfig({
	rules: {
		'no-console': noConsoleRule
	},
	plugins: [
		({ typescript: ts }) => ({
			resolveDiagnostics(_fileName, diagnostics) {
				for (const diagnostic of diagnostics) {
					if (diagnostic.code === 'no-console') {
						diagnostic.category = ts.DiagnosticCategory.Error;
					}
				}
				return diagnostics;
			},
		}),
	],
});
```
