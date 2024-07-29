import { defineConfig } from '@tsslint/config';

export default defineConfig([
	{
		debug: true,
		include: ['**/*.ts'],
		rules: {
			'no-console-ts': (await import('../noConsoleRule')).create(),
		},
	},
	{
		debug: true,
		include: ['**/*.vue'],
		rules: {
			'no-console-vue': (await import('../noConsoleRule')).create(),
		},
	},
]);
