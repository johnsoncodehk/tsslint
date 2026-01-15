import { convertRule } from '@tsslint/compat-tslint';
import { defineConfig } from '@tsslint/config';

export default defineConfig({
	rules: {
		'strict-boolean-expressions': convertRule((await import('tslint/lib/rules/strictBooleanExpressionsRule.js')).Rule),
	},
});
