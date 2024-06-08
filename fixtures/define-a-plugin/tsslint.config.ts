import { defineConfig } from '@tsslint/config';
import { create as createNoConsoleRule } from '../noConsoleRule';

export default defineConfig({
	plugins: [
		() => ({
			resolveRules(rules) {
				rules['no-console'] = createNoConsoleRule();
				return rules;
			},
		}),
	],
});
