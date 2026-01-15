import type * as TSSLint from '@tsslint/types';
import type { IOptions, IRule, IRuleMetadata, ITypedRule } from 'tslint';
import type * as ts from 'typescript';
import * as path from 'path';
import * as fs from 'fs';

export function convertRule(
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
	return ({ file, report, ...ctx }) => {
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

const noop = () => { };

/**
 * Converts a TSLint rules configuration to TSSLint rules.
 *
 * ---
 * ⚠️ **Type definitions not generated**
 *
 * Please add `@tsslint/compat-tslint` to `pnpm.onlyBuiltDependencies` in your `package.json` to allow the postinstall script to run.
 *
 * ```json
 * {
 *   "pnpm": {
 *     "onlyBuiltDependencies": ["@tsslint/compat-tslint"]
 *   }
 * }
 * ```
 *
 * After that, run `pnpm install` again to generate type definitions.
 *
 * If the type definitions become outdated, please run `npx tsslint-tslint-update` to update them.
 */
export async function importTSLintRules(
	config: Record<string, any>,
	category: ts.DiagnosticCategory = 3 satisfies ts.DiagnosticCategory.Message
) {
	const rules: TSSLint.Rules = {};
	const projectRoot = process.cwd();
	const tslintJsonPath = path.join(projectRoot, 'tslint.json');
	const rulesDirectories: string[] = [];

	if (fs.existsSync(tslintJsonPath)) {
		try {
			const tslintJson = JSON.parse(fs.readFileSync(tslintJsonPath, 'utf8'));
			if (tslintJson.rulesDirectory) {
				if (Array.isArray(tslintJson.rulesDirectory)) {
					rulesDirectories.push(...tslintJson.rulesDirectory);
				} else {
					rulesDirectories.push(tslintJson.rulesDirectory);
				}
			}
		} catch { }
	}

	const nodeModulesDir = path.join(projectRoot, 'node_modules');
	if (fs.existsSync(nodeModulesDir)) {
		rulesDirectories.push(path.join(nodeModulesDir, 'tslint', 'lib', 'rules'));
	}

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

		const Rule = loadRuleByName(ruleName, rulesDirectories, projectRoot);
		if (Rule) {
			rules[ruleName] = convertRule(Rule, options, category);
		} else {
			throw new Error(`Failed to resolve TSLint rule "${ruleName}".`);
		}
	}
	return rules;
}

function loadRuleByName(ruleName: string, rulesDirectories: string[], projectRoot: string) {
	const className = ruleName
		.split('-')
		.map(part => part.charAt(0).toUpperCase() + part.slice(1))
		.join('') + 'Rule';

	for (let rulesDir of rulesDirectories) {
		if (!path.isAbsolute(rulesDir)) {
			rulesDir = path.resolve(projectRoot, rulesDir);
		}
		const rulePath = path.join(rulesDir, className + '.js');
		if (fs.existsSync(rulePath)) {
			try {
				const mod = require(rulePath);
				return mod.Rule;
			} catch { }
		}
	}
	return undefined;
}
