// Tests for the `skipRules` option on `linter.lint`. The CLI cache
// layer uses this to bypass rules whose cached results it'll merge in
// itself — core just doesn't run them.
//
// Run via:
//   node packages/core/test/skip-rules.test.js

import * as ts from 'typescript';
import type { Config, RuleContext } from '@tsslint/types';

const core = require('../index.js') as typeof import('../index.js');

const failures: string[] = [];
function check(name: string, cond: boolean, detail?: string) {
	if (cond) {
		process.stdout.write('.');
	}
	else {
		failures.push(name + (detail ? ' — ' + detail : ''));
		process.stdout.write('F');
	}
}

function makeContext(files: Record<string, string>) {
	const realLibPath = ts.getDefaultLibFilePath({ target: ts.ScriptTarget.Latest });
	const realLibContent = ts.sys.readFile(realLibPath) ?? '';
	const host: ts.LanguageServiceHost = {
		getCompilationSettings: () => ({
			target: ts.ScriptTarget.Latest,
			noEmit: true,
			lib: [realLibPath.split(/[\\/]/).pop()!],
		}),
		getScriptFileNames: () => Object.keys(files),
		getScriptVersion: () => '1',
		getScriptSnapshot: n => {
			if (n in files) return ts.ScriptSnapshot.fromString(files[n]);
			if (n === realLibPath) return ts.ScriptSnapshot.fromString(realLibContent);
			return undefined;
		},
		getCurrentDirectory: () => '/',
		getDefaultLibFileName: () => realLibPath,
		fileExists: n => n in files || n === realLibPath,
		readFile: n => (n in files ? files[n] : (n === realLibPath ? realLibContent : undefined)),
	};
	return { typescript: ts, languageServiceHost: host, languageService: ts.createLanguageService(host) };
}

// ── Test 1: rule in skipRules doesn't run, no diagnostic in result ───────
{
	const ctx = makeContext({ '/a.ts': 'const x = 1;' });
	let runs = 0;
	const config: Config = {
		rules: {
			r: ((rctx: RuleContext) => {
				runs++;
				rctx.report('hi', 0, 1);
			}),
		},
	};
	const linter = core.createLinter(ctx, '/', config, () => []);
	const out = linter.lint('/a.ts', { skipRules: new Set(['r']) });
	check('skipped rule did not run', runs === 0);
	check('skipped rule produced no diagnostic', out.length === 0);
}

// ── Test 2: only the specified rule is skipped; others run normally ──────
{
	const ctx = makeContext({ '/a.ts': 'const x = 1;' });
	let aRuns = 0;
	let bRuns = 0;
	const config: Config = {
		rules: {
			a: ((rctx: RuleContext) => {
				aRuns++;
				rctx.report('a', 0, 1);
			}),
			b: ((rctx: RuleContext) => {
				bRuns++;
				rctx.report('b', 0, 1);
			}),
		},
	};
	const linter = core.createLinter(ctx, '/', config, () => []);
	const out = linter.lint('/a.ts', { skipRules: new Set(['a']) });
	check('a skipped', aRuns === 0);
	check('b ran', bRuns === 1);
	check('only b in result', out.length === 1 && String(out[0]?.code) === 'b');
}

// ── Test 3: lint without options runs everything (back-compat) ───────────
{
	const ctx = makeContext({ '/a.ts': 'const x = 1;' });
	let runs = 0;
	const config: Config = {
		rules: {
			r: ((rctx: RuleContext) => {
				runs++;
				rctx.report('x', 0, 1);
			}),
		},
	};
	const linter = core.createLinter(ctx, '/', config, () => []);
	linter.lint('/a.ts');
	check('lint without options runs rule', runs === 1);
}

// ── Test 4: skipped rule's classification is unchanged ──────────────────
//
// Probe runs only when a rule actually executes. A skipped rule's
// type-aware status comes from `initialTypeAwareRules` (or stays
// uncalculated). Skipping doesn't undo a prior classification.
{
	const ctx = makeContext({ '/a.ts': 'const x = 1;' });
	const config: Config = {
		rules: {
			r: ((rctx: RuleContext) => {
				void rctx.program;
				rctx.report('x', 0, 1);
			}),
		},
	};
	// Seed as type-aware. Then skip the rule. Classification persists.
	const linter = core.createLinter(ctx, '/', config, () => [], ['r']);
	linter.lint('/a.ts', { skipRules: new Set(['r']) });
	check('seeded classification persists when skipped', linter.getTypeAwareRules().has('r'));
}

// ── Test 5: hasFixForDiagnostic returns true only for diags with fixes ───
{
	const ctx = makeContext({ '/a.ts': 'const x = 1;' });
	const config: Config = {
		rules: {
			fixable: ((rctx: RuleContext) => {
				rctx.report('fix me', 0, 1).withFix('apply', () => []);
			}),
			plain: ((rctx: RuleContext) => {
				rctx.report('plain', 1, 2);
			}),
		},
	};
	const linter = core.createLinter(ctx, '/', config, () => []);
	const out = linter.lint('/a.ts');
	const fixable = out.find(d => String(d.code) === 'fixable')!;
	const plain = out.find(d => String(d.code) === 'plain')!;
	check('hasFixForDiagnostic true for fixable diag', linter.hasFixForDiagnostic('/a.ts', fixable) === true);
	check('hasFixForDiagnostic false for plain diag', linter.hasFixForDiagnostic('/a.ts', plain) === false);
}

// ── Done ────────────────────────────────────────────────────────────────
process.stdout.write('\n');
if (failures.length) {
	console.error(`\n${failures.length} failure(s):`);
	for (const f of failures) console.error('  - ' + f);
	process.exit(1);
}
console.log('OK');
