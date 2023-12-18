import * as TSLint from 'tslint';
import type { Rule } from './types';

export function parseTSLintRules(rules: TSLint.IRule[]) {
	const result: Record<string, Rule> = {};
	for (const rule of rules) {
		const { ruleName } = rule.getOptions();
		result[ruleName] = parseTSLintRule(rule);
	}
	return result;
}

export function parseTSLintRule(rule: TSLint.IRule): Rule {
	return ({ sourceFile, reportError, reportWarning }) => {
		const { ruleSeverity } = rule.getOptions();
		if (ruleSeverity === 'off') {
			return;
		}
		const failures = rule.apply(sourceFile);
		for (const failure of failures) {
			failure.setRuleSeverity(ruleSeverity);
			const report = failure.getRuleSeverity() === 'error' ? reportError : reportWarning;
			for (let i = 0; i < failures.length; i++) {
				const failure = failures[i];
				const reporter = report(
					failure.getFailure(),
					failure.getStartPosition().getPosition(),
					failure.getEndPosition().getPosition(),
					false,
				);
				if (failure.hasFix()) {
					const fix = failure.getFix();
					const replaces = Array.isArray(fix) ? fix : [fix];
					for (const replace of replaces) {
						if (replace) {
							reporter.withFix(
								'Replace with ' + replace.text,
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
			}
		}
	};
}
