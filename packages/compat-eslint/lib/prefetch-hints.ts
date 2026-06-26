// Derive tsgo type-prefetch plans from ESLint rule listener selectors.
// Reuses selector-analysis so prefetch only batch-resolves types for
// node patterns enabled rules actually trigger on.

import type * as ESLint from 'eslint';
import type { Rule } from '@tsslint/types';
import { decomposeSimple, isCodePathListener } from './selector-analysis.js';
import { visitorKeys } from './visitor-keys.js';

const TYPE_ASSERTION_ESTREE = new Set([
	'TSAsExpression',
	'TSTypeAssertion',
	'TSSatisfiesExpression',
]);

export interface RulePrefetchHints {
	fullTraversal: boolean;
	memberAccess: boolean;
	typeAssertions: boolean;
	symbolFallback: boolean;
	contextualCalls: boolean;
	propertiesOfType: boolean;
}

export interface PrefetchPlan {
	memberAccess: boolean;
	typeAssertions: boolean;
	symbolFallback: boolean;
	contextualCalls: boolean;
	propertiesOfType: boolean;
}

export const EMPTY_PREFETCH_PLAN: PrefetchPlan = {
	memberAccess: false,
	typeAssertions: false,
	symbolFallback: false,
	contextualCalls: false,
	propertiesOfType: false,
};

const CONSERVATIVE_TYPE_AWARE: PrefetchPlan = {
	memberAccess: true,
	typeAssertions: true,
	symbolFallback: true,
	contextualCalls: true,
	propertiesOfType: false,
};

function tryCreateRule(eslintRule: ESLint.Rule.RuleModule): Record<string, unknown> | undefined {
	if (typeof eslintRule.create !== 'function') return undefined;
	try {
		return eslintRule.create({
			id: 'prefetch-probe',
			options: (eslintRule.meta?.defaultOptions as unknown[]) ?? [],
			settings: {},
			parserOptions: { ecmaVersion: 2026, sourceType: 'module', ecmaFeatures: {} },
			languageOptions: { ecmaVersion: 2026, sourceType: 'module' },
			parserPath: null,
			getSourceCode() {
				return {
					ast: {
						type: 'Program',
						body: [],
						sourceType: 'module',
						tokens: [],
						comments: [],
						loc: { start: { line: 1, column: 0 }, end: { line: 1, column: 0 } },
					},
					text: '',
					lines: [''],
					hasBOM: false,
					scopeManager: null,
					visitorKeys,
					getText: () => '',
					getAllComments: () => [],
					getComments: () => [],
					getNodeByRangeIndex: () => null,
					getTokenByRangeStart: () => null,
					getTokens: () => [],
					getTokensBefore: () => [],
					getTokensAfter: () => [],
					getFirstToken: () => null,
					getLastToken: () => null,
					getTokenBefore: () => null,
					getTokenAfter: () => null,
					getFirstTokens: () => [],
					getLastTokens: () => [],
					getCommentsBefore: () => [],
					getCommentsAfter: () => [],
					getIndexFromLoc: () => 0,
					getLocFromIndex: () => ({ line: 1, column: 0 }),
					isSpaceBetween: () => false,
					isSpaceBetweenTokens: () => false,
					getScope: () => ({ variables: [], set: new Map(), upper: null, type: 'module' }),
					markVariableAsUsed: () => {},
				} as unknown as ESLint.SourceCode;
			},
			getFilename: () => 'probe.ts',
			getPhysicalFilename: () => 'probe.ts',
			getCwd: () => '/',
			report: () => {},
		} as unknown as ESLint.Rule.RuleContext) as Record<string, unknown>;
	}
	catch {
		return undefined;
	}
}

function isLikelyTypeAwareRule(eslintRule: ESLint.Rule.RuleModule, ruleId: string): boolean {
	const docs = eslintRule.meta?.docs as { requiresTypeChecking?: boolean } | undefined;
	if (docs?.requiresTypeChecking) return true;
	return ruleId.includes('@typescript-eslint/');
}

export function computePrefetchHints(
	eslintRule: ESLint.Rule.RuleModule,
	ruleId: string,
): RulePrefetchHints {
	const estreeTypes = new Set<string>();
	let fullTraversal = false;

	const created = tryCreateRule(eslintRule);
	if (created) {
		for (const key of Object.keys(created)) {
			if (isCodePathListener(key)) {
				fullTraversal = true;
				continue;
			}
			if (typeof created[key] !== 'function') continue;
			try {
				const infos = decomposeSimple(key);
				for (const info of infos) {
					if (info.types === 'all') {
						fullTraversal = true;
					}
					else {
						for (const t of info.types) estreeTypes.add(t);
					}
				}
			}
			catch {
				fullTraversal = true;
			}
		}
	}
	else if (isLikelyTypeAwareRule(eslintRule, ruleId)) {
		fullTraversal = true;
		estreeTypes.add('MemberExpression');
		estreeTypes.add('TSAsExpression');
	}

	const hasMember = estreeTypes.has('MemberExpression');
	const hasIdentifier = estreeTypes.has('Identifier');

	return {
		fullTraversal,
		memberAccess: hasMember,
		typeAssertions: [...TYPE_ASSERTION_ESTREE].some(t => estreeTypes.has(t)),
		symbolFallback: hasIdentifier || hasMember,
		contextualCalls: estreeTypes.has('CallExpression')
			|| estreeTypes.has('ArrowFunctionExpression'),
		propertiesOfType: false,
	};
}

export function mergePrefetchHints(
	rules: Record<string, Rule>,
	options?: {
		typeAwareRuleIds?: ReadonlySet<string>;
	},
): PrefetchPlan {
	let memberAccess = false;
	let typeAssertions = false;
	let symbolFallback = false;
	let contextualCalls = false;
	let propertiesOfType = false;
	let needsFallback = false;

	for (const [ruleId, rule] of Object.entries(rules)) {
		const hints = (rule as Rule & { prefetchHints?: RulePrefetchHints }).prefetchHints;
		if (!hints) {
			if (options?.typeAwareRuleIds?.has(ruleId)) {
				needsFallback = true;
			}
			continue;
		}
		memberAccess ||= hints.memberAccess;
		typeAssertions ||= hints.typeAssertions;
		symbolFallback ||= hints.symbolFallback;
		contextualCalls ||= hints.contextualCalls;
		propertiesOfType ||= hints.propertiesOfType;
	}

	if (needsFallback) {
		memberAccess ||= CONSERVATIVE_TYPE_AWARE.memberAccess;
		typeAssertions ||= CONSERVATIVE_TYPE_AWARE.typeAssertions;
		symbolFallback ||= CONSERVATIVE_TYPE_AWARE.symbolFallback;
		contextualCalls ||= CONSERVATIVE_TYPE_AWARE.contextualCalls;
		propertiesOfType ||= CONSERVATIVE_TYPE_AWARE.propertiesOfType;
	}

	if (!memberAccess && !typeAssertions && !symbolFallback
		&& !contextualCalls && !propertiesOfType) {
		return EMPTY_PREFETCH_PLAN;
	}
	return {
		memberAccess,
		typeAssertions,
		symbolFallback,
		contextualCalls,
		propertiesOfType,
	};
}
