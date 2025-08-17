import { defineConfig } from '@tsslint/config';
import { defineRules } from '@tsslint/eslint';

export default defineConfig({
	rules: await defineRules({
		'expect-type/expect': true,
	}),
});
