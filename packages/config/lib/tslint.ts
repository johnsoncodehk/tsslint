import type * as TSSLint from '@tsslint/types';
import * as fs from 'fs';
import * as path from 'path';
import type * as ts from 'typescript';
import type { TSLintRulesConfig } from './tslint-types.js';

const noop = () => {};

/**
 * Converts a TSLint rules configuration to TSSLint rules.
 *
 * ---
 * ⚠️ **Type definitions not generated**
 *
 * Please add `@tsslint/config` to `pnpm.onlyBuiltDependencies` in your `package.json` to allow the postinstall script to run.
 *
 * ```json
 * {
 *   "pnpm": {
 *     "onlyBuiltDependencies": ["@tsslint/config"]
 *   }
 * }
 * ```
 *
 * After that, run `pnpm install` again to generate type definitions.
 *
 * If the type definitions become outdated, please run `npx tsslint-config-update` to update them.
 */
export async function importTSLintRules(
	config: { [K in keyof TSLintRulesConfig]: boolean | TSLintRulesConfig[K] },
	category: ts.DiagnosticCategory = 3 satisfies ts.DiagnosticCategory.Message,
) {
	let convertRule: typeof import('@tsslint/compat-tslint').convertRule;
	try {
		({ convertRule } = await import('@tsslint/compat-tslint'));
	}
	catch {
		throw new Error('Please install @tsslint/compat-tslint to use importTSLintRules().');
	}

	const rules: TSSLint.Rules = {};
	for (const [ruleName, severityOrOptions] of Object.entries(config)) {
		let severity: boolean;
		let options: any[];
		if (Array.isArray(severityOrOptions)) {
			severity = true;
			options = severityOrOptions;
		}
		else {
			severity = !!severityOrOptions;
			options = [];
		}
		if (!severity) {
			rules[ruleName] = noop;
			continue;
		}
		const ruleModule = await loadTSLintRule(ruleName);
		if (!ruleModule) {
			throw new Error(`Failed to resolve TSLint rule "${ruleName}".`);
		}
		rules[ruleName] = convertRule(
			ruleModule,
			options,
			category,
		);
	}
	return rules;
}

async function loadTSLintRule(ruleName: string): Promise<any | undefined> {
	const camelCaseName = ruleName.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
	const className = camelCaseName.charAt(0).toUpperCase() + camelCaseName.slice(1) + 'Rule';

	let dir = __dirname;
	while (true) {
		const tslintDir = path.join(dir, 'node_modules', 'tslint', 'lib', 'rules');
		if (fs.existsSync(tslintDir)) {
			const rulePath = path.join(tslintDir, `${camelCaseName}Rule.js`);
			if (fs.existsSync(rulePath)) {
				const mod = require(rulePath);
				return mod.Rule;
			}
		}
		const parentDir = path.resolve(dir, '..');
		if (parentDir === dir) {
			break;
		}
		dir = parentDir;
	}
}
