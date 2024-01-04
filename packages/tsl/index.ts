export * from '@tsslint/config';
export * from '@tsslint/core';

import type { Config, Rule } from '@tsslint/config';

export function defineConfig(config: Config) {
	return config;
}

export function defineRule(rule: Rule) {
	return rule;
}
