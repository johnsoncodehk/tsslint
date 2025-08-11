import { defineConfig } from '@tsslint/config';
import { convertRules } from '@tsslint/eslint';

export default defineConfig({
	rules: await convertRules({
		'expect-type/expect': 'error',
	}),
});
