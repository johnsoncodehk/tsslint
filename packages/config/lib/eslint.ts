import type * as TSSLint from '@tsslint/types';
import type * as ESLint from 'eslint';
import * as fs from 'fs';
import * as path from 'path';
import type * as ts from 'typescript';
import type { ESLintRulesConfig } from './eslint-types.js';
import { normalizeRuleSeverity, type RuleSeverity } from './utils.js';

const noop = () => {};
const plugins: Record<
	string,
	Promise<
		{
			rules: Record<string, ESLint.Rule.RuleModule>;
		} | undefined
	>
> = {};
const loader = async (moduleName: string) => {
	let mod: {} | undefined;
	try {
		mod ??= require(moduleName);
	}
	catch {}
	try {
		mod ??= await import(moduleName);
	}
	catch {}
	if (mod && 'default' in mod) {
		return mod.default;
	}
	return mod as any;
};

// Per-plugin "where do individual rule files live" cache. Filled the first
// time we successfully load a rule from that plugin, then reused for every
// subsequent rule from the same plugin so we never have to require the
// whole plugin (which on `@typescript-eslint/eslint-plugin` is ~400 ms
// cold start to load all ~150 rules eagerly).
//
// `null` means "we tried to detect a per-rule layout and couldn't — fall
// back to whole-plugin require for any rule from this plugin".
const pluginRuleLoaders = new Map<string, ((ruleName: string) => ESLint.Rule.RuleModule | undefined) | null>();

// Common per-rule directory layouts in published ESLint plugins.
//   `dist/rules/<name>.js`      — @typescript-eslint, eslint-plugin-jsdoc (newer)
//   `lib/rules/<name>.js`       — eslint-plugin-react / import / vue / n / jsx-a11y
//   `rules/<name>.js`           — eslint-plugin-unicorn / promise
//   `build/rules/<name>.js`     — some Babel-built plugins
//   `src/rules/<name>.js`       — published-from-source plugins (rare)
//
// Each candidate is probed with the FIRST rule we're asked to load. The
// directory that has that rule's file wins; remember the layout so later
// rules go straight to disk by absolute path.
const RULE_DIR_CANDIDATES = ['dist/rules', 'lib/rules', 'rules', 'build/rules', 'src/rules'];
const RULE_FILE_EXTS = ['.js', '.cjs'];

function detectRuleLoader(pluginName: string, probeRuleName: string): ((ruleName: string) => ESLint.Rule.RuleModule | undefined) | null {
	let pkgRoot: string;
	try {
		pkgRoot = path.dirname(require.resolve(`${pluginName}/package.json`));
	}
	catch {
		return null;
	}
	for (const dir of RULE_DIR_CANDIDATES) {
		for (const ext of RULE_FILE_EXTS) {
			const probePath = path.join(pkgRoot, dir, probeRuleName + ext);
			if (!fs.existsSync(probePath)) continue;
			// Lock in this dir + ext for every subsequent rule from this plugin.
			// Absolute-path `require()` bypasses the package's `exports` field
			// (which in @typescript-eslint blocks `dist/rules/<name>` access),
			// so this works even when the plugin doesn't expose individual
			// rules as a public subpath.
			//
			// Pre-warm the plugin's shared dependency tree behind a
			// stable, plugin-named profile frame. Without this, the
			// first rule we happen to load gets blamed for ~150–250 ms
			// of `@typescript-eslint/utils` + `scope-manager` +
			// `typescript-estree` etc. transitive load — and which rule
			// that is depends on the user's config-object key order.
			// The pre-warm gives that cost a deterministic attribution
			// (`<pluginName>:init` shows up in the flame graph) and
			// leaves every subsequent rule frame as pure rule-body
			// load time.
			const initKey = JSON.stringify(pluginName + ':init');
			const probeAbs = path.join(pkgRoot, dir, probeRuleName + ext);
			(new Function('warm', `({ ${initKey}: () => warm() })[${initKey}]();`)(
				() => { try { require(probeAbs); } catch {} },
			));
			// Per-rule named thunk. NamedEvaluation on a computed
			// property key (`{ [name]: () => ... }`) sets
			// `Function.prototype.name` at runtime — visible to stack
			// traces, but V8's CPU profile uses the parse-time-inferred
			// SharedFunctionInfo name and ignores runtime renames. To
			// get a parse-time literal name we compile per-thunk source
			// with `new Function`, baking the rule name in as a string
			// literal. Same trick ESLint core's `LazyLoadingRuleMap`
			// achieves with static-keyed object literals.
			return (ruleName) => {
				const filePath = path.join(pkgRoot, dir, ruleName + ext);
				const key = JSON.stringify(ruleName);
				const thunk = new Function('requireFn', `return ({ ${key}: () => requireFn() })[${key}];`)(
					() => {
						try {
							const m = require(filePath);
							return (m && 'default' in m ? m.default : m);
						}
						catch {
							return undefined;
						}
					},
				) as () => ESLint.Rule.RuleModule | undefined;
				return thunk();
			};
		}
	}
	return null;
}

