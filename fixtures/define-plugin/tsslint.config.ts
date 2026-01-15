import { defineConfig, definePlugin } from '@tsslint/config';
import { create as createNoConsoleRule } from '../noConsoleRule.ts';

export default defineConfig({
	plugins: [
		() => ({
			resolveRules(fileName, rules) {
				rules['no-console'] = createNoConsoleRule();
				return rules;
			},
		}),
		createIngorePlugin(/\/\/ @tsslint-ignore/g),
	],
});

function createIngorePlugin(pattern: RegExp) {
	return definePlugin(() => ({
		resolveDiagnostics(file, results) {
			const comments = [...file.text.matchAll(pattern)];
			const lines = new Set(comments.map(comment => file.getLineAndCharacterOfPosition(comment.index).line));
			return results.filter(error => error.source !== 'tsslint' || !lines.has(file.getLineAndCharacterOfPosition(error.start).line - 1));
		},
	}));
}
