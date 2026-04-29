// Tests for the runtime probe that detects type-aware rules and skips
// caching their diagnostics. The per-file mtime cache can't track
// cross-file type dependencies; rules that read `rulesContext.program`
// must therefore be excluded from cache writes — and any pre-existing
// cache entry for them must be ignored once they've been classified.
//
// Run via:
//   node --experimental-strip-types --no-warnings packages/core/test/cache-typeaware.test.ts

import * as ts from 'typescript';
import type { Config, RuleContext } from '@tsslint/types';
import type { FileLintCache } from '../index.js';

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
	const languageService = ts.createLanguageService(host);
	return { typescript: ts, languageServiceHost: host, languageService };
}

function makeCache(): FileLintCache {
	return [Date.now(), {}, {}];
}

// ── Test 1: syntactic rule cached; type-aware rule not cached ─────────
{
	const ctx = makeContext({ '/a.ts': 'const x = 1;' });
	let syntacticRan = 0;
	let typeAwareRan = 0;
	const config: Config = {
		rules: {
			syntactic: ((rctx: RuleContext) => {
				syntacticRan++;
				rctx.report('plain', 0, 1);
			}) as any,
			'type-aware': ((rctx: RuleContext) => {
				typeAwareRan++;
				void rctx.program; // probe trigger
				rctx.report('typed', 0, 1);
			}) as any,
		},
	};
	const linter = core.createLinter(ctx, '/', config, () => []);
	const cache = makeCache();
	linter.lint('/a.ts', cache);

	check('syntactic ran', syntacticRan === 1);
	check('type-aware ran', typeAwareRan === 1);
	check(
		'syntactic cache entry written',
		!!cache[1]['syntactic'],
		'expected cache[1][syntactic] to be set',
	);
	check(
		'type-aware cache entry NOT written',
		!cache[1]['type-aware'],
		`expected cache[1][type-aware] to be undefined, got ${JSON.stringify(cache[1]['type-aware'])}`,
	);
}

// ── Test 2: rule reports BEFORE touching program — cache entry deleted ─
{
	const ctx = makeContext({ '/a.ts': 'const x = 1;' });
	const config: Config = {
		rules: {
			'report-then-touch': ((rctx: RuleContext) => {
				rctx.report('first', 0, 1); // populates cache[1] via report()
				void rctx.program;     // sets touchedProgram
			}) as any,
		},
	};
	const linter = core.createLinter(ctx, '/', config, () => []);
	const cache = makeCache();
	linter.lint('/a.ts', cache);

	check(
		'report-then-touch cache entry deleted',
		!cache[1]['report-then-touch'],
		'expected cache to be empty after delete',
	);
}

// ── Test 3: classification sticks across files in same session ─────────
{
	const ctx = makeContext({
		'/a.ts': 'const x = 1;',
		'/b.ts': 'const y = 2;',
	});
	let touchCount = 0;
	const config: Config = {
		rules: {
			'sometimes-typed': ((rctx: RuleContext) => {
				if (rctx.file.fileName === '/a.ts') {
					touchCount++;
					void rctx.program;
				}
				rctx.report('hi', 0, 1);
			}) as any,
		},
	};
	const linter = core.createLinter(ctx, '/', config, () => []);
	const cacheA = makeCache();
	const cacheB = makeCache();
	linter.lint('/a.ts', cacheA); // touches program
	linter.lint('/b.ts', cacheB); // does NOT touch on this file

	check('rule touched program once', touchCount === 1);
	check(
		'/a.ts cache entry deleted (touched)',
		!cacheA[1]['sometimes-typed'],
		'expected cacheA empty',
	);
	check(
		'/b.ts cache entry NOT written (sticky)',
		!cacheB[1]['sometimes-typed'],
		`expected cacheB empty due to sticky type-aware classification, got ${JSON.stringify(cacheB[1]['sometimes-typed'])}`,
	);
}

// ── Test 4: pre-existing cache entry ignored after classification ──────
{
	const ctx = makeContext({ '/a.ts': 'const x = 1;' });
	let ran = 0;
	const config: Config = {
		rules: {
			'type-aware': ((rctx: RuleContext) => {
				ran++;
				void rctx.program;
				rctx.report('typed', 0, 1);
			}) as any,
		},
	};
	const linter = core.createLinter(ctx, '/', config, () => []);

	// Simulate a cache that already has an entry for this rule (e.g. from
	// pre-fix 3.1.0 where type-aware results were cached).
	const cache: FileLintCache = [
		Date.now(),
		{
			'type-aware': [false, [{
				category: ts.DiagnosticCategory.Message,
				code: 'type-aware' as any,
				messageText: 'stale',
				file: undefined as any,
				start: 0,
				length: 1,
				source: 'tsslint',
			} as ts.DiagnosticWithLocation]],
		},
		{},
	];

	// First file: rule runs (no classification yet) — current code uses
	// the cached entry. This is the existing soundness gap on cold sessions.
	linter.lint('/a.ts', cache);
	check('first invocation reused stale cache (cold session limit)', ran === 0);

	// Second file (same linter session): now classified type-aware,
	// pre-existing cache entry must be ignored.
	const ctx2 = makeContext({ '/b.ts': 'const x = 1;' });
	const cache2: FileLintCache = [
		Date.now(),
		{
			'type-aware': [false, [{
				category: ts.DiagnosticCategory.Message,
				code: 'type-aware' as any,
				messageText: 'stale',
				file: undefined as any,
				start: 0,
				length: 1,
				source: 'tsslint',
			} as ts.DiagnosticWithLocation]],
		},
		{},
	];
	let ran2 = 0;
	const config2: Config = {
		rules: {
			'type-aware': ((rctx: RuleContext) => {
				ran2++;
				void rctx.program;
				rctx.report('typed', 0, 1);
			}) as any,
		},
	};
	const linter3 = core.createLinter(ctx2, '/', config2, () => []);
	// First lint touches program → marks rule type-aware in this linter
	linter3.lint('/b.ts', makeCache());
	// Second lint with stale cache → should not be served, should re-run
	linter3.lint('/b.ts', cache2);
	check(
		'cached entry ignored after classification',
		ran2 === 2,
		`expected rule to run twice (once to classify, once because stale cache ignored), got ${ran2}`,
	);
	check(
		'stale cache entry deleted by re-run',
		!cache2[1]['type-aware'],
	);
}

// ── Done ───────────────────────────────────────────────────────────────
process.stdout.write('\n');
if (failures.length) {
	console.error(`\n${failures.length} failure(s):`);
	for (const f of failures) console.error('  - ' + f);
	process.exit(1);
}
console.log('OK');
