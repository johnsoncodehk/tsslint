import { defineConfig } from '../../packages/config/index.js';

export default defineConfig({
	exclude: ['exclude.ts'],
	include: ['fixture.ts'],
	rules: {
		'no-console': (await import('../noConsoleRule.ts')),
	},
});
