import { defineConfig, importESLintRules } from './packages/config';

export default defineConfig({
	rules: await importESLintRules({
		'@typescript-eslint/no-unnecessary-type-assertion': true,
	}),
});
