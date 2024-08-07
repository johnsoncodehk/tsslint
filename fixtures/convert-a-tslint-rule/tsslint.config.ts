import { defineConfig } from '@tsslint/config';
import { convertRule } from '@tsslint/tslint';

export default defineConfig({
	debug: true,
	rules: {
		'strict-boolean-expressions': convertRule((await import('tslint/lib/rules/strictBooleanExpressionsRule.js')).Rule),
	},
});
