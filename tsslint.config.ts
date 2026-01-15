import { defineConfig, importESLintRules } from '@tsslint/config';

export default defineConfig({
	rules: await importESLintRules({
		'@typescript-eslint/consistent-type-imports': [true, {
			disallowTypeAnnotations: false,
			fixStyle: 'inline-type-imports',
		}],
		'@typescript-eslint/no-unnecessary-type-assertion': true,
	}),
});
