import { defineConfig } from '@tsslint/config';
import noConsoleRule from './noExist.ts';

export default defineConfig({
	debug: true,
	rules: {
		'no-console': noConsoleRule,
	},
});
