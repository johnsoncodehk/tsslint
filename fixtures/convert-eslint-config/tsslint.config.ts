import { defineConfig } from '@tsslint/config';
import { loadPluginRules } from '@tsslint/eslint';

export default defineConfig({
	rules: await loadPluginRules(((await import('eslint-plugin-expect-type')).configs).recommended.rules),
});
