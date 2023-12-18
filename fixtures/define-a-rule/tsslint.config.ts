import { defineConfig } from '../../packages/config';
import { noConsoleRule } from '../noConsoleRule';

export default defineConfig({
	rules: {
		'no-console': noConsoleRule,
	},
});
