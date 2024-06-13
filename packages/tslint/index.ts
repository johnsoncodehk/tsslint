import type * as TSSLint from '@tsslint/types';
import type * as TSLint from 'tslint';
import { WalkContext } from 'tslint/lib/language/walker';
import type * as ts from 'typescript';

export function convertRule(
	Rule: import('tslint/lib/language/rule/rule').RuleConstructor,
	severity: ts.DiagnosticCategory = 3
): TSSLint.Rule {
	const rule = new Rule({
		ruleName: '',
		ruleArguments: [],
		ruleSeverity: severity === 1 ? 'error' : severity === 2 ? 'warning' : 'off',
		disabledIntervals: [],
	});
	return ({ sourceFile, languageService, reportError, reportWarning, reportSuggestion }) => {
		let lastFailure: TSLint.RuleFailure | undefined;
		const report = severity === 1 ? reportError : severity === 2 ? reportWarning : reportSuggestion;
		const onAddFailure = (failure: TSLint.RuleFailure) => {
			if (lastFailure === failure) {
				return;
			}
			lastFailure = failure;
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
