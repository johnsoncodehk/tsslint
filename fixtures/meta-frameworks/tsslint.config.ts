import { defineConfig } from '@tsslint/config';

export default defineConfig({
	rules: {
		'no-console': (await import('../noConsoleRule.ts')),
	},
});
