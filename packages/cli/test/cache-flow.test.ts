// Cache-flow tests. These cover the cache-aware lint pass — every
// invariant of the CLI's per-file cache entries.
//
// Run via:
//   node packages/cli/test/cache-flow.test.js

import type { Config, RuleContext } from '@tsslint/types';
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

// ── Test 1: lint writes the file's entry ─────────────────────────────────
{
	const project = createProject({ 'a.ts': 'const x = 1;' });
	const config: Config = {
		rules: {
			syntactic: ((rctx: RuleContext) => {
				rctx.report('hi', 0, 1);
			}),
			typed: ((rctx: RuleContext) => {
				void rctx.checker;
				rctx.report('typed', 0, 1);
			}),
		},
	};
	const linter = core.createLinter(project.ctx, project.rootDir, config);
	const files: Record<string, FileCache> = {};
	const target = project.target('a.ts');
	cacheFlow.lintWithCache(linter, target, files);
	const entry = files[target.file.fileName];
	check('file entry written', !!entry);
	check("entry holds every rule's diagnostics", entry?.diagnostics.length === 2);
	check('hasFix false (no fix reported)', entry?.hasFix === false);
}

// ── Test 2: cache hit skips every rule, replays diagnostics ──────────────
{
	const project = createProject({ 'a.ts': 'const x = 1;' });
	let runs = 0;
	const config: Config = {
		rules: {
			a: ((rctx: RuleContext) => {
				runs++;
				rctx.report('a', 0, 1);
			}),
			typed: ((rctx: RuleContext) => {
				runs++;
				void rctx.program;
				rctx.report('typed', 0, 1);
			}),
		},
	};
	const linter = core.createLinter(project.ctx, project.rootDir, config);
	const files: Record<string, FileCache> = {};

	const cold = cacheFlow.lintWithCache(linter, project.target('a.ts'), files);
	check('first call ran both rules', runs === 2);

	const warm = cacheFlow.lintWithCache(linter, project.target('a.ts'), files);
	check('second call ran no rule', runs === 2);
	check('second call replayed both diagnostics', warm.length === 2);
	check(
		'replayed diagnostics match the cold run',
		JSON.stringify(warm) === JSON.stringify(cold),
	);
	check(
		'replayed diagnostics are copies',
		warm[0] !== files[project.target('a.ts').file.fileName].diagnostics[0],
	);
}

// ── Test 3: a deleted entry re-lints ─────────────────────────────────────
//
// Invalidation deletes entries before linting starts; whatever is left
// is replayed as is.
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
	const files: Record<string, FileCache> = {};
	const target = project.target('a.ts');

	cacheFlow.lintWithCache(linter, target, files);
	delete files[target.file.fileName];
	cacheFlow.lintWithCache(linter, target, files);
	check('deleted entry → re-run', runs === 2);
	check('entry written again', !!files[target.file.fileName]);
}

// ── Test 4: hasFix, and `fix` re-lints a file with fixes ─────────────────
//
// Fixes are closures that don't survive the cache.
{
	const project = createProject({ 'a.ts': 'const x = 1;', 'b.ts': 'const y = 2;' });
	let runs = 0;
	const config: Config = {
		rules: {
			fixable: ((rctx: RuleContext) => {
				runs++;
				if (rctx.file.fileName.endsWith('/a.ts')) {
					rctx.report('fix me', 0, 1).withFix('apply', () => []);
				}
			}),
		},
	};
	const linter = core.createLinter(project.ctx, project.rootDir, config);
	const files: Record<string, FileCache> = {};
	const a = project.target('a.ts');
	const b = project.target('b.ts');
	cacheFlow.lintWithCache(linter, a, files);
	cacheFlow.lintWithCache(linter, b, files);
	check('hasFix true after rule registered fix', files[a.file.fileName]?.hasFix === true);
	check('hasFix false without fixes', files[b.file.fileName]?.hasFix === false);

	cacheFlow.lintWithCache(linter, a, files, { fix: true });
	check('fix re-lints a file with fixes', runs === 3);
	cacheFlow.lintWithCache(linter, b, files, { fix: true });
	check('fix replays a file without fixes', runs === 3);
}

