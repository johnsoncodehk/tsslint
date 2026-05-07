// Layer 1 cache-flow tests. These cover the cache-aware lint pass —
// every invariant of the CLI's per-file mtime / per-rule cache.
//
// Run via:
//   node packages/cli/test/cache-flow.test.js

import type { Config, RuleContext } from '@tsslint/types';
import * as ts from 'typescript';
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

	cacheFlow.lintWithCache(linter, '/a.ts', cache, 1, program, { incremental: true, typeAwareUnaffected: true });
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

	cacheFlow.lintWithCache(linter, '/a.ts', cache, 1, program, { incremental: true, typeAwareUnaffected: true });
	const second = cacheFlow.lintWithCache(linter, '/a.ts', cache, 1, program, {
		incremental: true,
		typeAwareUnaffected: true,
	});
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
	cacheFlow.lintWithCache(linter, '/a.ts', cache, 1, program, { incremental: true, typeAwareUnaffected: true });
	check('layer-2 first run cached the entry', !!cache.rules['typed']);

	// Mode A (default): file is affected. Re-run, drop entry.
	cacheFlow.lintWithCache(linter, '/a.ts', cache, 1, program);
	check('mode-A re-run executed rule', runs === 2);
	check('mode-A re-run dropped the entry', !cache.rules['typed']);
}

// ── Test 13 (layer 2): mode A (no incremental) never caches type-aware ──
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

	// No options arg → mode A. Type-aware rules never cached.
	cacheFlow.lintWithCache(linter, '/a.ts', cache, 1, program);
	check('default (no options) does NOT cache type-aware', !cache.rules['typed']);

	// Explicit incremental=false also mode A.
	cacheFlow.lintWithCache(linter, '/a.ts', cache, 1, program, { incremental: false });
	check('explicit incremental=false does NOT cache type-aware', !cache.rules['typed']);
}

// ── Test 14 (layer 2): incremental writes type-aware even when affected ─
//
// First-time-ever (cold session) under --incremental: there's no prior
// entry to hit, but we must still WRITE one so the next session can
// hit. The split between "trust cache" (typeAwareUnaffected) and "write
// cache" (incremental) is the gate.
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

	// Cold session under --incremental: no prev state, file is "affected"
	// (unaffected=false). Must run AND write entry.
	cacheFlow.lintWithCache(linter, '/a.ts', cache, 1, program, {
		incremental: true,
		typeAwareUnaffected: false,
	});
	check('cold session ran the rule', runs === 1);
	check(
		'cold session under --incremental wrote type-aware entry',
		!!cache.rules['typed'],
		'entry needed for next session to cache-hit',
	);
}

// ── Test 15: withoutCache() — diagnostic returned but not persisted ─────
//
// `Reporter.withoutCache()` is the rule's contract: "this finding's
// correctness depends on inputs neither layer tracks; please don't
// replay it from the cache." The current run still surfaces the
// diagnostic; it just isn't written to disk, so the next warm hit on
// the same file won't see it.
{
	const ctx = makeContext({ '/a.ts': 'const x = 1;' });
	const config: Config = {
		rules: {
			env_dependent: ((rctx: RuleContext) => {
				rctx.report('depends on env', 0, 1).withoutCache();
				rctx.report('plain', 0, 1);
			}),
		},
	};
	const linter = core.createLinter(ctx, '/', config, () => []);
	const cache = emptyFileCache(1);
	const diags = cacheFlow.lintWithCache(
		linter,
		'/a.ts',
		cache,
		1,
		ctx.languageService.getProgram()!,
	);
	check('current run returns both diagnostics', diags.length === 2);
	check(
		'cache entry exists for the rule',
		!!cache.rules['env_dependent'],
	);
	check(
		'only the non-marked diagnostic is persisted',
		cache.rules['env_dependent']?.diagnostics.length === 1,
		`expected 1 cached diagnostic, got ${cache.rules['env_dependent']?.diagnostics.length}`,
	);
	check(
		'persisted diagnostic is the plain one',
		cache.rules['env_dependent']?.diagnostics[0]?.messageText === 'plain',
	);
}

// ── Test 16: withoutCache() — second run cache-hits with the survivor ───
{
	const ctx = makeContext({ '/a.ts': 'const x = 1;' });
	const config: Config = {
		rules: {
			env_dependent: ((rctx: RuleContext) => {
				rctx.report('depends on env', 0, 1).withoutCache();
				rctx.report('plain', 0, 1);
			}),
		},
	};
	const linter = core.createLinter(ctx, '/', config, () => []);
	const cache = emptyFileCache(1);
	cacheFlow.lintWithCache(linter, '/a.ts', cache, 1, ctx.languageService.getProgram()!);

	// Second run with the same mtime — rule cache-hits, only the
	// persisted diagnostic comes back.
	const linter2 = core.createLinter(ctx, '/', config, () => []);
	const diags = cacheFlow.lintWithCache(
		linter2,
		'/a.ts',
		cache,
		1,
		ctx.languageService.getProgram()!,
	);
	check('warm cache hit returns 1 diagnostic', diags.length === 1);
	check('warm replay drops the marked one', diags[0]?.messageText === 'plain');
}

