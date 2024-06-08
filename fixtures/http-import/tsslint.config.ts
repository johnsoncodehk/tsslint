import { defineConfig } from '@tsslint/config';

export default defineConfig({
	debug: true,
	rules: {
		'no-alert': (await import('https://gist.githubusercontent.com/johnsoncodehk/55a4c45a5a35fc30b83de20507fb2bdc/raw/5f9c9a67ace76c0a77995fd71c3fb4fb504a40c8/TSSLint_noAlertRule.ts')).create(),
	},
});
