// Curated rule set for per-rule parity bench. Each rule is associated
// with the corpus pattern it exercises. Add a new rule here when you
// want it included in the parity gate; new rules MUST have `npm run
// bench -- --update-baseline` run to record their expected output
// before merging.
//
// Format: `[ruleName, options?]`. Options are merged with the rule's
// `meta.defaultOptions` the same way ESLint does (deepMergeArrays).
export const RULES: Array<[string, unknown[]?]> = [
	// scope-manager surface
	['no-shadow'],
	['no-redeclare'],
	['no-undef'],
	['no-use-before-define', [{ functions: false, classes: false }]],
	['no-loop-func'],
	['prefer-const'],

	// AST-shape surface
	['no-sequences'],
	['no-useless-computed-key'],
	['arrow-body-style', ['as-needed']],
	['no-bitwise'],

	// CPA-driving rules (force the dispatcher's slow path)
	['consistent-return'],
	['no-unreachable'],
	['no-unreachable-loop'],
	['array-callback-return'],

	// Selector dispatch (esquery)
	['no-restricted-syntax', [{ selector: 'TSNullKeyword', message: 'no null type' }]],

	// Pattern / declaration shape
	['no-var'],
	['no-empty-pattern'],
	['no-self-assign'],
	['no-fallthrough'],
];
