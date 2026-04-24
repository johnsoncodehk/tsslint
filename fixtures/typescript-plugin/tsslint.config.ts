import { defineConfig } from '../../packages/config/index.js';

export default defineConfig({
	rules: {
		'no-console': (await import('../noConsoleRule.ts')),
	},
});
