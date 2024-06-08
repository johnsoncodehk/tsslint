import { defineConfig } from '@tsslint/config';

export default defineConfig({
	debug: true,
	rules: {
		'no-console': (await import('../noConsoleRule.ts')).create(),
	},
});
