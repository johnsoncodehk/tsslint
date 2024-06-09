import { defineConfig } from '@tsslint/config';
import { getDefaultRules as getDefaultVolarRules } from 'https://raw.githubusercontent.com/volarjs/volar.js/master/tsslint.config.ts';

export default defineConfig({
	rules: {
		...getDefaultVolarRules(),
	},
});
