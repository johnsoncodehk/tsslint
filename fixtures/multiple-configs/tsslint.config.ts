import { defineConfig } from '../../packages/config/index.js';

export default defineConfig([
	{
		include: ['**/*.ts'],
		rules: {
			'no-console-ts': (await import('../noConsoleRule.ts')),
		},
	},
	{
		include: ['**/*.mts'],
		rules: {
			'no-console-mts': (await import('../noConsoleRule.ts')),
		},
	},
]);
