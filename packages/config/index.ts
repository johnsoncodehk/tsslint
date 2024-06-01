export * from './lib/build';
export * from './lib/watch';
export * from './lib/types';

import type { Config, Rule } from './lib/types';

export function defineConfig(config: Config) {
	return config;
}

export function defineRule(rule: Rule) {
	return rule;
}
