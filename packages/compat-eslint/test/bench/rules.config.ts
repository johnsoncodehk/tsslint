// Curated rule set for per-rule parity bench. Mirrors the
// production-shape config TS repo uses (eslint.config.mjs +
// tsslint.config.ts) plus a handful of common defaults.
//
// Format: `[ruleName, options?]`. Options are merged with the
// rule's `meta.defaultOptions` the same way ESLint does
// (deepMergeArrays).
//
// New rule? Append below + run `pnpm bench -- --update-baseline`.
// If the rule needs a corpus pattern that doesn't exist yet, add
// the file to `corpus/` first.
export const RULES: Array<[string, unknown[]?]> = [
	// === scope-manager surface ===
	['no-shadow'],
	['no-redeclare'],
	['no-undef'],
	['no-use-before-define', [{ functions: false, classes: false }]],
	['no-loop-func'],
	['prefer-const'],
	['block-scoped-var'],
	['no-shadow-restricted-names'],

	// === control-flow / CPA ===
	['consistent-return'],
	['no-unreachable'],
	['no-unreachable-loop'],
	['array-callback-return'],
	['getter-return'],
	['no-useless-return'],
	['no-fallthrough'],
	['default-case-last'],

	// === AST shape ===
	['no-sequences'],
	['no-useless-computed-key'],
	['no-useless-rename'],
	['no-useless-constructor'],
	['no-useless-catch'],
	['no-useless-concat'],
	['arrow-body-style', ['as-needed']],
	['prefer-arrow-callback'],
	['prefer-rest-params'],
	['prefer-spread'],
	['prefer-numeric-literals'],
	['prefer-exponentiation-operator'],
	['prefer-object-spread'],
	['object-shorthand'],

	// === expressions / operators ===
	['no-bitwise'],
	['no-cond-assign'],
	['no-self-assign'],
	['no-self-compare'],
	['no-extra-boolean-cast'],
	['no-implicit-coercion'],
	['no-unneeded-ternary'],
	['eqeqeq'],
	['yoda'],
	['use-isnan'],
	['valid-typeof'],

	// === declarations / patterns ===
	['no-var'],
	['no-empty-pattern'],
	['no-empty'],
	['no-duplicate-case'],
	['no-dupe-else-if'],
	['no-dupe-keys'],
	['no-duplicate-imports'],
	['no-ex-assign'],
	['no-undef-init'],

	// === literals / functions / constructors ===
	['no-caller'],
	['no-eval'],
	['no-extra-bind'],
	['no-new'],
	['no-new-func'],
	['no-new-object'],
	['no-new-wrappers'],
	['no-octal'],
	['no-octal-escape'],
	['no-throw-literal'],
	['no-multi-str'],
	['no-misleading-character-class'],
	['no-regex-spaces'],
	['no-template-curly-in-string'],
	['no-return-await'],
	['symbol-description'],
	['radix'],
	['dot-notation'],

	// === selectors / esquery dispatch ===
	['no-restricted-syntax', [{ selector: 'TSNullKeyword', message: 'no null type' }]],

	// === iteration / loops ===
	['no-unmodified-loop-condition'],
	['no-unused-labels'],

	// === structural ===
	['no-lone-blocks'],
	['no-lonely-if'],
	['no-with'],
	['no-iterator'],
	['no-proto'],
	['no-constant-condition', [{ checkLoops: false }]],
	['no-constant-binary-expression'],

	// === class / accessor surface ===
	['class-methods-use-this'],
	['accessor-pairs'],
	['grouped-accessor-pairs'],
	['constructor-super'],
	['no-this-before-super'],
	['no-invalid-this'],

	// === generators / parameter / destructure ===
	['require-yield'],
	['no-param-reassign'],
	['prefer-destructuring'],
];