// ── Test 5: warm replay keeps the ignore plugin's result ────────────────
//
// Scenario: a rule fires on line 2, an `// eslint-disable-next-line foo`
// comment on line 1 suppresses it, ignore plugin (`reportsUnusedComments
// = true`) marks the comment used. Cold pass produces 0 user-visible
// errors. The entry holds the result after plugins ran, so the warm pass
// must not turn the comment into an unused-comment false positive.
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
	const files: Record<string, FileCache> = {};

	const cold = cacheFlow.lintWithCache(linter, project.target('a.ts'), files);
	check(
		'cold pass: rule diag suppressed by disable comment, no user-visible diag',
		cold.length === 0,
		`cold returned ${cold.length} diags: ${cold.map(d => d.ruleId).join(',')}`,
	);
	check('cold pass: entry written to cache', files[project.target('a.ts').file.fileName]?.diagnostics.length === 0);

	const warm = cacheFlow.lintWithCache(linter, project.target('a.ts'), files);
	check(
		'warm pass: same comment suppresses the same (now-cached) diag — no unused-comment FP',
		warm.length === 0,
		`warm returned ${warm.length} diags: ${warm.map(d => d.ruleId).join(',')}`,
	);
}

// ── Test 6: cold and warm passes report once each ───────────────────────
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
	const files: Record<string, FileCache> = {};

	const cold = cacheFlow.lintWithCache(linter, project.target('a.ts'), files);
	check('cold: rule ran once', runs === 1);
	check('cold: 1 diag returned', cold.length === 1);

	const warm = cacheFlow.lintWithCache(linter, project.target('a.ts'), files);
	check('warm: rule did NOT re-run (cached)', runs === 1);
	check('warm: 1 diag returned (no duplication)', warm.length === 1);
	check(
		'warm diag has same payload as cold',
		warm[0].ruleId === cold[0].ruleId && warm[0].pos === cold[0].pos,
	);
}

// ── Test 7: multiple rules + ignore plugin, no duplication on warm ─────
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
	const files: Record<string, FileCache> = {};

	const cold = cacheFlow.lintWithCache(linter, project.target('a.ts'), files);
	const coldCodes = cold.map(d => d.ruleId).sort();
	check(
		'cold: only `bar` survives (`foo` suppressed by comment for `foo`)',
		cold.length === 1 && cold[0].ruleId === 'bar',
		`cold codes: ${coldCodes.join(',')}`,
	);

	const warm = cacheFlow.lintWithCache(linter, project.target('a.ts'), files);
	const warmCodes = warm.map(d => d.ruleId).sort();
	check(
		'warm: same single `bar` — no duplicate, no resurrected `foo`, no FP unused-comment',
		warm.length === 1 && warm[0].ruleId === 'bar',
		`warm codes: ${warmCodes.join(',')}`,
	);
}

// ── Test 8: ignore plugin's regex must capture scoped rule IDs ─────────
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
	const files: Record<string, FileCache> = {};

	const result = cacheFlow.lintWithCache(linter, project.target('a.ts'), files);
	check(
		'scoped block-disables: each independently suppresses its targeted rule (no unused FP on second comment)',
		result.length === 0,
		`expected 0 diags; got ${result.length}: ${result.map(d => `${d.ruleId}@${d.pos}`).join(',')}`,
	);
}

// ── Test 9: ignore plugin comment scanner — non-comment contexts ────────
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
		const files: Record<string, FileCache> = {};
		const result = cacheFlow.lintWithCache(linter, project.target('a.ts'), files);
		check(
			`scanner: no phantom directive in ${label}`,
			result.length === 0,
			`expected 0 diags; got ${result.length}: ${result.map(d => d.ruleId).join(',')}`,
		);
	}
}

// ── Test 10: ignore plugin must collect ALL leading comments per token ──
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
	const files: Record<string, FileCache> = {};
	const result = cacheFlow.lintWithCache(linter, project.target('a.ts'), files);
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
