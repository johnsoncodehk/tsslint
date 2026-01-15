import type * as TSSLint from '@tsslint/types';
import type { IOptions, IRule, IRuleMetadata, ITypedRule } from 'tslint';
import type * as ts from 'typescript';

export type * from 'tslint';

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
