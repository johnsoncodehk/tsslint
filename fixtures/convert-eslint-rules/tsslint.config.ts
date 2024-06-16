import { defineConfig } from '@tsslint/config';
import { convertRule } from '@tsslint/eslint';

export default defineConfig({
	rules: {
		// Not yet supported
		// 'no-console': convertRule((await import('./node_modules/eslint/lib/rules/no-console.js')).default),

		// Supported
		'prefer-ts-expect-error': convertRule((await import('./node_modules/@typescript-eslint/eslint-plugin/dist/rules/prefer-ts-expect-error.js')).default.default),
		'return-await': convertRule((await import('./node_modules/@typescript-eslint/eslint-plugin/dist/rules/return-await.js')).default.default),
		'no-unnecessary-type-assertion': convertRule((await import('./node_modules/@typescript-eslint/eslint-plugin/dist/rules/no-unnecessary-type-assertion.js')).default.default),
		'prefer-nullish-coalescing': convertRule((await import('./node_modules/@typescript-eslint/eslint-plugin/dist/rules/prefer-nullish-coalescing.js')).default.default, [{
			ignorePrimitives: {
				boolean: true,
			},
		}]),
		'strict-boolean-expressions': convertRule((await import('./node_modules/@typescript-eslint/eslint-plugin/dist/rules/strict-boolean-expressions.js')).default.default, [{
			allowNullableBoolean: true,
			allowString: false,
			allowAny: true,
		}]),
		'switch-exhaustiveness-check': convertRule((await import('./node_modules/@typescript-eslint/eslint-plugin/dist/rules/switch-exhaustiveness-check.js')).default.default, [{
			allowDefaultCaseForExhaustiveSwitch: true,
			requireDefaultForNonUnion: true,
		}]),
		'no-unnecessary-condition': convertRule((await import('./node_modules/@typescript-eslint/eslint-plugin/dist/rules/no-unnecessary-condition.js')).default.default, [{
			allowConstantLoopConditions: true,
		}]),

		// vuejs/core rules
		// 'prefer-ts-expect-error': convertRule((await import('./node_modules/@typescript-eslint/eslint-plugin/dist/rules/prefer-ts-expect-error.js')).default.default, 1),
		'consistent-type-imports': convertRule((await import('./node_modules/@typescript-eslint/eslint-plugin/dist/rules/consistent-type-imports.js')).default.default, [{
			fixStyle: 'inline-type-imports',
			disallowTypeAnnotations: false,
		}]),
		'no-import-type-side-effects': convertRule((await import('./node_modules/@typescript-eslint/eslint-plugin/dist/rules/no-import-type-side-effects.js')).default.default),
	},
});
