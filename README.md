# TSSLint

> A lightweight inspection tool that seamlessly integrates with TypeScript Language Server

TSSLint is not your typical linter. Its main purpose is to expose the TypeScript Language Server diagnostic interface, allowing you to add your own diagnostic rules without additional overhead to creating a TypeChecker.

## Why TSSLint?

The performance of TypeScript in code editors has always been a crucial concern. Most TypeScript tools integrate TypeScript libraries to enable type checking and query code types through the LanguageService or TypeChecker API.

However, for complex types or large codebases, the tsserver process can consume significant memory and CPU resources. When linter tools integrate with TypeScript and create their own LanguageService instances, memory and CPU usage can continue to increase. In some cases, this has caused projects to experience long save times when codeActionOnSave is enabled in VSCode.

TSSLint aims to seamlessly integrate with tsserver to minimize unnecessary overhead and provide linting capabilities on top of it. It also supports reusing TSLint rules to reduce duplication of work.

## Features

- Integration with tsserver to minimize semantic linting overhead in IDEs
- Compatibility with TSLint rules
- Writing config in typescript
- Direct support for meta framework files based on TS Plugin without a parser (e.g., Vue)

## Usage

To enable TSSLint in your IDE, follow these steps:

1. Install the TSSLint VSCode Extension
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
	> Wrapping the configuration in `defineConfig()` is optional but provides IntelliSense support.

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

While you cannot directly configure the severity of a rule, you can modify the reported errors through the `resolveResult()` API in the config file. This allows you to customize the severity of specific rules and even add additional errors.

Here's an example of changing the severity of the `no-console` rule from Warning to Error in the `tsslint.config.ts` file:

```js
import { defineConfig } from 'tsslint';
import noConsoleRule from './rules/no-console.mjs';

export default defineConfig({
	rules: {
		'no-console': noConsoleRule
	},
	plugins: [
		() => ({
			resolveResult({ typescript: ts }, errors) {
				for (const error of errors) {
					if (error.code === 'no-console') {
						error.category = ts.DiagnosticCategory.Error;
					}
				}
				return errors;
			},
		}),
	],
});
```

## Using TSLint Rules

TSSLint supports the reuse of TSLint rules. This feature allows you to avoid duplicating work when you want to use existing TSLint rules. To use TSLint rules, you need to parse them using the `parseTSLintRules` function from `@tsslint/config` as shown in the example below:

```typescript
import { defineConfig, parseTSLintRules } from '@tsslint/config';

export default defineConfig({
	rules: {
		...parseTSLintRules([
			new (require('tslint/lib/rules/banTsIgnoreRule').Rule)({
				ruleName: 'ban-ts-ignore',
				ruleArguments: [],
				ruleSeverity: 'warning',
			}),
		]),
	},
});
```

In the above example, the `ban-ts-ignore` rule from TSLint is being used. The `parseTSLintRules` function takes an array of TSLint rules and returns an object that can be spread into the `rules` property of the config object passed to `defineConfig`.

Please refer to the `fixtures/parse-tslint-rules/` file for a complete example.
