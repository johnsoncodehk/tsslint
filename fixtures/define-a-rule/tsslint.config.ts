import { defineConfig } from '@tsslint/config';

export default defineConfig({
	debug: true,
	exclude: ['exclude.ts'],
	rules: {
		'no-console': (await import('../noConsoleRule.ts')).create(),
	},
});
