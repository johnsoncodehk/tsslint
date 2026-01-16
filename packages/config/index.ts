export * from '@tsslint/types';
export * from './lib/eslint.js';
export { create as createCategoryPlugin } from './lib/plugins/category.js';
export { create as createDiagnosticsPlugin } from './lib/plugins/diagnostics.js';
export { create as createIgnorePlugin } from './lib/plugins/ignore.js';
export * from './lib/tsl.js';
export * from './lib/tslint.js';

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
