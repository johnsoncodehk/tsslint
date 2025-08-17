import { defineConfig } from '@tsslint/config';
import { defineRules } from '@tsslint/eslint';

export default defineConfig({
	rules: await defineRules({
		'@typescript-eslint/consistent-type-imports': [{
			disallowTypeAnnotations: false,
			fixStyle: 'inline-type-imports',
		}],
		'@typescript-eslint/no-unnecessary-type-assertion': true,
	}),
});
