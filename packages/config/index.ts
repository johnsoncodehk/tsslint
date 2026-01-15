export * from '@tsslint/types';
export { create as createCategoryPlugin } from './lib/plugins/category.js';
export { create as createDiagnosticsPlugin } from './lib/plugins/diagnostics.js';
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

export async function importESLintRules(
	config: any,
	context?: any
) {
	const { defineRules } = await import('@tsslint/compat-eslint');
	return defineRules(config, context, 1);
}

export async function importESLintWarningRules(
	config: any,
	context?: any
) {
	const { defineRules } = await import('@tsslint/compat-eslint');
	return defineRules(config, context, 0);
}
