import type { Config, Rule } from './types';

export function defineConfig(config: Config) {
	return config;
}

export function defineRule(rule: Rule) {
	return rule;
}

export * from './types';
export * from './loadConfig';
