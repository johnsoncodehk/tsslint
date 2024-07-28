import { defineConfig } from '@tsslint/config';

export default defineConfig({
	debug: true,
	exclude: ['exclude.ts'],
	rules: {
		'no-console': () => {
			throw new Error('no-console rule is not allowed');
		},
	},
});
