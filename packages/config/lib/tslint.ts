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
	const rulesDirectories = getTSLintRulesDirectories();

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
		const ruleModule = await loadTSLintRule(ruleName, rulesDirectories);
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

function getTSLintRulesDirectories(): string[] {
	const directories: string[] = [];
	let dir = process.cwd();
	while (true) {
		const tslintJsonPath = path.join(dir, 'tslint.json');
		if (fs.existsSync(tslintJsonPath)) {
			try {
				let content = fs.readFileSync(tslintJsonPath, 'utf8');
				// Remove comments
				content = content.replace(/\/\*[\s\S]*?\*\/|([^\\:]|^)\/\/.*$/gm, '$1');
				const tslintJson = JSON.parse(content);
				if (tslintJson.rulesDirectory) {
					const rulesDirs = Array.isArray(tslintJson.rulesDirectory)
						? tslintJson.rulesDirectory
						: [tslintJson.rulesDirectory];
					for (const rulesDir of rulesDirs) {
						directories.push(path.resolve(dir, rulesDir));
					}
				}
			}
			catch (e) {
				// Ignore parse errors
			}
			break;
		}
		const parentDir = path.resolve(dir, '..');
		if (parentDir === dir) {
			break;
		}
		dir = parentDir;
	}
	return directories;
}

async function loadTSLintRule(ruleName: string, rulesDirectories: string[]): Promise<any | undefined> {
	const camelCaseName = ruleName.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
	const ruleFileName = `${camelCaseName.charAt(0).toUpperCase() + camelCaseName.slice(1)}Rule.js`;

	for (const rulesDir of rulesDirectories) {
		const rulePath = path.resolve(rulesDir, ruleFileName);
		if (fs.existsSync(rulePath)) {
			const mod = require(rulePath);
			return mod.Rule;
		}
	}

	let dir = __dirname;
	while (true) {
		const nodeModulesDir = path.join(dir, 'node_modules');
		if (fs.existsSync(nodeModulesDir)) {
			const tslintDir = path.join(nodeModulesDir, 'tslint', 'lib', 'rules');
			if (fs.existsSync(tslintDir)) {
				const rulePath = path.join(tslintDir, ruleFileName);
				if (fs.existsSync(rulePath)) {
					const mod = require(rulePath);
					return mod.Rule;
				}
			}
		}
		const parentDir = path.resolve(dir, '..');
		if (parentDir === dir) {
			break;
		}
		dir = parentDir;
	}
}
