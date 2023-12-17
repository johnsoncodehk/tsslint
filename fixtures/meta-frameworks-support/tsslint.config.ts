import { defineConfig } from '@tsslint/config';
import { noConsoleRule } from '../noConsoleRule';

export default defineConfig({
	rules: {
		'no-console': noConsoleRule,
	},
});
