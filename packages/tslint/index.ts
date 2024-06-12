import type * as TSSLint from '@tsslint/types';
import type * as TSLint from 'tslint';
import { WalkContext } from 'tslint/lib/language/walker';

export function convertRule(
	Rule: import('tslint/lib/language/rule/rule').RuleConstructor
): TSSLint.Rule {
	const rule = new Rule({
		ruleName: '',
		ruleArguments: [],
		ruleSeverity: 'warning',
		disabledIntervals: [],
	});
	return ({ sourceFile, languageService, reportError, reportWarning }) => {
		const { ruleSeverity } = rule.getOptions();
		if (ruleSeverity === 'off') {
			return;
		}
		let lastFailure: TSLint.RuleFailure | undefined;
		const onAddFailure = (failure: TSLint.RuleFailure) => {
			if (lastFailure === failure) {
				return;
			}
			lastFailure = failure;
			failure.setRuleSeverity(ruleSeverity);
			const report = failure.getRuleSeverity() === 'error' ? reportError : reportWarning;
			const reporter = report(
				failure.getFailure(),
				failure.getStartPosition().getPosition(),
				failure.getEndPosition().getPosition(),
				4
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
		};
		// @ts-ignore
		rule.applyWithFunction = function (sourceFile, walkFn, options, programOrChecker) {
			// @ts-ignore
			const ctx = new WalkContext(sourceFile, rule.ruleName, options);
			const addFailure = ctx.addFailure.bind(ctx);
			const addFailureAt = ctx.addFailureAt.bind(ctx);
			const addFailureAtNode = ctx.addFailureAtNode.bind(ctx);
			ctx.addFailure = (...args) => {
				addFailure(...args);
				onAddFailure(ctx.failures[ctx.failures.length - 1]);
			};
			ctx.addFailureAt = (...args) => {
				addFailureAt(...args);
				onAddFailure(ctx.failures[ctx.failures.length - 1]);
			};
			ctx.addFailureAtNode = (...args) => {
				addFailureAtNode(...args);
				onAddFailure(ctx.failures[ctx.failures.length - 1]);
			};
			walkFn(ctx, programOrChecker);
			return ctx.failures;
		};
		Rule.metadata.requiresTypeInfo
			// @ts-expect-error
			? rule.applyWithProgram(sourceFile, languageService.getProgram()) as TSLint.RuleFailure[]
			: rule.apply(sourceFile);
	};
}
