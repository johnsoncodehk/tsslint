import type * as TSSLint from '@tsslint/types';
import type * as TSLint from 'tslint';
import type * as ts from 'typescript';

type TSLintRule = import('tslint/lib/language/rule/rule').RuleConstructor;

export function convertRule<T extends Partial<TSLintRule> | TSLintRule>(
	Rule: T,
	ruleArguments: any[] = [],
	severity: ts.DiagnosticCategory =
		!Rule.metadata || Rule.metadata.type === 'functionality' || Rule.metadata.type === 'typescript' ? 1 satisfies ts.DiagnosticCategory.Error
			: Rule.metadata.type === 'maintainability' || Rule.metadata.type === 'style' ? 0 satisfies ts.DiagnosticCategory.Warning
				: Rule.metadata.type === 'formatting' ? 2 satisfies ts.DiagnosticCategory.Suggestion
					: 3 satisfies ts.DiagnosticCategory.Message
): TSSLint.Rule {
	const rule = new (Rule as TSLintRule)({
		ruleName: Rule.metadata?.ruleName ?? 'unknown',
		ruleArguments,
		ruleSeverity: severity === 1 ? 'error' : severity === 2 ? 'warning' : 'off',
		disabledIntervals: [],
	}) as TSLint.IRule | TSLint.ITypedRule;
	return ({ typescript: ts, sourceFile, languageService, reportError, reportWarning, reportSuggestion }) => {
		let lastFailure: TSLint.RuleFailure | undefined;
		const report =
			severity === ts.DiagnosticCategory.Error ? reportError
				: severity === ts.DiagnosticCategory.Warning ? reportWarning
					: reportSuggestion;
		const onAddFailure = (failure: TSLint.RuleFailure) => {
			if (lastFailure === failure) {
				return;
			}
			lastFailure = failure;
			const reporter = report(
				failure.getFailure(),
				failure.getStartPosition().getPosition(),
				failure.getEndPosition().getPosition(),
				false
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
