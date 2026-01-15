import { defineConfig } from '@tsslint/config';
import { convertRule } from '@tsslint/compat-tslint';

export default defineConfig({
	rules: {
		'strict-boolean-expressions': convertRule((await import('tslint/lib/rules/strictBooleanExpressionsRule.js')).Rule),
	},
});