// ── Test 17 (regression): mixed-mode rule, early-return file replays sound
//
// A rule that file-shape-filters before reading `program` will, for the
// early-returning file, finish without touching the probe. Verify the
// resulting cache entry replays correctly across sessions even after the
// rule is globally classified type-aware (because some OTHER file did
// touch program). The early-return path's output is a deterministic
// function of file text alone — replaying it on a warm hit should match
// what re-running the rule would produce.
{
	const ctx = makeContext({
		'/skip.ts': 'const x = 1;',
		'/check.ts': 'const y = 2;',
	});
	const config: Config = {
		rules: {
			'mixed-mode': ((rctx: RuleContext) => {
				if (rctx.file.fileName === '/skip.ts') return;
				void rctx.program;
				rctx.report('typed', 0, 1);
			}),
		},
	};

	// ── Session 1: cold, both files lint — process the early-return file
	// FIRST so the rule isn't yet type-aware when its entry gets written.
	const linter1 = core.createLinter(ctx, '/', config, () => []);
	const program1 = ctx.languageService.getProgram()!;
	const cacheSkip: FileCache = emptyFileCache(1);
	const cacheCheck: FileCache = emptyFileCache(1);
	cacheFlow.lintWithCache(linter1, '/skip.ts', cacheSkip, 1, program1);
	cacheFlow.lintWithCache(linter1, '/check.ts', cacheCheck, 1, program1);

	check(
		'session 1: rule classified type-aware after both files',
		linter1.getTypeAwareRules().has('mixed-mode'),
	);
	check(
		"session 1: early-return file got an entry (rule wasn't yet type-aware at write time)",
		!!cacheSkip.rules['mixed-mode'],
	);
	check(
		"session 1: early-return file's entry has 0 diagnostics (rule reported nothing)",
		cacheSkip.rules['mixed-mode']?.diagnostics.length === 0,
	);

	// ── Session 2: rule pre-classified type-aware (from session 1).
	// Both files unchanged. typeAwareUnaffected=true → both should
	// cache-hit and replay cleanly.
	const linter2 = core.createLinter(ctx, '/', config, () => [], ['mixed-mode']);
	const program2 = ctx.languageService.getProgram()!;
	let earlyReturnRanInSession2 = false;
	const config2: Config = {
		rules: {
			'mixed-mode': ((rctx: RuleContext) => {
				earlyReturnRanInSession2 = true;
				if (rctx.file.fileName === '/skip.ts') return;
				void rctx.program;
				rctx.report('typed', 0, 1);
			}),
		},
	};
	const linterMonitored = core.createLinter(ctx, '/', config2, () => [], ['mixed-mode']);
	const session2Skip = cacheFlow.lintWithCache(
		linterMonitored,
		'/skip.ts',
		cacheSkip,
		1,
		program2,
		{ incremental: true, typeAwareUnaffected: true },
	);
	check(
		'session 2: warm hit on early-return file replays empty diagnostics',
		session2Skip.length === 0,
	);
	check(
		'session 2: rule body did NOT execute on early-return file (cache skipped it)',
		!earlyReturnRanInSession2,
		"cache-hit means we skip the rule entirely — body shouldn't run",
	);
	void linter2; // type-only ref; linterMonitored is the one we observe
}

// ── Test 18: NO_CACHE marker doesn't leak through serialisation ─────────
//
// Symbol-keyed property must stay invisible to JSON.stringify and to
// `{...spread}` so the on-disk cache stays clean.
{
	const ctx = makeContext({ '/a.ts': 'const x = 1;' });
	const config: Config = {
		rules: {
			r: ((rctx: RuleContext) => {
				rctx.report('marked', 0, 1).withoutCache();
			}),
		},
	};
	const linter = core.createLinter(ctx, '/', config, () => []);
	const cache = emptyFileCache(1);
	cacheFlow.lintWithCache(linter, '/a.ts', cache, 1, ctx.languageService.getProgram()!);
	// rule entry exists but with 0 diagnostics — no smuggled keys.
	const json = JSON.stringify(cache);
	check('NO_CACHE marker not visible in serialised cache', !json.includes('no-cache'));
}

