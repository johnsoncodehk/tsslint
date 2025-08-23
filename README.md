# TSSLint

> A lightweight inspection tool that seamlessly integrates with TypeScript Language Server

TSSLint is not your typical linter. Its main purpose is to expose the TypeScript Language Server diagnostic interface, allowing you to add your own diagnostic rules without additional overhead to creating a TypeChecker.

Discord Server: https://discord.gg/NpdmPEUNjE

Special thanks to @basarat for transferring the `tsl` package name.

## Packages

This repository is a monorepo that we manage using [Lerna-Lite](https://github.com/lerna-lite/lerna-lite). That means that we actually publish several packages to npm from the same codebase, including:

- [`cli`](packages/cli): This package provides the command line interface for TSSLint.
- [`config`](packages/config): This package allows you to define and build configuration files for TSSLint.
- [`core`](packages/core): This is the core package for TSSLint, which provides the main functionality of the tool.
- [`typescript-plugin`](packages/typescript-plugin): This package integrates TSSLint with the TypeScript language server.
- [`vscode`](packages/vscode): This package is a Visual Studio Code extension that integrates TSSLint into the editor.

## Why TSSLint?

The performance of TypeScript in code editors has always been a crucial concern. Most TypeScript tools integrate TypeScript libraries to enable type checking and query code types through the LanguageService or TypeChecker API.

However, for complex types or large codebases, the tsserver process can consume significant memory and CPU resources. When linter tools integrate with TypeScript and create their own LanguageService instances, memory and CPU usage can continue to increase. In some cases, this has caused projects to experience long save times when codeActionOnSave is enabled in VSCode.

TSSLint aims to seamlessly integrate with tsserver to minimize unnecessary overhead and provide linting capabilities on top of it.

## Features

- Integration with tsserver to minimize semantic linting overhead in IDEs.
- Writing config in typescript.
- Direct support for meta framework files based on TS Plugin without a parser. (e.g., Vue, MDX)
- Pure ESM.
- Designed to allow simple, direct access to rule source code without an intermediary layer.

## Usage

To enable TSSLint in VSCode, follow these steps:

1. Install the [TSSLint VSCode Extension](https://marketplace.visualstudio.com/items?itemName=johnsoncodehk.vscode-tsslint)
2. Add the `@tsslint/config` dependency to your project.
	```json
	{
		"devDependencies": {
			"@tsslint/config": "latest"
		}
	}
	```
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

To create a rule, you need to define a function that receives the context of the current diagnostic task. Within this function, you can call `report()` to report an error.

As an example, let's create a `no-console` rule under `[project root]/rules/`.

Here's the code for `[project root]/rules/noConsoleRule.ts`:

```js
import { defineRule } from '@tsslint/config';

export function create() {
	return defineRule(({ typescript: ts, file, report }) => {
		ts.forEachChild(file, function cb(node) {
			if (
				ts.isPropertyAccessExpression(node) &&
				ts.isIdentifier(node.expression) &&
				node.expression.text === 'console'
			) {
				report(
					`Calls to 'console.x' are not allowed.`,
					node.parent.getStart(file),
					node.parent.getEnd()
				).withFix(
					'Remove this console expression',
					() => [{
						fileName: file.fileName,
						textChanges: [{
							newText: '/* deleted */',
							span: {
								start: node.parent.getStart(file),
								length: node.parent.getWidth(file),
							},
						}],
					}]
				);
			}
			ts.forEachChild(node, cb);
		});
	});
}
```

Then add it to the `tsslint.config.ts` config file.

```diff
import { defineConfig } from '@tsslint/config';

export default defineConfig({
	rules: {
+ 		'no-console': (await import('./rules/noConsoleRule.ts')).create(),
	},
});
```

After saving the config file, you will notice that `console.log` is now reporting errors in the editor. The error message will also display the specific line of code where the error occurred. Clicking on the error message will take you to line 11 in `noConsoleRule.ts`, where the `report()` code is located.

> Full example: https://github.com/johnsoncodehk/tsslint/tree/master/fixtures/define-a-rule

### Modify the Error

While you cannot directly configure the severity of a rule, you can modify the reported errors through the `resolveDiagnostics()` API in the config file. This allows you to customize the severity of specific rules and even add additional errors.

Here's an example of changing the severity of the `no-console` rule from Warning to Error in the `tsslint.config.ts` file:

```js
import { defineConfig } from '@tsslint/config';
import noConsoleRule from './rules/noConsoleRule.ts';

export default defineConfig({
	rules: {
		'no-console': noConsoleRule
	},
	plugins: [
		({ typescript: ts }) => ({
			resolveDiagnostics(file, diagnostics) {
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

## CLI Usage

The `@tsslint/cli` package provides a command-line interface for running the TSSLint tool across your TypeScript projects. It can be used by running the `tsslint` command in your terminal.

Here is a basic example of how to use it:

```sh
npx tsslint --project path/to/your/tsconfig.json
```

This command will run the linter on the TypeScript project defined by the provided `tsconfig.json` file. Any linting errors will be output to the console.

If you want to automatically fix any fixable linting errors, you can use the `--fix` option:

```sh
npx tsslint --project path/to/your/tsconfig.json --fix
```

This will run the linter and automatically apply any fixes that are available.

You can also lint multiple projects at once:

```sh
npx tsslint --project packages/*/tsconfig.json
npx tsslint --project {packages/pkg-a/tsconfig.json,packages/pkg-b/tsconfig.json}
```

This command will run the linter on all TypeScript projects located in the subdirectories of the `packages` directory. Each subdirectory should contain a `tsconfig.json` file defining a TypeScript project. Any linting errors will be output to the console.

### Linting Different Project Types

TSSLint also supports linting different types of projects, such as Vue, Vue Vine, MDX, and Astro. You can specify the project type using the relevant flags:

- **Vue projects**:
  ```sh
  npx tsslint --vue-project path/to/vue/tsconfig.json
  ```
- **Vue Vine projects**:
  ```sh
  npx tsslint --vue-vine-project path/to/vue-vine/tsconfig.json
  ```
- **MDX projects**:
  ```sh
  npx tsslint --mdx-project path/to/mdx/tsconfig.json
  ```
- **Astro projects**:
  ```sh
  npx tsslint --astro-project path/to/astro/tsconfig.json
  ```
- **TS Macro projects**:
  ```sh
  npx tsslint --ts-macro-project path/to/ts-macro/tsconfig.json
  ```

This allows flexibility in linting different project structures while maintaining the same CLI workflow.
