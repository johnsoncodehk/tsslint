import { defineConfig } from '../../packages/config';
import { noConsoleRule } from '../noConsoleRule';

export default defineConfig({
	debug: true,
	rules: {
		'no-console': noConsoleRule,
	},
});
