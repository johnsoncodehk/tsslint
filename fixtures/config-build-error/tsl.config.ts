import { defineConfig } from 'tsl';
import noConsoleRule from './noExist.ts';

export default defineConfig({
	rules: {
		'no-console': noConsoleRule,
	},
});
