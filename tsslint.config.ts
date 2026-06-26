import { defineConfig, importESLintRules } from './packages/config/index.js';

const convertRule = async () => (await import('./packages/compat-eslint/index.js')).convertRule;

const shimGlobs = [
	'packages/cli/lib/tsgo-*.ts',
	'packages/cli/lib/real-ts.ts',
	'packages/poc-tsgo/**/*.ts',
];

export default defineConfig([
	{
		exclude: shimGlobs,
		rules: await importESLintRules(
			{
				'@typescript-eslint/consistent-type-imports': [true, {
					disallowTypeAnnotations: false,
					fixStyle: 'inline-type-imports',
				}],
				'@typescript-eslint/no-unnecessary-type-assertion': true,
			},
			{},
			convertRule,
		),
	},
	{
		include: shimGlobs,
		rules: await importESLintRules(
			{
				'@typescript-eslint/consistent-type-imports': [true, {
					disallowTypeAnnotations: false,
					fixStyle: 'inline-type-imports',
				}],
			},
			{},
			convertRule,
		),
	},
]);
