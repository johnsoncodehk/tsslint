import { defineConfig } from '@tsslint/config';
import { defineRules } from '@tsslint/tslint';

export default defineConfig({
	rules: {
		...await defineRules({
			'strict-boolean-expressions': true,
		}),
		// 'strict-boolean-expressions': convertRule((await import('tslint/lib/rules/strictBooleanExpressionsRule.js')).Rule),
	},
});
