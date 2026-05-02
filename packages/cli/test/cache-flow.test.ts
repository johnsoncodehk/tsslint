// Layer 1 cache-flow tests. These cover the cache-aware lint pass —
// every invariant of the CLI's per-file mtime / per-rule cache.
//
// Run via:
//   node packages/cli/test/cache-flow.test.js

import * as ts from 'typescript';
import type { Config, RuleContext } from '@tsslint/types';
import type { FileCache } from '../lib/cache.js';

const core = require('@tsslint/core') as typeof import('@tsslint/core');
const cacheFlow = require('../lib/cache-flow.js') as typeof import('../lib/cache-flow.js');

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

function emptyFileCache(mtime = 0): FileCache {
	return { mtime, rules: {} };
}

// ── Test 1: syntactic rule writes cache entry ────────────────────────────
{
	const ctx = makeContext({ '/a.ts': 'const x = 1;' });
	const config: Config = {
		rules: {
			syntactic: ((rctx: RuleContext) => {
				rctx.report('hi', 0, 1);
			}),
		},
	};
	const linter = core.createLinter(ctx, '/', config, () => []);
	const cache = emptyFileCache(1);
	cacheFlow.lintWithCache(linter, '/a.ts', cache, 1, ctx.languageService.getProgram()!);
	check('syntactic rule cache entry written', !!cache.rules['syntactic']);
	check('cache has 1 diagnostic', cache.rules['syntactic']?.diagnostics.length === 1);
	check('hasFix false (no fix reported)', cache.rules['syntactic']?.hasFix === false);
}

// ── Test 2: type-aware rule does not write cache entry ───────────────────
{
	const ctx = makeContext({ '/a.ts': 'const x = 1;' });
	const config: Config = {
		rules: {
			typed: ((rctx: RuleContext) => {
				void rctx.program;
				rctx.report('typed', 0, 1);
			}),
		},
	};
	const linter = core.createLinter(ctx, '/', config, () => []);
	const cache = emptyFileCache(1);
	const result = cacheFlow.lintWithCache(linter, '/a.ts', cache, 1, ctx.languageService.getProgram()!);
	check('type-aware rule still produces diagnostics', result.length === 1);
	check('type-aware rule NOT cached', !cache.rules['typed']);
}

// ── Test 3: cache hit skips rule, restores diagnostic ────────────────────
{
	const ctx = makeContext({ '/a.ts': 'const x = 1;' });
	let runs = 0;
	const config: Config = {
		rules: {
			syntactic: ((rctx: RuleContext) => {
				runs++;
				rctx.report('hi', 0, 1);
			}),
		},
	};
	const linter = core.createLinter(ctx, '/', config, () => []);
	const cache = emptyFileCache(1);
	const program = ctx.languageService.getProgram()!;

	cacheFlow.lintWithCache(linter, '/a.ts', cache, 1, program);
	check('first call ran rule', runs === 1);

	const second = cacheFlow.lintWithCache(linter, '/a.ts', cache, 1, program);
	check('second call did NOT re-run rule', runs === 1);
	check('second call still produced 1 diagnostic', second.length === 1);
	check(
		'restored diagnostic has live file ref',
		!!second[0]?.file && typeof second[0]?.file.fileName === 'string',
	);
}

// ── Test 4: mtime mismatch clears all rule entries ───────────────────────
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
	const cache = emptyFileCache(1);
	const program = ctx.languageService.getProgram()!;

	cacheFlow.lintWithCache(linter, '/a.ts', cache, 1, program);
	check('first call ran', runs === 1);

	// Same mtime → cache hit
	cacheFlow.lintWithCache(linter, '/a.ts', cache, 1, program);
	check('same mtime → still 1 run', runs === 1);

	// Different mtime → cache invalidated
	cacheFlow.lintWithCache(linter, '/a.ts', cache, 2, program);
	check('mtime change → re-run', runs === 2);
	check('cache mtime updated', cache.mtime === 2);
}

