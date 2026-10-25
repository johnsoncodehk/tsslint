// Layer 1 cache-flow tests. These cover the cache-aware lint pass —
// every invariant of the CLI's per-file mtime / per-rule cache.
//
// Run via:
//   node packages/cli/test/cache-flow.test.js

import type { Config, RuleContext } from '@tsslint/types';
import { DiagnosticCategory } from 'typescript/sync';
import type { FileCache } from '../lib/cache.js';
import { createProject } from './project';

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

function emptyFileCache(mtime = 0): FileCache {
	return { mtime, rules: {} };
}

// ── Test 1: syntactic rule writes cache entry ────────────────────────────
{
	const project = createProject({ 'a.ts': 'const x = 1;' });
	const config: Config = {
		rules: {
			syntactic: ((rctx: RuleContext) => {
				rctx.report('hi', 0, 1);
			}),
		},
	};
	const linter = core.createLinter(project.ctx, project.rootDir, config);
	const cache = emptyFileCache(1);
	cacheFlow.lintWithCache(linter, project.target('a.ts'), cache, 1);
	check('syntactic rule cache entry written', !!cache.rules['syntactic']);
	check('cache has 1 diagnostic', cache.rules['syntactic']?.diagnostics.length === 1);
	check('hasFix false (no fix reported)', cache.rules['syntactic']?.hasFix === false);
}

// ── Test 2: type-aware rule does not write cache entry ───────────────────
{
	const project = createProject({ 'a.ts': 'const x = 1;' });
	const config: Config = {
		rules: {
			typed: ((rctx: RuleContext) => {
				void rctx.program;
				rctx.report('typed', 0, 1);
			}),
		},
	};
	const linter = core.createLinter(project.ctx, project.rootDir, config);
	const cache = emptyFileCache(1);
	const result = cacheFlow.lintWithCache(linter, project.target('a.ts'), cache, 1);
	check('type-aware rule still produces diagnostics', result.length === 1);
	check('type-aware rule NOT cached', !cache.rules['typed']);
}

// ── Test 3: cache hit skips rule, restores diagnostic ────────────────────
{
	const project = createProject({ 'a.ts': 'const x = 1;' });
	let runs = 0;
	const config: Config = {
		rules: {
			syntactic: ((rctx: RuleContext) => {
				runs++;
				rctx.report('hi', 0, 1);
			}),
		},
	};
	const linter = core.createLinter(project.ctx, project.rootDir, config);
	const cache = emptyFileCache(1);

	cacheFlow.lintWithCache(linter, project.target('a.ts'), cache, 1);
	check('first call ran rule', runs === 1);

	const second = cacheFlow.lintWithCache(linter, project.target('a.ts'), cache, 1);
	check('second call did NOT re-run rule', runs === 1);
	check('second call still produced 1 diagnostic', second.length === 1);
	check(
		'restored diagnostic keeps its file name',
		second[0]?.fileName === project.target('a.ts').file.fileName,
	);
}

// ── Test 4: mtime mismatch clears all rule entries ───────────────────────
{
	const project = createProject({ 'a.ts': 'const x = 1;' });
	let runs = 0;
	const config: Config = {
		rules: {
			r: ((rctx: RuleContext) => {
				runs++;
				rctx.report('x', 0, 1);
			}),
		},
	};
	const linter = core.createLinter(project.ctx, project.rootDir, config);
	const cache = emptyFileCache(1);

	cacheFlow.lintWithCache(linter, project.target('a.ts'), cache, 1);
	check('first call ran', runs === 1);

	// Same mtime → cache hit
	cacheFlow.lintWithCache(linter, project.target('a.ts'), cache, 1);
	check('same mtime → still 1 run', runs === 1);

	// Different mtime → cache invalidated
	cacheFlow.lintWithCache(linter, project.target('a.ts'), cache, 2);
	check('mtime change → re-run', runs === 2);
	check('cache mtime updated', cache.mtime === 2);
}

