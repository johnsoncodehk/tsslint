// Layer 1 cache: per-file mtime-driven cache for syntactic rules.
// Covers core's slice — read fileCache, skip rule on hit, write on miss.
// Type-aware rules never get cached regardless of fileCache state.
//
// Run via:
//   node packages/core/test/cache-layer1.test.js

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
	return { typescript: ts, languageServiceHost: host, languageService: ts.createLanguageService(host) };
}

// ── Test 1: syntactic rule writes cache entry ────────────────────────────
{
	const ctx = makeContext({ '/a.ts': 'const x = 1;' });
	const config: Config = {
		rules: {
			syntactic: ((rctx: RuleContext) => {
				rctx.report('hi', 0, 1);
			}) as any,
		},
	};
	const linter = core.createLinter(ctx, '/', config, () => []);
	const cache: FileLintCache = {};
	linter.lint('/a.ts', cache);
	check('syntactic rule cached', !!cache['syntactic']);
	check('cache has 1 diagnostic', cache['syntactic']?.diagnostics.length === 1);
	check('hasFix is false (no fix reported)', cache['syntactic']?.hasFix === false);
}

// ── Test 2: type-aware rule does not write cache entry ───────────────────
{
	const ctx = makeContext({ '/a.ts': 'const x = 1;' });
	const config: Config = {
		rules: {
			typed: ((rctx: RuleContext) => {
				void rctx.program;
				rctx.report('typed', 0, 1);
			}) as any,
		},
	};
	const linter = core.createLinter(ctx, '/', config, () => []);
	const cache: FileLintCache = {};
	const diagnostics = linter.lint('/a.ts', cache);
	check('type-aware rule still produces diagnostics', diagnostics.length === 1);
	check('type-aware rule NOT cached', !cache['typed']);
}

// ── Test 3: cache hit → rule not re-run, diagnostics restored ────────────
{
	const ctx = makeContext({ '/a.ts': 'const x = 1;' });
	let runs = 0;
	const config: Config = {
		rules: {
			syntactic: ((rctx: RuleContext) => {
				runs++;
				rctx.report('hi', 0, 1);
			}) as any,
		},
	};
	const linter = core.createLinter(ctx, '/', config, () => []);

	// First run populates cache.
	const cache: FileLintCache = {};
	const first = linter.lint('/a.ts', cache);
	check('first run actually ran', runs === 1);
	check('first run produced 1 diagnostic', first.length === 1);

	// Second run should hit cache, rule should NOT execute.
	const second = linter.lint('/a.ts', cache);
	check('second run did NOT re-execute rule (cache hit)', runs === 1);
	check('second run still produced 1 diagnostic', second.length === 1);

	// Restored diagnostic must have a live file pointer (not undefined).
	check(
		'restored diagnostic has live file ref',
		second[0]?.file !== undefined && typeof second[0]?.file?.fileName === 'string',
		`got file: ${second[0]?.file}`,
	);
}

// ── Test 4: report-then-touch-program deletes cache entry ────────────────
{
	const ctx = makeContext({ '/a.ts': 'const x = 1;' });
	const config: Config = {
		rules: {
			'report-then-touch': ((rctx: RuleContext) => {
				rctx.report('first', 0, 1); // populates cache via report()
				void rctx.program; // flips touchedProgram → mark type-aware
			}) as any,
		},
	};
	const linter = core.createLinter(ctx, '/', config, () => []);
	const cache: FileLintCache = {};
	linter.lint('/a.ts', cache);
	check('post-rule cleanup deleted entry', !cache['report-then-touch']);
}

// ── Test 5: sticky type-aware across files ───────────────────────────────
{
	const ctx = makeContext({
		'/a.ts': 'const x = 1;',
		'/b.ts': 'const y = 2;',
	});
	const config: Config = {
		rules: {
			'sometimes-typed': ((rctx: RuleContext) => {
				if (rctx.file.fileName === '/a.ts') {
					void rctx.program;
				}
				rctx.report('hi', 0, 1);
			}) as any,
		},
	};
	const linter = core.createLinter(ctx, '/', config, () => []);
	const cacheA: FileLintCache = {};
	const cacheB: FileLintCache = {};
	linter.lint('/a.ts', cacheA); // touches program for a
	linter.lint('/b.ts', cacheB); // doesn't touch for b
	check('a.ts no cache entry', !cacheA['sometimes-typed']);
	check(
		'b.ts no cache entry (sticky)',
		!cacheB['sometimes-typed'],
		'classification persists past the file that triggered it',
	);
}

// ── Test 6: initialTypeAwareRules → pre-existing cache entry ignored ─────
//
// Cold session with stale cache: ruleModes from a prior session marks
// `typed` as type-aware. cache file still has an entry for `typed`
// (e.g. written before this fix shipped). The linter must ignore it
// and re-run the rule.
{
	const ctx = makeContext({ '/a.ts': 'const x = 1;' });
	let runs = 0;
	const config: Config = {
		rules: {
			typed: ((rctx: RuleContext) => {
				runs++;
				void rctx.program;
				rctx.report('typed', 0, 1);
			}) as any,
		},
	};
	const linter = core.createLinter(ctx, '/', config, () => [], ['typed']);

	const cache: FileLintCache = {
		typed: {
			hasFix: false,
			diagnostics: [{
				category: ts.DiagnosticCategory.Message,
				code: 'typed' as any,
				messageText: 'stale',
				file: undefined as any,
				start: 0,
				length: 1,
				source: 'tsslint',
			} as ts.DiagnosticWithLocation],
		},
	};
	const result = linter.lint('/a.ts', cache);
	check('rule re-ran (stale cache ignored)', runs === 1);
	check('result reflects fresh run, not stale cache', result.length === 1);
	check('stale entry deleted after re-run', !cache['typed']);
}

// ── Test 7: hasFix flag set when rule registers a fix ────────────────────
{
	const ctx = makeContext({ '/a.ts': 'const x = 1;' });
	const config: Config = {
		rules: {
			fixable: ((rctx: RuleContext) => {
				rctx.report('fix me', 0, 1).withFix('apply', () => []);
			}) as any,
		},
	};
	const linter = core.createLinter(ctx, '/', config, () => []);
	const cache: FileLintCache = {};
	linter.lint('/a.ts', cache);
	check('hasFix true after rule registered a fix', cache['fixable']?.hasFix === true);
}

// ── Test 8: lint without fileCache works (back-compat) ───────────────────
{
	const ctx = makeContext({ '/a.ts': 'const x = 1;' });
	const config: Config = {
		rules: {
			r: ((rctx: RuleContext) => {
				rctx.report('hi', 0, 1);
			}) as any,
		},
	};
	const linter = core.createLinter(ctx, '/', config, () => []);
	const result = linter.lint('/a.ts'); // no fileCache passed
	check('lint without fileCache still works', result.length === 1);
}

// ── Done ────────────────────────────────────────────────────────────────
process.stdout.write('\n');
if (failures.length) {
	console.error(`\n${failures.length} failure(s):`);
	for (const f of failures) console.error('  - ' + f);
	process.exit(1);
}
console.log('OK');
