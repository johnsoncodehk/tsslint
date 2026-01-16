import { defineConfig, fromTSLRules } from '@tsslint/config';
import { core } from 'tsl';

export default defineConfig({
	rules: fromTSLRules(core.all()),
});
