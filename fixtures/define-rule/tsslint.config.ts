import { defineConfig } from '@tsslint/config';

export default defineConfig({
	exclude: ['exclude.ts'],
	include: ['fixture.ts'],
	rules: {
		'no-console': (await import('../noConsoleRule.ts')).create(),
	},
});
