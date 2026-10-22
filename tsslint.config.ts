import { defineConfig, importESLintRules } from './packages/config/index.js';

// typescript-eslint rules cannot run on TypeScript 7, so only ESLint core
// rules are used here.
export default defineConfig({
	rules: await importESLintRules(
		{
			'no-var': true,
			'prefer-const': true,
			'eqeqeq': [true, 'always', { null: 'ignore' }],
		},
		{},
		async () => (await import('./packages/compat-eslint/index.js')).convertRule,
	),
});
