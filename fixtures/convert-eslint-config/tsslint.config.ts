import { defineConfig } from '@tsslint/config';
import { convertConfig } from '@tsslint/eslint';

export default defineConfig({
	rules: convertConfig(((await import('eslint-plugin-expect-type')).configs).recommended.rules),
});
