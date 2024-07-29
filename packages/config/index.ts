export * from '@tsslint/types';

import type { Config, Plugin, Rule } from '@tsslint/types';

export function defineRule(rule: Rule) {
	return rule;
}

export function definePlugin(plugin: Plugin) {
	return plugin;
}

export function defineConfig(config: Config | Config[]) {
	return config;
}
