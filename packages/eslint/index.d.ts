import type * as TSSLint from '@tsslint/types';
import type * as ESLint from 'eslint';
import type * as ts from 'typescript';
import type { ESLintRulesConfig } from './lib/types.js';
export { create as createShowDocsActionPlugin } from './lib/plugins/showDocsAction.js';
type S = 'off' | 'error' | 'warn' | 'suggestion' | 'message' | 0 | 1 | 2 | 3 | 4;
type O<T extends any[]> = S | [S, ...options: T];
/**
 * @deprecated Use `defineRules` instead
 */
export declare function convertRules(rulesConfig: {
    [K in keyof ESLintRulesConfig]: O<ESLintRulesConfig[K]>;
}, context?: Partial<ESLint.Rule.RuleContext>): Promise<TSSLint.Rules>;
	/**
	 * Converts an ESLint rules configuration to TSSLint rules.
	 *
	 * ---
	 * ⚠️ **Type definitions not generated**
	 *
	 * Please add `@tsslint/eslint` to `pnpm.onlyBuiltDependencies` in your `package.json` to allow the postinstall script to run.
	 *
	 * ```json
	 * {
	 *   "pnpm": {
	 *     "onlyBuiltDependencies": ["@tsslint/eslint"]
	 *   }
	 * }
	 * ```
	 *
	 * After that, run `pnpm install` again to generate type definitions.
	 * ---
	 */
export declare function defineRules(config: {
    [K in keyof ESLintRulesConfig]: boolean | ESLintRulesConfig[K];
}, context?: Partial<ESLint.Rule.RuleContext>, category?: ts.DiagnosticCategory): Promise<TSSLint.Rules>;
export declare function convertRule(eslintRule: ESLint.Rule.RuleModule, options?: any[], context?: Partial<ESLint.Rule.RuleContext>, category?: ts.DiagnosticCategory): TSSLint.Rule;
