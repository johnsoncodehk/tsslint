import { defineConfig, importESLintRules } from './packages/config/index.js';

export default defineConfig({
	rules: await importESLintRules(
		{
			'@typescript-eslint/consistent-type-imports': [true, {
				disallowTypeAnnotations: false,
				fixStyle: 'inline-type-imports',
			}],
			'@typescript-eslint/no-unnecessary-type-assertion': true,
		},
		{},
		async () => (await import('./packages/compat-eslint/index.js')).convertRule,
	),
});
