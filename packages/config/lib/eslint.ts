import type * as TSSLint from '@tsslint/types';
import type * as ESLint from 'eslint';
import * as fs from 'fs';
import * as path from 'path';
import type * as ts from 'typescript';
import type { ESLintRulesConfig } from './eslint-types.js';

const noop = () => {};
const plugins: Record<
	string,
	Promise<
		{
			rules: Record<string, ESLint.Rule.RuleModule>;
		} | undefined
	>
> = {};
const loader = async (moduleName: string) => {
	let mod: {} | undefined;
	try {
		mod ??= require(moduleName);
	}
	catch {}
	try {
		mod ??= await import(moduleName);
	}
	catch {}
	if (mod && 'default' in mod) {
		return mod.default;
	}
	return mod as any;
};

type Severity = boolean | 'error' | 'warn';

/**
 * Converts an ESLint rules configuration to TSSLint rules.
 *
 * ⚠️ **Type definitions not generated**
 *
 * Please run `npx tsslint-docgen` to update them.
 */
export async function importESLintRules(
	config: { [K in keyof ESLintRulesConfig]: Severity | [Severity, ...ESLintRulesConfig[K]] },
	context: Partial<ESLint.Rule.RuleContext> = {},
) {
	let convertRule: typeof import('@tsslint/compat-eslint').convertRule;
	try {
		({ convertRule } = await import('@tsslint/compat-eslint'));
	}
	catch {
		throw new Error('Please install @tsslint/compat-eslint to use importESLintRules().');
	}

	const rules: TSSLint.Rules = {};
	for (const [rule, severityOrOptions] of Object.entries(config)) {
		let severity: Severity;
		let options: any[];
		if (Array.isArray(severityOrOptions)) {
			[severity, ...options] = severityOrOptions;
		}
		else {
			severity = severityOrOptions;
			options = [];
		}
		if (!severity) {
			rules[rule] = noop;
			continue;
		}
		const ruleModule = await loadRuleByKey(rule);
		if (!ruleModule) {
			throw new Error(`Failed to resolve rule "${rule}".`);
		}
		rules[rule] = convertRule(
			ruleModule,
			options,
			{ id: rule, ...context },
			severity === 'error'
				? 1 satisfies ts.DiagnosticCategory.Error
				: severity === 'warn'
				? 0 satisfies ts.DiagnosticCategory.Warning
				: 3 satisfies ts.DiagnosticCategory.Message,
		);
	}
	return rules;
}

function* resolveRuleKey(rule: string): Generator<[
	pluginName: string | undefined,
	ruleName: string,
]> {
	const slashIndex = rule.indexOf('/');
	if (slashIndex !== -1) {
		let pluginName = rule.startsWith('@')
			? `${rule.slice(0, slashIndex)}/eslint-plugin`
			: `eslint-plugin-${rule.slice(0, slashIndex)}`;
		let ruleName = rule.slice(slashIndex + 1);

		yield [pluginName, ruleName];

		if (ruleName.indexOf('/') >= 0) {
			pluginName += `-${ruleName.slice(0, ruleName.indexOf('/'))}`;
			ruleName = ruleName.slice(ruleName.indexOf('/') + 1);
			yield [pluginName, ruleName];
		}
	}
	else {
		yield [undefined, rule];
	}
}

async function loadRuleByKey(rule: string): Promise<ESLint.Rule.RuleModule | undefined> {
	for (const resolved of resolveRuleKey(rule)) {
		const ruleModule = await loadRule(...resolved);
		if (ruleModule) {
			return ruleModule;
		}
	}
}

async function loadRule(pluginName: string | undefined, ruleName: string): Promise<ESLint.Rule.RuleModule | undefined> {
	if (pluginName) {
		plugins[pluginName] ??= loader(pluginName);
		const plugin = await plugins[pluginName];
		return plugin?.rules[ruleName];
	}
	let dir = __dirname;
	while (true) {
		const rulePath = path.join(dir, 'node_modules', 'eslint', 'lib', 'rules', `${ruleName}.js`);
		if (fs.existsSync(rulePath)) {
			return loader(rulePath);
		}
		const parentDir = path.resolve(dir, '..');
		if (parentDir === dir) {
			break;
		}
		dir = parentDir;
	}
}
