import { defineConfig } from '../../packages/config';
import { noConsoleRule } from '../noConsoleRule';

export default defineConfig({
	plugins: [
		() => ({
			resolveRules(rules) {
				rules['no-console'] = noConsoleRule;
				return rules;
			},
		}),
	],
});