// ── Test 5: report-then-touch deletes any cache entry ────────────────────
{
	const ctx = makeContext({ '/a.ts': 'const x = 1;' });
	const config: Config = {
		rules: {
			'report-then-touch': ((rctx: RuleContext) => {
				rctx.report('first', 0, 1);
				void rctx.program; // flips touchedProgram → mark type-aware
			}),
		},
	};
	const linter = core.createLinter(ctx, '/', config, () => []);
	const cache = emptyFileCache(1);
	cacheFlow.lintWithCache(linter, '/a.ts', cache, 1, ctx.languageService.getProgram()!);
	check('post-rule cleanup deleted entry', !cache.rules['report-then-touch']);
}

// ── Test 6: sticky type-aware across files ───────────────────────────────
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
			}),
		},
	};
	const linter = core.createLinter(ctx, '/', config, () => []);
	const cacheA = emptyFileCache(1);
	const cacheB = emptyFileCache(1);
	const program = ctx.languageService.getProgram()!;
	cacheFlow.lintWithCache(linter, '/a.ts', cacheA, 1, program);
	cacheFlow.lintWithCache(linter, '/b.ts', cacheB, 1, program);
	check('a.ts no cache entry (touched)', !cacheA.rules['sometimes-typed']);
	check(
		'b.ts no cache entry (sticky classification)',
		!cacheB.rules['sometimes-typed'],
	);
}

// ── Test 7: stale cache entry for type-aware rule is ignored & cleaned ───
{
	const ctx = makeContext({ '/a.ts': 'const x = 1;' });
	let runs = 0;
	const config: Config = {
		rules: {
			typed: ((rctx: RuleContext) => {
				runs++;
				void rctx.program;
				rctx.report('typed', 0, 1);
			}),
		},
	};
	// Linter is seeded with `typed` as type-aware (e.g. from prior session
	// via cache file's ruleModes). The fileCache also has a stale entry.
	const linter = core.createLinter(ctx, '/', config, () => [], ['typed']);
	const cache: FileCache = {
		mtime: 1,
		rules: {
			typed: {
				hasFix: false,
				diagnostics: [{
					category: ts.DiagnosticCategory.Message,
					code: 'typed' as any,
					messageText: 'stale',
					start: 0,
					length: 1,
					source: 'tsslint',
				}],
			},
		},
	};
	const result = cacheFlow.lintWithCache(linter, '/a.ts', cache, 1, ctx.languageService.getProgram()!);
	check('rule re-ran (stale cache ignored)', runs === 1);
	check('result reflects fresh run', result.length === 1);
	check('stale entry deleted', !cache.rules['typed']);
}

// ── Test 8: hasFix flag derives from rule fix registration ───────────────
{
	const ctx = makeContext({ '/a.ts': 'const x = 1;' });
	const config: Config = {
		rules: {
			fixable: ((rctx: RuleContext) => {
				rctx.report('fix me', 0, 1).withFix('apply', () => []);
			}),
		},
	};
	const linter = core.createLinter(ctx, '/', config, () => []);
	const cache = emptyFileCache(1);
	cacheFlow.lintWithCache(linter, '/a.ts', cache, 1, ctx.languageService.getProgram()!);
	check('hasFix true after rule registered fix', cache.rules['fixable']?.hasFix === true);
}

// ── Test 9: multiple rules — only cached ones skipped, others run ────────
{
	const ctx = makeContext({ '/a.ts': 'const x = 1;' });
	let aRuns = 0, bRuns = 0;
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
	const cache = emptyFileCache(1);
	const program = ctx.languageService.getProgram()!;

	// First call: both run
	cacheFlow.lintWithCache(linter, '/a.ts', cache, 1, program);
	check('first call ran both', aRuns === 1 && bRuns === 1);
	check('a cached', !!cache.rules['a']);
	check('b cached', !!cache.rules['b']);

	// Second call: both cached
	const result = cacheFlow.lintWithCache(linter, '/a.ts', cache, 1, program);
	check('second call ran neither', aRuns === 1 && bRuns === 1);
	check('result has both restored diagnostics', result.length === 2);
}