// ── Test 5: report-then-touch deletes any cache entry ────────────────────
{
	const project = createProject({ 'a.ts': 'const x = 1;' });
	const config: Config = {
		rules: {
			'report-then-touch': ((rctx: RuleContext) => {
				rctx.report('first', 0, 1);
				void rctx.program; // flips touchedProgram → mark type-aware
			}),
		},
	};
	const linter = core.createLinter(project.ctx, project.rootDir, config);
	const cache = emptyFileCache(1);
	cacheFlow.lintWithCache(linter, project.target('a.ts'), cache, 1);
	check('post-rule cleanup deleted entry', !cache.rules['report-then-touch']);
}

// ── Test 6: sticky type-aware across files ───────────────────────────────
{
	const project = createProject({
		'a.ts': 'const x = 1;',
		'b.ts': 'const y = 2;',
	});
	const config: Config = {
		rules: {
			'sometimes-typed': ((rctx: RuleContext) => {
				if (rctx.file.fileName.endsWith('/a.ts')) {
					void rctx.program;
				}
				rctx.report('hi', 0, 1);
			}),
		},
	};
	const linter = core.createLinter(project.ctx, project.rootDir, config);
	const cacheA = emptyFileCache(1);
	const cacheB = emptyFileCache(1);
	cacheFlow.lintWithCache(linter, project.target('a.ts'), cacheA, 1);
	cacheFlow.lintWithCache(linter, project.target('b.ts'), cacheB, 1);
	check('a.ts no cache entry (touched)', !cacheA.rules['sometimes-typed']);
	check(
		'b.ts no cache entry (sticky classification)',
		!cacheB.rules['sometimes-typed'],
	);
}

// ── Test 7: stale cache entry for type-aware rule is ignored & cleaned ───
{
	const project = createProject({ 'a.ts': 'const x = 1;' });
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
	const linter = core.createLinter(project.ctx, project.rootDir, config, ['typed']);
	const cache: FileCache = {
		mtime: 1,
		rules: {
			typed: {
				hasFix: false,
				diagnostics: [{
					category: DiagnosticCategory.Message,
					code: 0,
					ruleId: 'typed',
					text: 'stale',
					pos: 0,
					end: 1,
				}],
			},
		},
	};
	const result = cacheFlow.lintWithCache(linter, project.target('a.ts'), cache, 1);
	check('rule re-ran (stale cache ignored)', runs === 1);
	check('result reflects fresh run', result.length === 1);
	check('stale entry deleted', !cache.rules['typed']);
}

// ── Test 8: hasFix flag derives from rule fix registration ───────────────
{
	const project = createProject({ 'a.ts': 'const x = 1;' });
	const config: Config = {
		rules: {
			fixable: ((rctx: RuleContext) => {
				rctx.report('fix me', 0, 1).withFix('apply', () => []);
			}),
		},
	};
	const linter = core.createLinter(project.ctx, project.rootDir, config);
	const cache = emptyFileCache(1);
	cacheFlow.lintWithCache(linter, project.target('a.ts'), cache, 1);
	check('hasFix true after rule registered fix', cache.rules['fixable']?.hasFix === true);
}

// ── Test 9: multiple rules — only cached ones skipped, others run ────────
{
	const project = createProject({ 'a.ts': 'const x = 1;' });
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
	const linter = core.createLinter(project.ctx, project.rootDir, config);
	const cache = emptyFileCache(1);

	// First call: both run
	cacheFlow.lintWithCache(linter, project.target('a.ts'), cache, 1);
	check('first call ran both', aRuns === 1 && bRuns === 1);
	check('a cached', !!cache.rules['a']);
	check('b cached', !!cache.rules['b']);

	// Second call: both cached
	const result = cacheFlow.lintWithCache(linter, project.target('a.ts'), cache, 1);
	check('second call ran neither', aRuns === 1 && bRuns === 1);
	check('result has both restored diagnostics', result.length === 2);
}

