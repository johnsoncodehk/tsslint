import { defineConfig, parseTSLintRules } from '@tsslint/config';

export default defineConfig({
	rules: {
		...parseTSLintRules([
			new (require('tslint-consistent-codestyle/rules/earlyExitRule').Rule)({ ruleName: 'ban-ts-ignore', ruleSeverity: 'warning', ruleArguments: [] }),
		]),
	},
});
