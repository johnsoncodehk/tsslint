// Dogfood parity script. Sibling to run.ts, but instead of the
// hand-crafted corpus it diffs ESLint vs TSSLint diagnostics on
// real-world TS source from this monorepo.
//
// Usage:
//   pnpm tsc --build && node packages/compat-eslint/test/bench/dogfood.js
//
// What it does, vs. run.ts:
// - Single ts.Program rooted at all real production .ts files in the
//   monorepo (~30 files).
// - Same 87 rules from rules.config.ts, no per-file selection.
// - Per-(rule, file) diff. Crashes are first-class — a thrown
//   error in either runner is reported separately from a count diff.
// - Output is grouped: each unique (rule, divergence-pattern) is
//   collapsed to one entry plus a single example location.

import * as oracle from '@tsslint/estree-oracle';
import * as path from 'path';
import type { SourceFile } from 'typescript/ast';
import type { Checker, Program } from 'typescript/sync';
import { createProjectForFiles } from '../ts7';
import { DOGFOOD_FILES } from './dogfood-corpus';

const compat = require('../../index.js') as typeof import('../../index.js');
const { Linter } = oracle.eslint;
const tsParser = oracle.parser;

const { RULES } = require('./rules.config.js') as { RULES: Array<[string, unknown[]?]> };

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..');

interface DiagLoc {
	file: string;
	line: number;
	column: number;
	ruleId: string;
}

function buildProgram(files: readonly string[]) {
	const absFiles = files.map(f => path.join(REPO_ROOT, f));
	const { program, checker } = createProjectForFiles(absFiles, {
		target: 'es2020',
		lib: ['es2020'],
		module: 'nodenext',
		moduleResolution: 'nodenext',
		types: [],
		strict: true,
		noImplicitAny: false,
		skipLibCheck: true,
	});
	const sources = new Map<string, SourceFile>();
	for (const abs of absFiles) sources.set(abs, program.getSourceFile(abs)!);
	return { program, checker, sources };
}

function loadRule(ruleName: string): unknown {
	const eslintRoot = path.dirname(require.resolve('eslint/package.json'));
	return require(path.join(eslintRoot, 'lib/rules', ruleName + '.js'));
}

// convertRule's shared traversal runs once per file with every rule
// registered at that moment, so all rules must be converted up front.
const convertedRules = new Map<string, ReturnType<typeof compat.convertRule>>();
for (const [ruleName, options = []] of RULES) {
	convertedRules.set(ruleName, compat.convertRule(loadRule(ruleName) as any, options as any[], { id: ruleName }));
}

function runTsslint(
	program: Program,
	checker: Checker,
	sf: SourceFile,
	ruleName: string,
): DiagLoc[] {
	const out: DiagLoc[] = [];
	const tsslintRule = convertedRules.get(ruleName)!;
	const reportFn: any = (_msg: string, start: number, _end: number) => {
		const lc = sf.getLineAndCharacterOfPosition(start);
		out.push({ file: sf.fileName, line: lc.line + 1, column: lc.character + 1, ruleId: ruleName });
		const r: any = {
			at() {
				return r;
			},
			asWarning() {
				return r;
			},
			asError() {
				return r;
			},
			asSuggestion() {
				return r;
			},
			withFix() {
				return r;
			},
			withRefactor() {
				return r;
			},
			withDeprecated() {
				return r;
			},
			withUnnecessary() {
				return r;
			},
		};
		return r;
	};
	tsslintRule({ file: sf, report: reportFn, program, checker } as any);
	return out;
}

function runEslint(
	linter: import('eslint').Linter,
	code: string,
	fileName: string,
	ruleName: string,
	options: unknown[],
): DiagLoc[] {
	const config: any = {
		files: ['**/*.ts'],
		languageOptions: {
			parser: tsParser,
			parserOptions: { ecmaVersion: 'latest', sourceType: 'module' },
		},
		rules: { [ruleName]: ['error', ...options] },
	};
	const messages = linter.verify(code, [config], fileName);
	return messages
		.filter(m => m.ruleId === ruleName)
		.map(m => ({ file: fileName, line: m.line ?? 0, column: m.column ?? 0, ruleId: ruleName }));
}

function key(d: DiagLoc): string {
	return `${d.line}:${d.column}`;
}

interface CrashRecord {
	rule: string;
	file: string;
	runner: 'tsslint' | 'eslint';
	message: string;
}
interface DivergenceRecord {
	rule: string;
	file: string;
	tsslintOnly: string[];
	eslintOnly: string[];
}

