import { defineConfig, parseTSLintRules } from '@tsslint/config';

export default defineConfig({
	rules: {
		...parseTSLintRules([
			new (require('tslint/lib/rules/banTsIgnoreRule').Rule)({ ruleName: 'ban-ts-ignore', ruleArguments: [], ruleSeverity: 'warning' }),
		]),
	},
});
