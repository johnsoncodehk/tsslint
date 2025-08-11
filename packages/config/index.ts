export * from '@tsslint/types';
export { create as createIgnorePlugin } from './lib/plugins/ignore.js';

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

export function isCLI() {
	return !!process.env.TSSLINT_CLI;
}
