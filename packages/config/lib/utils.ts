export type RuleSeverity = boolean | 'error' | 'warn';

type ESLintStringSeverity = 'off' | 'warn' | 'error';
type ESLintNumericSeverity = 0 | 1 | 2;
type TSLintStringSeverity = 'default' | 'warning' | 'warn' | 'error' | 'off' | 'none';
type TSLintBooleanSeverity = true | false;

export function normalizeRuleSeverity(
	severity:
		| RuleSeverity
		| ESLintStringSeverity
		| ESLintNumericSeverity
		| TSLintStringSeverity
		| TSLintBooleanSeverity,
): RuleSeverity {
	switch (severity) {
		case 'default':
			return true;
		case 0:
		case 'off':
		case 'none':
			return false;
		case 1:
		case 'warning':
			return 'warn';
		case 2:
			return 'error';
		default:
			return severity;
	}
}
