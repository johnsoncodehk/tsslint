import type * as TSSLint from '@tsslint/types';
import * as fs from 'fs';
import * as path from 'path';
import type { IOptions, IRule, IRuleMetadata, ITypedRule } from 'tslint';
import type * as ts from 'typescript';
import type { TSLintRulesConfig } from './tslint-types.js';
import { normalizeRuleSeverity, type RuleSeverity } from './utils.js';

const noop = () => {};

/**
 * Converts a TSLint rules configuration to TSSLint rules.
 *
 * ⚠️ **Type definitions not generated**
 *
 * Please run `npx tsslint-docgen` to update them.
 */
export async function importTSLintRules(
	config: { [K in keyof TSLintRulesConfig]: RuleSeverity | [RuleSeverity, ...TSLintRulesConfig[K]] },
) {
	const rules: TSSLint.Rules = {};
	const rulesDirectories = getTSLintRulesDirectories();

	for (const [ruleName, severityOrOptions] of Object.entries(config)) {
		let severity: RuleSeverity;
		let options: any[];
		if (Array.isArray(severityOrOptions)) {
			[severity, ...options] = severityOrOptions;
		}
		else {
			severity = severityOrOptions;
			options = [];
		}
		severity = normalizeRuleSeverity(severity);
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
			severity === 'error'
				? 1 satisfies ts.DiagnosticCategory.Error
				: severity === 'warn'
				? 0 satisfies ts.DiagnosticCategory.Warning
				: 3 satisfies ts.DiagnosticCategory.Message,
		);
	}
	return rules;
}

export function getTSLintRulesDirectories(): [string, string][] {
	const directories: [string, string][] = [];
	let dir = __dirname;
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
						directories.push([rulesDir, path.resolve(dir, rulesDir)]);
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

async function loadTSLintRule(ruleName: string, rulesDirectories: [string, string][]): Promise<any | undefined> {
	const camelCaseName = ruleName.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
	const ruleFileName = `${camelCaseName.charAt(0).toUpperCase() + camelCaseName.slice(1)}Rule.js`;

	for (const [, rulesDir] of rulesDirectories) {
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

function convertRule(
	Rule: {
		metadata?: IRuleMetadata;
		new(options: IOptions): IRule;
	},
	ruleArguments: any[] = [],
	category: ts.DiagnosticCategory = 3 satisfies ts.DiagnosticCategory.Message,
): TSSLint.Rule {
	const rule = new Rule({
		ruleName: Rule.metadata?.ruleName ?? 'unknown',
		ruleArguments,
		ruleSeverity: 'warning',
		disabledIntervals: [],
	}) as IRule | ITypedRule;
	return ({ typescript: ts, file, report, ...ctx }) => {
		if (Rule.metadata?.typescriptOnly) {
			const scriptKind = (file as any).scriptKind;
			if (scriptKind === ts.ScriptKind.JS || scriptKind === ts.ScriptKind.JSX) {
				return;
			}
		}

		const failures = 'applyWithProgram' in rule
			? rule.applyWithProgram(file, ctx.program)
			: rule.apply(file);
		for (const failure of failures) {
			const reporter = report(
				failure.getFailure(),
				failure.getStartPosition().getPosition(),
				failure.getEndPosition().getPosition(),
			).at(new Error(), Number.MAX_VALUE);

			if (category === 0 satisfies ts.DiagnosticCategory.Warning) {
				reporter.asWarning();
			}
			else if (category === 1 satisfies ts.DiagnosticCategory.Error) {
				reporter.asError();
			}
			else if (category === 2 satisfies ts.DiagnosticCategory.Suggestion) {
				reporter.asSuggestion();
			}

			if (failure.hasFix()) {
				const ruleName = Rule.metadata?.ruleName;
				reporter.withFix(
					ruleName ? `Fix with ${ruleName}` : 'Fix',
					() => {
						const fix = failure.getFix();
						const replaces = Array.isArray(fix) ? fix : fix ? [fix] : [];
						return [{
							fileName: file.fileName,
							textChanges: replaces.map(replace => ({
								newText: replace.text,
								span: {
									start: replace.start,
									length: replace.length,
								},
							})),
						}];
					},
				);
			}
		}
	};
}
