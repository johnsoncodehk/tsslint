import { defineConfig } from '@tsslint/config';
import { convertConfig } from '@tsslint/eslint';

export default defineConfig({
	debug: true,
	rules: convertConfig(((await import('eslint-plugin-expect-type')).configs).recommended.rules),
});
