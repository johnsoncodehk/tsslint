import { defineConfig } from '@tsslint/config';

export default defineConfig([
	{
		include: ['**/*.ts'],
		rules: {
			'no-console-ts': (await import('../noConsoleRule.ts')).create(),
		},
	},
	{
		include: ['**/*.vue'],
		rules: {
			'no-console-vue': (await import('../noConsoleRule.ts')).create(),
		},
	},
]);