// ── Test 10 (layer 2): typeAwareUnaffected=true caches type-aware rule ───
//
// When the caller signals that the file's type-relevant inputs haven't
// moved (BuilderProgram check in production), type-aware rules become
// eligible for cache hits and writes — same path as syntactic rules.
{
	const project = createProject({ 'a.ts': 'const x = 1;' });
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
	const linter = core.createLinter(project.ctx, project.rootDir, config);
	const cache = emptyFileCache(1);

	cacheFlow.lintWithCache(linter, project.target('a.ts'), cache, 1, { incremental: true, typeAwareUnaffected: true });
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
	const project = createProject({ 'a.ts': 'const x = 1;' });
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
	const linter = core.createLinter(project.ctx, project.rootDir, config);
	const cache = emptyFileCache(1);

	cacheFlow.lintWithCache(linter, project.target('a.ts'), cache, 1, { incremental: true, typeAwareUnaffected: true });
	const second = cacheFlow.lintWithCache(linter, project.target('a.ts'), cache, 1, {
		incremental: true,
		typeAwareUnaffected: true,
	});
	check('second call did NOT re-run type-aware rule', runs === 1);
	check('second call still produced 1 diagnostic', second.length === 1);
	check(
		'restored diagnostic keeps its file name (layer 2)',
		second[0]?.fileName === project.target('a.ts').file.fileName,
	);
}

// ── Test 12 (layer 2): mode B → mode A re-runs and clears entry ──────────
//
// Cache entry was written under typeAwareUnaffected=true. Next call
// drops the signal (BuilderProgram now considers the file affected).
// The type-aware rule must re-run AND its old entry deleted.
{
	const project = createProject({ 'a.ts': 'const x = 1;' });
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
	const linter = core.createLinter(project.ctx, project.rootDir, config);
	const cache = emptyFileCache(1);

	// Mode B: write the entry.
	cacheFlow.lintWithCache(linter, project.target('a.ts'), cache, 1, { incremental: true, typeAwareUnaffected: true });
	check('layer-2 first run cached the entry', !!cache.rules['typed']);

	// Mode A (default): file is affected. Re-run, drop entry.
	cacheFlow.lintWithCache(linter, project.target('a.ts'), cache, 1);
	check('mode-A re-run executed rule', runs === 2);
	check('mode-A re-run dropped the entry', !cache.rules['typed']);
}

// ── Test 13 (layer 2): mode A (no incremental) never caches type-aware ──
{
	const project = createProject({ 'a.ts': 'const x = 1;' });
	const config: Config = {
		rules: {
			typed: ((rctx: RuleContext) => {
				void rctx.program;
				rctx.report('typed', 0, 1);
			}),
		},
	};
	const linter = core.createLinter(project.ctx, project.rootDir, config);
	const cache = emptyFileCache(1);

	// No options arg → mode A. Type-aware rules never cached.
	cacheFlow.lintWithCache(linter, project.target('a.ts'), cache, 1);
	check('default (no options) does NOT cache type-aware', !cache.rules['typed']);

	// Explicit incremental=false also mode A.
	cacheFlow.lintWithCache(linter, project.target('a.ts'), cache, 1, { incremental: false });
	check('explicit incremental=false does NOT cache type-aware', !cache.rules['typed']);
}

