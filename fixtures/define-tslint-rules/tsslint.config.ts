import { defineConfig, importTSLintRules } from '@tsslint/config';

export default defineConfig({
	rules: await importTSLintRules({
		'strict-boolean-expressions': true,
	}),
});
