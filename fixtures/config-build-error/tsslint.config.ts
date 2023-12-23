import { defineConfig } from '@tsslint/config';
import { noConsoleRule } from './noExist.ts';

export default defineConfig({
	rules: {
		'no-console': noConsoleRule,
	},
});