// ── Test 10 (layer 2): typeAwareUnaffected=true caches type-aware rule ───
//
// When the caller signals that the file's type-relevant inputs haven't
// moved (BuilderProgram check in production), type-aware rules become
// eligible for cache hits and writes — same path as syntactic rules.
{
	const ctx = makeContext({ '/a.ts': 'const x = 1;' });
	let runs = 0;
	const config: Config = {
		rules: {
			typed: ((rctx: RuleContext) => {
				runs++;
				void rctx.program;
				rctx.report('typed', 0, 1);
			}),
		},
	};
	const linter = core.createLinter(ctx, '/', config, () => []);
	const cache = emptyFileCache(1);
	const program = ctx.languageService.getProgram()!;

	cacheFlow.lintWithCache(linter, '/a.ts', cache, 1, program, { typeAwareUnaffected: true });
	check('first call ran (no cache yet)', runs === 1);
	check(
		'type-aware entry written under unaffected signal',
		!!cache.rules['typed'],
		'expected entry — typeAwareUnaffected=true makes type-aware caching legal',
	);
	check(
		'cached diagnostic count',
		cache.rules['typed']?.diagnostics.length === 1,
	);
}

// ── Test 11 (layer 2): cache hit on second call with same signal ─────────
{
	const ctx = makeContext({ '/a.ts': 'const x = 1;' });
	let runs = 0;
	const config: Config = {
		rules: {
			typed: ((rctx: RuleContext) => {
				runs++;
				void rctx.program;
				rctx.report('typed', 0, 1);
			}),
		},
	};
	const linter = core.createLinter(ctx, '/', config, () => []);
	const cache = emptyFileCache(1);
	const program = ctx.languageService.getProgram()!;

	cacheFlow.lintWithCache(linter, '/a.ts', cache, 1, program, { typeAwareUnaffected: true });
	const second = cacheFlow.lintWithCache(linter, '/a.ts', cache, 1, program, { typeAwareUnaffected: true });
	check('second call did NOT re-run type-aware rule', runs === 1);
	check('second call still produced 1 diagnostic', second.length === 1);
	check(
		'restored diagnostic has live file ref (layer 2)',
		!!second[0]?.file && typeof second[0]?.file.fileName === 'string',
	);
}

// ── Test 12 (layer 2): mode B → mode A re-runs and clears entry ──────────
//
// Cache entry was written under typeAwareUnaffected=true. Next call
// drops the signal (BuilderProgram now considers the file affected).
// The type-aware rule must re-run AND its old entry deleted.
{
	const ctx = makeContext({ '/a.ts': 'const x = 1;' });
	let runs = 0;
	const config: Config = {
		rules: {
			typed: ((rctx: RuleContext) => {
				runs++;
				void rctx.program;
				rctx.report('typed', 0, 1);
			}),
		},
	};
	const linter = core.createLinter(ctx, '/', config, () => []);
	const cache = emptyFileCache(1);
	const program = ctx.languageService.getProgram()!;

	// Mode B: write the entry.
	cacheFlow.lintWithCache(linter, '/a.ts', cache, 1, program, { typeAwareUnaffected: true });
	check('layer-2 first run cached the entry', !!cache.rules['typed']);

	// Mode A (default): file is affected. Re-run, drop entry.
	cacheFlow.lintWithCache(linter, '/a.ts', cache, 1, program);
	check('mode-A re-run executed rule', runs === 2);
	check('mode-A re-run dropped the entry', !cache.rules['typed']);
}

// ── Test 13 (layer 2): default (no signal) preserves mode-A semantics ────
{
	const ctx = makeContext({ '/a.ts': 'const x = 1;' });
	const config: Config = {
		rules: {
			typed: ((rctx: RuleContext) => {
				void rctx.program;
				rctx.report('typed', 0, 1);
			}),
		},
	};
	const linter = core.createLinter(ctx, '/', config, () => []);
	const cache = emptyFileCache(1);
	const program = ctx.languageService.getProgram()!;

	// No options arg passed at all — should behave like mode A.
	cacheFlow.lintWithCache(linter, '/a.ts', cache, 1, program);
	check('default (no options) does NOT cache type-aware', !cache.rules['typed']);

	// Explicit false also defaults to mode A.
	cacheFlow.lintWithCache(linter, '/a.ts', cache, 1, program, { typeAwareUnaffected: false });
	check('explicit false does NOT cache type-aware', !cache.rules['typed']);
}

// ── Done ────────────────────────────────────────────────────────────────
process.stdout.write('\n');
if (failures.length) {
	console.error(`\n${failures.length} failure(s):`);
	for (const f of failures) console.error('  - ' + f);
	process.exit(1);
}
console.log('OK');
