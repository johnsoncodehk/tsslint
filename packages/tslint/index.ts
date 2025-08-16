import type * as TSSLint from '@tsslint/types';
import type * as TSLint from 'tslint';

type TSLintRule = import('tslint/lib/language/rule/rule').RuleConstructor;

export function convertRule<T extends Partial<TSLintRule> | TSLintRule>(
	Rule: T,
	ruleArguments: any[] = [],
): TSSLint.Rule {
	const rule = new (Rule as TSLintRule)({
		ruleName: Rule.metadata?.ruleName ?? 'unknown',
		ruleArguments,
		ruleSeverity: 'warning',
		disabledIntervals: [],
	}) as TSLint.IRule | TSLint.ITypedRule;
	return ({ sourceFile, languageService, report }) => {
		let lastFailure: TSLint.RuleFailure | undefined;
		const onAddFailure = (failure: TSLint.RuleFailure) => {
			if (lastFailure === failure) {
				return;
			}
			lastFailure = failure;
			const reporter = report(
				failure.getFailure(),
				failure.getStartPosition().getPosition(),
				failure.getEndPosition().getPosition(),
				Number.MAX_VALUE
			);
			if (failure.hasFix()) {
				const fix = failure.getFix();
				const replaces = Array.isArray(fix) ? fix : [fix];
				for (const replace of replaces) {
					if (replace) {
						reporter.withFix(
							replace.length === 0
								? 'Insert ' + replace.text
								: replace.text.length === 0
									? 'Delete ' + replace.start + ' to ' + replace.end
									: 'Replace with ' + replace.text,
							() => [{
								fileName: sourceFile.fileName,
								textChanges: [{
									newText: replace.text,
									span: {
										start: replace.start,
										length: replace.length,
									},
								}],
							}]
						);
					}
				}
			}
		};
		const failures = 'applyWithProgram' in rule
			? rule.applyWithProgram(sourceFile, languageService.getProgram()!)
			: rule.apply(sourceFile);
		for (const failure of failures) {
			onAddFailure(failure);
		}
	};
}
