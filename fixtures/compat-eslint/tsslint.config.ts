import { defineConfig, importESLintRules } from '@tsslint/config';

export default defineConfig({
	rules: await importESLintRules({
		'expect-type/expect': true,
	}),
});
