export * from '@tsslint/types';

import type { Config, Rule } from '@tsslint/types';

export function defineRule(rule: Rule) {
	return rule;
}

export function defineConfig(config: Config) {
	return config;
}