async function main() {
	const corpus = DOGFOOD_FILES;
	const { program, checker, sources } = buildProgram(corpus);
	// Linter's cwd defaults to process.cwd(); set it to REPO_ROOT so that
	// absolute paths under the repo (e.g. /repo-root/packages/cli/index.ts)
	// resolve to a relative form (`packages/cli/index.ts`) that matches
	// `files: ['**/*.ts']`. Without this, ESLint silently emits "No matching
	// configuration found" and the rules never run — every TSSLint report
	// then shows up as a regression.
	const linter = new Linter({ cwd: REPO_ROOT });

	const crashes: CrashRecord[] = [];
	const divergences: DivergenceRecord[] = [];
	let pairs = 0;

	for (const [ruleName, options = []] of RULES) {
		for (const file of corpus) {
			pairs++;
			const abs = path.join(REPO_ROOT, file);
			const sf = sources.get(abs)!;
			const code = sf.text;

			let t: DiagLoc[] | null = null;
			let e: DiagLoc[] | null = null;
			try {
				t = runTsslint(program, checker, sf, ruleName);
			}
			catch (err: any) {
				crashes.push({ rule: ruleName, file, runner: 'tsslint', message: err?.message ?? String(err) });
			}
			try {
				// Use absolute path matching the program's rootNames so
				// `parserOptions.programs` lookup succeeds (without it,
				// type-aware plugin rules silently re-parse without type
				// info and emit nothing).
				e = runEslint(linter, code, abs, ruleName, options);
			}
			catch (err: any) {
				crashes.push({ rule: ruleName, file, runner: 'eslint', message: err?.message ?? String(err) });
			}

			if (!t || !e) continue;
			const ts_ = new Set(t.map(key));
			const es_ = new Set(e.map(key));
			const tsslintOnly = [...ts_].filter(k => !es_.has(k)).sort();
			const eslintOnly = [...es_].filter(k => !ts_.has(k)).sort();
			if (tsslintOnly.length || eslintOnly.length) {
				divergences.push({ rule: ruleName, file, tsslintOnly, eslintOnly });
			}
		}
	}

	console.log(`Files dogfooded: ${corpus.length}`);
	for (const f of corpus) console.log(`  ${f}`);
	console.log(`Total (rule, file) pairs: ${pairs}`);
	console.log(`Divergences: ${divergences.length}`);
	console.log(`Crashes: ${crashes.length}`);

	if (crashes.length) {
		console.log(`\nCrashes:`);
		for (const c of crashes) {
			console.log(`  [${c.runner}] ${c.rule} on ${c.file}: ${c.message.split('\n')[0]}`);
		}
	}

	if (divergences.length) {
		// Group by rule. Within each rule, summarise total
		// occurrences across files and pick one example.
		const byRule = new Map<string, DivergenceRecord[]>();
		for (const d of divergences) {
			if (!byRule.has(d.rule)) byRule.set(d.rule, []);
			byRule.get(d.rule)!.push(d);
		}
		console.log(`\nGrouped divergences:`);
		const sorted = [...byRule.entries()].sort((a, b) => {
			const aOcc = a[1].reduce((s, d) => s + d.tsslintOnly.length + d.eslintOnly.length, 0);
			const bOcc = b[1].reduce((s, d) => s + d.tsslintOnly.length + d.eslintOnly.length, 0);
			return bOcc - aOcc;
		});
		for (const [rule, records] of sorted) {
			let tsslintOver = 0, missed = 0;
			let example: { file: string; loc: string; kind: 'over' | 'missed' } | null = null;
			for (const r of records) {
				tsslintOver += r.tsslintOnly.length;
				missed += r.eslintOnly.length;
				if (!example && r.tsslintOnly.length) {
					example = { file: r.file, loc: r.tsslintOnly[0], kind: 'over' };
				}
				else if (!example && r.eslintOnly.length) {
					example = { file: r.file, loc: r.eslintOnly[0], kind: 'missed' };
				}
			}
			console.log(`  [${rule}] over=${tsslintOver} missed=${missed} across ${records.length} file(s)`);
			if (example) {
				console.log(`      example: ${example.file}:${example.loc} (TSSLint ${example.kind})`);
			}
			for (const r of records) {
				const overTail = r.tsslintOnly.slice(0, 3).join(', ');
				const missTail = r.eslintOnly.slice(0, 3).join(', ');
				const parts: string[] = [];
				if (r.tsslintOnly.length) {
					parts.push(`over[${r.tsslintOnly.length}]: ${overTail}${r.tsslintOnly.length > 3 ? ', ...' : ''}`);
				}
				if (r.eslintOnly.length) {
					parts.push(`missed[${r.eslintOnly.length}]: ${missTail}${r.eslintOnly.length > 3 ? ', ...' : ''}`);
				}
				console.log(`      ${r.file} — ${parts.join(' | ')}`);
			}
		}
	}

	if (!crashes.length && !divergences.length) {
		console.log(`\nclean across ${corpus.length} files × ${RULES.length} rules`);
		return 0;
	}
	return 0; // Don't fail CI — this is exploratory.
}

main().then(code => process.exit(code)).catch(e => {
	console.error(e);
	process.exit(2);
});
