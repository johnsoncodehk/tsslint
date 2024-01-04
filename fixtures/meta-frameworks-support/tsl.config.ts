import { defineConfig } from 'tsl';
import noConsoleRule from '../noConsoleRule';

export default defineConfig({
	rules: {
		'no-console': noConsoleRule,
	},
});
