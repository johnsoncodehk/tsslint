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
	const languageService = ts.createLanguageService(host);
	return { typescript: ts, languageServiceHost: host, languageService };
}

// ── Test 1: rule that doesn't read program → not classified ──────────────
{
	const ctx = makeContext({ '/a.ts': 'const x = 1;' });
	const config: Config = {
		rules: {
			plain: ((rctx: RuleContext) => {
				rctx.report('plain', 0, 1);
			}),
		},
	};
	const linter = core.createLinter(ctx, '/', config, () => []);
	linter.lint('/a.ts');
	check(
		'plain rule not classified type-aware',
		!linter.getTypeAwareRules().has('plain'),
	);
}

// ── Test 2: rule reads program → classified type-aware ────────────────────
{
	const ctx = makeContext({ '/a.ts': 'const x = 1;' });
	const config: Config = {
		rules: {
			'type-aware': ((rctx: RuleContext) => {
				void rctx.program;
				rctx.report('typed', 0, 1);
			}),
		},
	};
	const linter = core.createLinter(ctx, '/', config, () => []);
	linter.lint('/a.ts');
	check(
		'rule that read program classified type-aware',
		linter.getTypeAwareRules().has('type-aware'),
	);
}

// ── Test 3: classification sticks across files in same session ───────────
{
	const ctx = makeContext({
		'/a.ts': 'const x = 1;',
		'/b.ts': 'const y = 2;',
	});
	let touched = 0;
	const config: Config = {
		rules: {
			'sometimes-typed': ((rctx: RuleContext) => {
				if (rctx.file.fileName === '/a.ts') {
					touched++;
					void rctx.program;
				}
				rctx.report('hi', 0, 1);
			}),
		},
	};
	const linter = core.createLinter(ctx, '/', config, () => []);
	linter.lint('/a.ts');
	linter.lint('/b.ts');
	check('rule touched program once', touched === 1);
	check(
		'classification sticks past the touching file',
		linter.getTypeAwareRules().has('sometimes-typed'),
	);
}

// ── Test 4: initialTypeAwareRules seeded from prior session is preserved ─
{
	const ctx = makeContext({ '/a.ts': 'const x = 1;' });
	let ran = 0;
	const config: Config = {
		rules: {
			'syntactic-now': ((rctx: RuleContext) => {
				ran++;
				rctx.report('hi', 0, 1);
			}),
		},
	};
	const linter = core.createLinter(ctx, '/', config, () => [], ['syntactic-now']);
	linter.lint('/a.ts');
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
	const ctx = makeContext({
		'/skip.ts': 'const x = 1;',
		'/check.ts': 'const y = 2;',
	});
	const config: Config = {
		rules: {
			'mixed-mode': ((rctx: RuleContext) => {
				// Cheap pre-filter — only files matching the predicate
				// take the type-aware branch. /skip.ts early-returns.
				if (rctx.file.fileName === '/skip.ts') return;
				void rctx.program;
				rctx.report('typed', 0, 1);
			}),
		},
	};
	const linter = core.createLinter(ctx, '/', config, () => []);

	// Process the early-return file FIRST.
	linter.lint('/skip.ts');
	check(
		'after early-return file: not yet classified',
		!linter.getTypeAwareRules().has('mixed-mode'),
		'sanity — probe correctly observed no program access on /skip.ts',
	);

	// Then the type-aware file. Classification flips mid-session.
	linter.lint('/check.ts');
	check(
		'after type-aware file: classified type-aware',
		linter.getTypeAwareRules().has('mixed-mode'),
	);

	// And it stays — re-linting the early-return file doesn't unclassify.
	linter.lint('/skip.ts');
	check(
		'classification sticks even after a subsequent early-return invocation',
		linter.getTypeAwareRules().has('mixed-mode'),
		'sticky semantics: a rule that has ever been observed touching program stays type-aware',
	);
}

// ── Test 6: getTypeAwareRules returns live set; mutations not allowed ────
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
	const linter = core.createLinter(ctx, '/', config, () => []);
	const before = linter.getTypeAwareRules().size;
	check('initially empty', before === 0);
	linter.lint('/a.ts');
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
