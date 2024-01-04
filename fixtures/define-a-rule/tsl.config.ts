import { defineConfig } from 'tsl';
import { noConsoleRule } from '../noConsoleRule';

export default defineConfig({
	debug: true,
	rules: {
		'no-console': noConsoleRule,
	},
});