/**
 * Converts an ESLint rules configuration to TSSLint rules.
 *
 * ⚠️ **Type definitions not generated**
 *
 * Please run `npx tsslint-docgen` to update them.
 */
export async function importESLintRules(
	config: { [K in keyof ESLintRulesConfig]: RuleSeverity | [RuleSeverity, ...ESLintRulesConfig[K]] },
	context: Partial<ESLint.Rule.RuleContext> = {},
	getConvertRule = async () => {
		try {
			return (await import('@tsslint/compat-eslint')).convertRule;
		}
		catch {
			throw new Error('Please install @tsslint/compat-eslint to use importESLintRules().');
		}
	},
) {
	const convertRule = await getConvertRule();
	const rules: TSSLint.Rules = {};
	for (const [rule, severityOrOptions] of Object.entries(config)) {
		let severity: RuleSeverity;
		let options: any[];
		if (Array.isArray(severityOrOptions)) {
			[severity, ...options] = severityOrOptions;
		}
		else {
			severity = severityOrOptions;
			options = [];
		}
		severity = normalizeRuleSeverity(severity);
		if (!severity) {
			rules[rule] = noop;
			continue;
		}
		const ruleModule = await loadRuleByKey(rule);
		if (!ruleModule) {
			throw new Error(`Failed to resolve rule "${rule}".`);
		}
		rules[rule] = convertRule(
			ruleModule,
			options,
			{ id: rule, ...context },
			severity === 'error'
				? 1 satisfies ts.DiagnosticCategory.Error
				: severity === 'warn'
				? 0 satisfies ts.DiagnosticCategory.Warning
				: 3 satisfies ts.DiagnosticCategory.Message,
		);
	}
	return rules;
}

function* resolveRuleKey(rule: string): Generator<[
	pluginName: string | undefined,
	ruleName: string,
]> {
	const slashIndex = rule.indexOf('/');
	if (slashIndex !== -1) {
		let pluginName = rule.startsWith('@')
			? `${rule.slice(0, slashIndex)}/eslint-plugin`
			: `eslint-plugin-${rule.slice(0, slashIndex)}`;
		let ruleName = rule.slice(slashIndex + 1);

		yield [pluginName, ruleName];

		if (ruleName.indexOf('/') >= 0) {
			pluginName += `-${ruleName.slice(0, ruleName.indexOf('/'))}`;
			ruleName = ruleName.slice(ruleName.indexOf('/') + 1);
			yield [pluginName, ruleName];
		}
	}
	else {
		yield [undefined, rule];
	}
}

async function loadRuleByKey(rule: string): Promise<ESLint.Rule.RuleModule | undefined> {
	for (const resolved of resolveRuleKey(rule)) {
		const ruleModule = await loadRule(...resolved);
		if (ruleModule) {
			return ruleModule;
		}
	}
}

async function loadRule(pluginName: string | undefined, ruleName: string): Promise<ESLint.Rule.RuleModule | undefined> {
	if (pluginName) {
		// Try per-rule lazy load first — saves loading the whole plugin's
		// ~all-rules-eager bundle. On a 30-rule typescript-eslint config
		// this saves ~150 ms cold start vs requiring the whole plugin.
		let lazy = pluginRuleLoaders.get(pluginName);
		if (lazy === undefined) {
			lazy = detectRuleLoader(pluginName, ruleName);
			pluginRuleLoaders.set(pluginName, lazy);
		}
		if (lazy) {
			const r = lazy(ruleName);
			if (r) return r;
			// Layout was detected but this specific rule's file doesn't
			// exist there (rule renamed / moved / lives under a sub-path).
			// Fall through to whole-plugin load below.
		}
		// Fallback: ESM-only plugins, plugins with no recognisable layout,
		// or rules whose file doesn't sit at `<dir>/<name>.js`. Pay the
		// eager cost once per plugin.
		plugins[pluginName] ??= loader(pluginName);
		const plugin = await plugins[pluginName];
		return plugin?.rules[ruleName];
	}
	let dir = __dirname;
	while (true) {
		const rulePath = path.join(dir, 'node_modules', 'eslint', 'lib', 'rules', `${ruleName}.js`);
		if (fs.existsSync(rulePath)) {
			return require(rulePath);
		}
		const parentDir = path.resolve(dir, '..');
		if (parentDir === dir) {
			break;
		}
		dir = parentDir;
	}
}
