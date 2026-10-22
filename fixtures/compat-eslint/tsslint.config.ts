import { defineConfig, importESLintRules } from '@tsslint/config';

export default defineConfig({
	rules: await importESLintRules({
		'no-unused-vars': 'warn',
		'prefer-const': true,
	}),
});
