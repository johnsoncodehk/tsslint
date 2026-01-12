import type * as TSSLint from '@tsslint/types';
import type { IOptions, IRule, IRuleMetadata, ITypedRule } from 'tslint';
import type * as ts from 'typescript';

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
	return ({ file, languageService, report }) => {
		const failures = 'applyWithProgram' in rule
			? rule.applyWithProgram(file, languageService.getProgram()!)
			: rule.apply(file);
		for (const failure of failures) {
			const reporter = report(
				failure.getFailure(),
				failure.getStartPosition().getPosition(),
				failure.getEndPosition().getPosition(),
				category,
				[new Error(), Number.MAX_VALUE]
			);
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

export { defineRules } from './defineRules';
