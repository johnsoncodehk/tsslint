// Tests for the runtime probe that detects type-aware rules.
//
// A rule is "type-aware" if it reads `rulesContext.program` during
// execution. The probe is a getter on `program` that flips a flag.
// Once a rule has been observed reading `program`, it stays
// classified type-aware for the lifetime of the linter; pre-existing
// classification can be seeded via `initialTypeAwareRules`.
//
// Run via:
//   node packages/core/test/probe.test.js

import type { Config, RuleContext } from '@tsslint/types';
import { createProject } from './project';

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

// ── Test 1: rule that doesn't read program → not classified ──────────────
{
	const project = createProject({ 'a.ts': 'const x = 1;' });
	const config: Config = {
		rules: {
			plain: ((rctx: RuleContext) => {
				rctx.report('plain', 0, 1);
			}),
		},
	};
	const linter = core.createLinter(project.ctx, project.rootDir, config);
	linter.lint(project.target('a.ts'));
	check(
		'plain rule not classified type-aware',
		!linter.getTypeAwareRules().has('plain'),
	);
}

// ── Test 2: rule reads program → classified type-aware ────────────────────
{
	const project = createProject({ 'a.ts': 'const x = 1;' });
	const config: Config = {
		rules: {
			'type-aware': ((rctx: RuleContext) => {
				void rctx.program;
				rctx.report('typed', 0, 1);
			}),
		},
	};
	const linter = core.createLinter(project.ctx, project.rootDir, config);
	linter.lint(project.target('a.ts'));
	check(
		'rule that read program classified type-aware',
		linter.getTypeAwareRules().has('type-aware'),
	);
}

// ── Test 3: classification sticks across files in same session ───────────
{
	const project = createProject({
		'a.ts': 'const x = 1;',
		'b.ts': 'const y = 2;',
	});
	let touched = 0;
	const config: Config = {
		rules: {
			'sometimes-typed': ((rctx: RuleContext) => {
				if (rctx.file.fileName.endsWith('/a.ts')) {
					touched++;
					void rctx.program;
				}
				rctx.report('hi', 0, 1);
			}),
		},
	};
	const linter = core.createLinter(project.ctx, project.rootDir, config);
	linter.lint(project.target('a.ts'));
	linter.lint(project.target('b.ts'));
	check('rule touched program once', touched === 1);
	check(
		'classification sticks past the touching file',
		linter.getTypeAwareRules().has('sometimes-typed'),
	);
}

// ── Test 4: initialTypeAwareRules seeded from prior session is preserved ─
{
	const project = createProject({ 'a.ts': 'const x = 1;' });
	let ran = 0;
	const config: Config = {
		rules: {
			'syntactic-now': ((rctx: RuleContext) => {
				ran++;
				rctx.report('hi', 0, 1);
			}),
		},
	};
	const linter = core.createLinter(project.ctx, project.rootDir, config, ['syntactic-now']);
	linter.lint(project.target('a.ts'));
	check('rule still ran', ran === 1);
	check(
		'seeded classification preserved',
		linter.getTypeAwareRules().has('syntactic-now'),
		'rule was syntactic this session but type-aware in prior session — must remain classified',
	);
}

// ── Test 5 (regression): early-return-then-type-aware, reverse order ────
//
// User concern: a rule that file-shape-filters before reading
// `program` will be classified syntactic for the early-returning
// invocation. Verify that running the EARLY-RETURN file FIRST doesn't
// permanently mis-classify the rule — the next file that does touch
// program flips classification to type-aware mid-session, and it
// stays sticky.
{
	const project = createProject({
		'skip.ts': 'const x = 1;',
		'check.ts': 'const y = 2;',
	});
	const config: Config = {
		rules: {
			'mixed-mode': ((rctx: RuleContext) => {
				// Cheap pre-filter — only files matching the predicate
				// take the type-aware branch. /skip.ts early-returns.
				if (rctx.file.fileName.endsWith('/skip.ts')) return;
				void rctx.program;
				rctx.report('typed', 0, 1);
			}),
		},
	};
	const linter = core.createLinter(project.ctx, project.rootDir, config);

	// Process the early-return file FIRST.
	linter.lint(project.target('skip.ts'));
	check(
		'after early-return file: not yet classified',
		!linter.getTypeAwareRules().has('mixed-mode'),
		'sanity — probe correctly observed no program access on /skip.ts',
	);

	// Then the type-aware file. Classification flips mid-session.
	linter.lint(project.target('check.ts'));
	check(
		'after type-aware file: classified type-aware',
		linter.getTypeAwareRules().has('mixed-mode'),
	);

	// And it stays — re-linting the early-return file doesn't unclassify.
	linter.lint(project.target('skip.ts'));
	check(
		'classification sticks even after a subsequent early-return invocation',
		linter.getTypeAwareRules().has('mixed-mode'),
		'sticky semantics: a rule that has ever been observed touching program stays type-aware',
	);
}

// ── Test 6: getTypeAwareRules returns live set; mutations not allowed ────
{
	const project = createProject({ 'a.ts': 'const x = 1;' });
	const config: Config = {
		rules: {
			r: ((rctx: RuleContext) => {
				void rctx.program;
				rctx.report('x', 0, 1);
			}),
		},
	};
	const linter = core.createLinter(project.ctx, project.rootDir, config);
	const before = linter.getTypeAwareRules().size;
	check('initially empty', before === 0);
	linter.lint(project.target('a.ts'));
	const after = linter.getTypeAwareRules().size;
	check('grows after probe', after === 1);
}

process.stdout.write('\n');
if (failures.length) {
	console.error(`\n${failures.length} failure(s):`);
	for (const f of failures) console.error('  - ' + f);
	process.exit(1);
}
console.log('OK');
