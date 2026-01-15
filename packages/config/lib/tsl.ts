import type * as TSSLint from '@tsslint/types';
import * as fs from 'fs';
import * as path from 'path';
import type * as ts from 'typescript';

const noop = () => {};

type Severity = boolean | 'error' | 'warn';

/**
 * Converts a TSL rules configuration to TSSLint rules.
 */
export async function importTSLRules(
	config: { [ruleName: string]: Severity },
) {
	let convertRule: typeof import('@tsslint/compat-tsl').convertRule;
	try {
		({ convertRule } = await import('@tsslint/compat-tsl'));
	}
	catch {
		throw new Error('Please install @tsslint/compat-tsl to use importTSLRules().');
	}

	const rules: TSSLint.Rules = {};
	const tslRules = await loadTSLRules();

	for (const [ruleName, severity] of Object.entries(config)) {
		if (!severity) {
			rules[ruleName] = noop;
			continue;
		}
		const rule = tslRules[ruleName];
		if (!rule) {
			throw new Error(`Failed to resolve TSL rule "${ruleName}".`);
		}
		rules[ruleName] = convertRule(
			rule,
			severity === 'error'
				? 1 satisfies ts.DiagnosticCategory.Error
				: severity === 'warn'
				? 0 satisfies ts.DiagnosticCategory.Warning
				: 3 satisfies ts.DiagnosticCategory.Message,
		);
	}
	return rules;
}

async function loadTSLRules(): Promise<Record<string, any>> {
	const rules: Record<string, any> = {};
	let dir = __dirname;
	while (true) {
		const nodeModulesDir = path.join(dir, 'node_modules');
		if (fs.existsSync(nodeModulesDir)) {
			const tslDir = path.join(nodeModulesDir, 'tsl');
			if (fs.existsSync(tslDir)) {
				try {
					const tsl = require(tslDir);
					if (tsl.core) {
						const coreRules = tsl.core.all();
						for (const rule of coreRules) {
							rules[rule.name] = rule;
						}
					}
				}
				catch {
					// Ignore
				}
			}
		}
		const parentDir = path.resolve(dir, '..');
		if (parentDir === dir) {
			break;
		}
		dir = parentDir;
	}
	return rules;
}
