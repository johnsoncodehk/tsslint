import { defineConfig, importTSLRules } from '../../packages/config/index.js';

export default defineConfig({
	rules: {
		...await importTSLRules({
			'tsl/no-unnecessary-type-assertion': 'error',
		}),
	},
});
