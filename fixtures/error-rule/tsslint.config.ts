import { defineConfig } from '../../packages/config/index.js';

export default defineConfig({
	exclude: ['exclude.ts'],
	rules: {
		'no-console': () => {
			throw new Error('no-console rule is not allowed');
		},
	},
});