// ── Test 14 (layer 2): incremental writes type-aware even when affected ─
//
// First-time-ever (cold session) under --incremental: there's no prior
// entry to hit, but we must still WRITE one so the next session can
// hit. The split between "trust cache" (typeAwareUnaffected) and "write
// cache" (incremental) is the gate.
{
	const project = createProject({ 'a.ts': 'const x = 1;' });
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
	const linter = core.createLinter(project.ctx, project.rootDir, config);
	const cache = emptyFileCache(1);

	// Cold session under --incremental: no prev state, file is "affected"
	// (unaffected=false). Must run AND write entry.
	cacheFlow.lintWithCache(linter, project.target('a.ts'), cache, 1, {
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
	const project = createProject({ 'a.ts': 'const x = 1;' });
	const config: Config = {
		rules: {
			env_dependent: ((rctx: RuleContext) => {
				rctx.report('depends on env', 0, 1).withoutCache();
				rctx.report('plain', 0, 1);
			}),
		},
	};
	const linter = core.createLinter(project.ctx, project.rootDir, config);
	const cache = emptyFileCache(1);
	const diags = cacheFlow.lintWithCache(
		linter,
		project.target('a.ts'),
		cache,
		1,
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
		cache.rules['env_dependent']?.diagnostics[0]?.text === 'plain',
	);
}

// ── Test 16: withoutCache() — second run cache-hits with the survivor ───
{
	const project = createProject({ 'a.ts': 'const x = 1;' });
	const config: Config = {
		rules: {
			env_dependent: ((rctx: RuleContext) => {
				rctx.report('depends on env', 0, 1).withoutCache();
				rctx.report('plain', 0, 1);
			}),
		},
	};
	const linter = core.createLinter(project.ctx, project.rootDir, config);
	const cache = emptyFileCache(1);
	cacheFlow.lintWithCache(linter, project.target('a.ts'), cache, 1);

	// Second run with the same mtime — rule cache-hits, only the
	// persisted diagnostic comes back.
	const linter2 = core.createLinter(project.ctx, project.rootDir, config);
	const diags = cacheFlow.lintWithCache(
		linter2,
		project.target('a.ts'),
		cache,
		1,
	);
	check('warm cache hit returns 1 diagnostic', diags.length === 1);
	check('warm replay drops the marked one', diags[0]?.text === 'plain');
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
	const project = createProject({
		'skip.ts': 'const x = 1;',
		'check.ts': 'const y = 2;',
	});
	const config: Config = {
		rules: {
			'mixed-mode': ((rctx: RuleContext) => {
				if (rctx.file.fileName.endsWith('/skip.ts')) return;
				void rctx.program;
				rctx.report('typed', 0, 1);
			}),
		},
	};

	// ── Session 1: cold, both files lint — process the early-return file
	// FIRST so the rule isn't yet type-aware when its entry gets written.
	const linter1 = core.createLinter(project.ctx, project.rootDir, config);
	const cacheSkip: FileCache = emptyFileCache(1);
	const cacheCheck: FileCache = emptyFileCache(1);
	cacheFlow.lintWithCache(linter1, project.target('skip.ts'), cacheSkip, 1);
	cacheFlow.lintWithCache(linter1, project.target('check.ts'), cacheCheck, 1);

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
	const linter2 = core.createLinter(project.ctx, project.rootDir, config, ['mixed-mode']);
	let earlyReturnRanInSession2 = false;
	const config2: Config = {
		rules: {
			'mixed-mode': ((rctx: RuleContext) => {
				earlyReturnRanInSession2 = true;
				if (rctx.file.fileName.endsWith('/skip.ts')) return;
				void rctx.program;
				rctx.report('typed', 0, 1);
			}),
		},
	};
	const linterMonitored = core.createLinter(project.ctx, project.rootDir, config2, ['mixed-mode']);
	const session2Skip = cacheFlow.lintWithCache(
		linterMonitored,
		project.target('skip.ts'),
		cacheSkip,
		1,
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
	const project = createProject({ 'a.ts': 'const x = 1;' });
	const config: Config = {
		rules: {
			r: ((rctx: RuleContext) => {
				rctx.report('marked', 0, 1).withoutCache();
			}),
		},
	};
	const linter = core.createLinter(project.ctx, project.rootDir, config);
	const cache = emptyFileCache(1);
	cacheFlow.lintWithCache(linter, project.target('a.ts'), cache, 1);
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
	const project = createProject({ 'a.ts': code });
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
	const linter = core.createLinter(project.ctx, project.rootDir, config);
	const cache = emptyFileCache(1);

	const cold = cacheFlow.lintWithCache(linter, project.target('a.ts'), cache, 1);
	check(
		'cold pass: rule diag suppressed by disable comment, no user-visible diag',
		cold.length === 0,
		`cold returned ${cold.length} diags: ${cold.map(d => d.ruleId).join(',')}`,
	);
	check('cold pass: rule entry written to cache', !!cache.rules['foo']);
	check(
		'cold pass: cache stores the suppressed diagnostic so warm can re-evaluate',
		cache.rules['foo']?.diagnostics.length === 1,
	);

	const warm = cacheFlow.lintWithCache(linter, project.target('a.ts'), cache, 1);
	check(
		'warm pass: same comment suppresses the same (now-cached) diag — no unused-comment FP',
		warm.length === 0,
		`warm returned ${warm.length} diags: ${warm.map(d => d.ruleId).join(',')}`,
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
	const project = createProject({ 'a.ts': 'const x = 1;\n' });
	let runs = 0;
	const config: Config = {
		rules: {
			r: ((rctx: RuleContext) => {
				runs++;
				rctx.report('once', 0, 1);
			}),
		},
	};
	const linter = core.createLinter(project.ctx, project.rootDir, config);
	const cache = emptyFileCache(1);

	const cold = cacheFlow.lintWithCache(linter, project.target('a.ts'), cache, 1);
	check('cold: rule ran once', runs === 1);
	check('cold: 1 diag returned', cold.length === 1);

	const warm = cacheFlow.lintWithCache(linter, project.target('a.ts'), cache, 1);
	check('warm: rule did NOT re-run (cached)', runs === 1);
	check('warm: 1 diag returned (no duplication)', warm.length === 1);
	check(
		'warm diag has same payload as cold',
		warm[0].ruleId === cold[0].ruleId && warm[0].pos === cold[0].pos,
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
	const project = createProject({ 'a.ts': code });
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
	const linter = core.createLinter(project.ctx, project.rootDir, config);
	const cache = emptyFileCache(1);

	const cold = cacheFlow.lintWithCache(linter, project.target('a.ts'), cache, 1);
	const coldCodes = cold.map(d => d.ruleId).sort();
	check(
		'cold: only `bar` survives (`foo` suppressed by comment for `foo`)',
		cold.length === 1 && cold[0].ruleId === 'bar',
		`cold codes: ${coldCodes.join(',')}`,
	);

	const warm = cacheFlow.lintWithCache(linter, project.target('a.ts'), cache, 1);
	const warmCodes = warm.map(d => d.ruleId).sort();
	check(
		'warm: same single `bar` — no duplicate, no resurrected `foo`, no FP unused-comment',
		warm.length === 1 && warm[0].ruleId === 'bar',
		`warm codes: ${warmCodes.join(',')}`,
	);
}

// ── Test 22: ignore plugin's regex must capture scoped rule IDs ──────────
//
// `@scope/rule` and `plugin/rule` IDs (the dominant naming in the
// ecosystem) must be captured into `groups.ruleId` so each block-disable
// only suppresses errors for ITS targeted rule. The previous
// `\b(?<ruleId>\w\S*)?` pattern required the first char to be a word
// char, dropped scoped IDs onto the `comments.get(undefined)` "disable
// all" bucket. With multiple stacked block-disables on different scoped
// rules, only the FIRST entry under `undefined` got marked used by an
// incoming error — every subsequent block-disable was reported as
// unused even though it correctly targeted real fired diagnostics. Real
// repro: Astro's `extendables.ts` head with stacked
// `/* eslint-disable @typescript-eslint/no-namespace */` +
// `/* eslint-disable @typescript-eslint/no-empty-object-type */`.
{
	const ignorePlugin = require('@tsslint/config/lib/plugins/ignore.js') as {
		create: (cmd: string | [string, string], reportsUnused: boolean) => any;
	};
	const code = '/* eslint-disable @typescript-eslint/r1 */\n/* eslint-disable @typescript-eslint/r2 */\nconst x = 1;\n';
	const project = createProject({ 'a.ts': code });
	const config: Config = {
		rules: {
			'@typescript-eslint/r1': ((rctx: RuleContext) => {
				const at = code.indexOf('const');
				rctx.report('r1 fires', at, at + 5);
			}),
			'@typescript-eslint/r2': ((rctx: RuleContext) => {
				const at = code.indexOf('const');
				rctx.report('r2 fires', at, at + 5);
			}),
		},
		plugins: [ignorePlugin.create(['eslint-disable', 'eslint-enable'], true)],
	};
	const linter = core.createLinter(project.ctx, project.rootDir, config);
	const cache = emptyFileCache(1);

	const result = cacheFlow.lintWithCache(linter, project.target('a.ts'), cache, 1);
	check(
		'scoped block-disables: each independently suppresses its targeted rule (no unused FP on second comment)',
		result.length === 0,
		`expected 0 diags; got ${result.length}: ${result.map(d => `${d.ruleId}@${d.pos}`).join(',')}`,
	);
}

// ── Test 23: ignore plugin comment scanner — non-comment contexts ─────────
//
// The plugin's inlined comment walker relies on the AST-realized token
// boundaries (via `node.getChildren()` + `forEachLeading/TrailingCommentRange`)
// rather than driving `ts.createScanner` blindly. This is the difference
// between treating `\`${1} // fake\`` as a template literal (correct) vs
// firing a phantom directive on the embedded `//` (wrong).
//
// These three patterns must NOT surface as disable directives:
//   1. `//` substring inside a regex literal
//   2. `//` substring inside a template literal interpolation
//   3. `//` substring inside a string literal
//
// Plugin behavior: configure `reportsUnusedComments=true` so any
// detected disable comment becomes an `unused-ignore-comment`
// diagnostic. If the scanner mistakenly classifies these as comments
// — or the regex stops at the first match — the output diagnostic
// count diverges from 0.
{
	const ignorePlugin = require('@tsslint/config/lib/plugins/ignore.js') as {
		create: (cmd: string | [string, string], reportsUnused: boolean) => any;
	};
	const cases: { label: string; code: string }[] = [
		{
			label: 'regex literal containing /\\//',
			code: 'const r = /\\//; const x = 1;\n',
		},
		{
			label: 'template literal with ${} interpolation around //',
			code: 'const x = `${1} // eslint-disable-next-line foo`;\nconst y = 1;\n',
		},
		{
			label: 'string literal with // eslint-disable substring',
			code: 'const s = "// eslint-disable-next-line foo";\nconst y = 1;\n',
		},
	];
	for (const { label, code } of cases) {
		const project = createProject({ 'a.ts': code });
		const config: Config = {
			rules: {},
			plugins: [ignorePlugin.create('eslint-disable-next-line', true)],
		};
		const linter = core.createLinter(project.ctx, project.rootDir, config);
		const cache = emptyFileCache(1);
		const result = cacheFlow.lintWithCache(linter, project.target('a.ts'), cache, 1);
		check(
			`scanner: no phantom directive in ${label}`,
			result.length === 0,
			`expected 0 diags; got ${result.length}: ${result.map(d => d.ruleId).join(',')}`,
		);
	}
}

// ── Test 24: ignore plugin must collect ALL leading comments per token ───
//
// `ts.forEachLeading/TrailingCommentRange` short-circuits when the
// callback returns a truthy value (matches the documented `forEachX`
// contract). The plugin's `onComment` callback uses block-form arrow
// (no implicit return) — verify by feeding a file with N stacked
// disable comments at the head and asserting all N are processed.
// Concise-arrow `(p, e) => out.push(...)` would return `length` (truthy)
// and stop after the first comment, so only ONE of the N would be
// classified — every subsequent one would silently vanish. Real repro
// caught during inlining: `100 line comments → 1 detected`.
{
	const ignorePlugin = require('@tsslint/config/lib/plugins/ignore.js') as {
		create: (cmd: string | [string, string], reportsUnused: boolean) => any;
	};
	const lines: string[] = [];
	for (let i = 0; i < 20; i++) lines.push(`// eslint-disable-next-line r${i}`);
	lines.push('const x = 1;');
	const code = lines.join('\n') + '\n';
	const project = createProject({ 'a.ts': code });
	const config: Config = {
		rules: {},
		plugins: [ignorePlugin.create('eslint-disable-next-line', true)],
	};
	const linter = core.createLinter(project.ctx, project.rootDir, config);
	const cache = emptyFileCache(1);
	const result = cacheFlow.lintWithCache(linter, project.target('a.ts'), cache, 1);
	// Each disable targets a non-existent rule → all 20 are unused → 20 diagnostics.
	check(
		'comment-trivia callback: all N stacked comments processed (no truthy-return short-circuit)',
		result.length === 20,
		`expected 20 unused-comment diags (one per stacked disable); got ${result.length}`,
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
