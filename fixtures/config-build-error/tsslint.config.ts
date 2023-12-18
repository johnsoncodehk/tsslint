import { defineConfig } from '../../packages/config';
import { noConsoleRule } from './noExist.ts';

export default defineConfig({
	rules: {
		'no-console': noConsoleRule,
	},
});
