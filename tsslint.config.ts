import { defineConfig } from '@tsslint/config';
import { convertRules } from '@tsslint/eslint';

export default defineConfig({
	rules: await convertRules({
		'@typescript-eslint/consistent-type-imports': ['warn', {
			disallowTypeAnnotations: false,
			fixStyle: 'inline-type-imports',
		}],
		'@typescript-eslint/no-unnecessary-type-assertion': 'warn',
	}),
});
