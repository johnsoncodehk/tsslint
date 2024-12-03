import { defineConfig, definePlugin } from '@tsslint/config';
import { create as createNoConsoleRule } from '../noConsoleRule';

export default defineConfig({
	debug: true,
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
		resolveDiagnostics(sourceFile, results) {
			const comments = [...sourceFile.text.matchAll(pattern)];
			const lines = new Set(comments.map(comment => sourceFile.getLineAndCharacterOfPosition(comment.index).line));
			return results.filter(error => error.source !== 'tsslint' || !lines.has(sourceFile.getLineAndCharacterOfPosition(error.start).line - 1));
		},
	}));
}