// ── Test 19: warm cache must not break resolveDiagnostics view ───────────
//
// Scenario: a rule fires on line 2, an `// eslint-disable-next-line foo`
// comment on line 1 suppresses it, ignore plugin (`reportsUnusedComments
// = true`) marks the comment used. Cold pass produces 0 user-visible
// errors. Warm pass: the rule is cached → skipped → its diagnostic
// would be missing from the array `resolveDiagnostics` sees, so the
// ignore plugin can no longer match the comment to a diagnostic and
// erroneously reports it as unused.
//
// Cache flow MUST seed `prevDiagnostics` with the cached entries before
// `resolveDiagnostics` runs, so the plugin's view matches the cold pass.
{
	const ignorePlugin = require('@tsslint/config/lib/plugins/ignore.js') as {
		create: (cmd: string | [string, string], reportsUnused: boolean) => any;
	};
	const code = '// eslint-disable-next-line foo\nconst x = 1;\n';
	const ctx = makeContext({ '/a.ts': code });
	const config: Config = {
		rules: {
			foo: ((rctx: RuleContext) => {
				// Report on line 2 (after the disable comment on line 1).
				const lineStart = code.indexOf('const');
				rctx.report('foo fires', lineStart, lineStart + 5);
			}),
		},
		plugins: [ignorePlugin.create('eslint-disable-next-line', true)],
	};
	const linter = core.createLinter(ctx, '/', config, () => []);
	const cache = emptyFileCache(1);
	const program = ctx.languageService.getProgram()!;

	const cold = cacheFlow.lintWithCache(linter, '/a.ts', cache, 1, program);
	check(
		'cold pass: rule diag suppressed by disable comment, no user-visible diag',
		cold.length === 0,
		`cold returned ${cold.length} diags: ${cold.map(d => d.code).join(',')}`,
	);
	check('cold pass: rule entry written to cache', !!cache.rules['foo']);
	check(
		'cold pass: cache stores the suppressed diagnostic so warm can re-evaluate',
		cache.rules['foo']?.diagnostics.length === 1,
	);

	const warm = cacheFlow.lintWithCache(linter, '/a.ts', cache, 1, program);
	check(
		'warm pass: same comment suppresses the same (now-cached) diag — no unused-comment FP',
		warm.length === 0,
		`warm returned ${warm.length} diags: ${warm.map(d => d.code).join(',')}`,
	);
}

// ── Test 20: prevDiagnostics + fresh must not duplicate ──────────────────
//
// `skipRules` and the rules that actually run are disjoint by construction
// (cache-flow only adds a rule to skipRules if it has a cached entry, and
// lint skips those — so they can't also produce fresh output). Verify the
// invariant: across cold + warm passes for a non-suppressed diagnostic,
// the user sees exactly one report each pass — never two.
{
	const ctx = makeContext({ '/a.ts': 'const x = 1;\n' });
	let runs = 0;
	const config: Config = {
		rules: {
			r: ((rctx: RuleContext) => {
				runs++;
				rctx.report('once', 0, 1);
			}),
		},
	};
	const linter = core.createLinter(ctx, '/', config, () => []);
	const cache = emptyFileCache(1);
	const program = ctx.languageService.getProgram()!;

	const cold = cacheFlow.lintWithCache(linter, '/a.ts', cache, 1, program);
	check('cold: rule ran once', runs === 1);
	check('cold: 1 diag returned', cold.length === 1);

	const warm = cacheFlow.lintWithCache(linter, '/a.ts', cache, 1, program);
	check('warm: rule did NOT re-run (cached)', runs === 1);
	check('warm: 1 diag returned (no duplication)', warm.length === 1);
	check(
		'warm diag has same payload as cold',
		warm[0].code === cold[0].code && warm[0].start === cold[0].start,
	);
}

// ── Test 21: multiple rules + ignore plugin, no duplication on warm ──────
//
// Two rules, only one suppressed by a disable comment. Warm pass must
// produce the same final set as cold — no double-report on the
// non-suppressed rule, no resurrection of the suppressed one.
{
	const ignorePlugin = require('@tsslint/config/lib/plugins/ignore.js') as {
		create: (cmd: string | [string, string], reportsUnused: boolean) => any;
	};
	const code = '// eslint-disable-next-line foo\nconst x = 1;\n';
	const ctx = makeContext({ '/a.ts': code });
	const config: Config = {
		rules: {
			foo: ((rctx: RuleContext) => {
				const at = code.indexOf('const');
				rctx.report('foo', at, at + 5);
			}),
			bar: ((rctx: RuleContext) => {
				const at = code.indexOf('const');
				rctx.report('bar', at, at + 5);
			}),
		},
		plugins: [ignorePlugin.create('eslint-disable-next-line', true)],
	};
	const linter = core.createLinter(ctx, '/', config, () => []);
	const cache = emptyFileCache(1);
	const program = ctx.languageService.getProgram()!;

	const cold = cacheFlow.lintWithCache(linter, '/a.ts', cache, 1, program);
	const coldCodes = cold.map(d => d.code).sort();
	check(
		'cold: only `bar` survives (`foo` suppressed by comment for `foo`)',
		cold.length === 1 && String(cold[0].code) === 'bar',
		`cold codes: ${coldCodes.join(',')}`,
	);

	const warm = cacheFlow.lintWithCache(linter, '/a.ts', cache, 1, program);
	const warmCodes = warm.map(d => d.code).sort();
	check(
		'warm: same single `bar` — no duplicate, no resurrected `foo`, no FP unused-comment',
		warm.length === 1 && String(warm[0].code) === 'bar',
		`warm codes: ${warmCodes.join(',')}`,
	);
}

// ── Done ────────────────────────────────────────────────────────────────
process.stdout.write('\n');
if (failures.length) {
	console.error(`\n${failures.length} failure(s):`);
	for (const f of failures) console.error('  - ' + f);
	process.exit(1);
}
console.log('OK');
