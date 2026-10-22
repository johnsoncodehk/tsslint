// Per-rule parity bench. Runs every (rule, file) pair through both
// TSSLint's `compat.convertRule` and ESLint's `Linter.verify`, diffs
// the resulting diagnostics location-by-location, and compares the
// shape against the committed `baseline.json`.
//
// Usage:
//   node packages/compat-eslint/test/bench/run.js
//     → exits non-zero on any unexpected per-location diff
//   node packages/compat-eslint/test/bench/run.js --update-baseline
//     → regenerates baseline.json (review the diff in PR)
//
// Design decisions:
// - Lives entirely in-process. No CLI subprocess, no temp files.
// - One `Linter` instance reused. One TSSLint program per file.
// - Diff is location-keyed (`file:line:col`), not count-keyed —
//   "TSSLint over by 1, missed 1, total 0" must still fail.
// - Baseline records the EXPECTED set of (rule, file, line, col)
//   diffs (ideally empty). New unexpected diffs fail; absent
//   expected diffs also fail (the bug got fixed, baseline is stale).

import * as fs from 'fs';
import * as path from 'path';
import * as oracle from '@tsslint/estree-oracle';
import type { SourceFile } from 'typescript/ast';
import type { Checker, Program } from 'typescript/sync';
import { createProjectForFiles } from '../ts7';

const compat = require('../../index.js') as typeof import('../../index.js');
const { Linter } = oracle.eslint;
const tsParser = oracle.parser;

const { RULES } = require('./rules.config.js') as { RULES: Array<[string, unknown[]?]> };

const CORPUS_DIR = path.join(__dirname, 'corpus');
const BASELINE_PATH = path.join(__dirname, 'baseline.json');

interface DiagLoc {
	file: string;
	line: number;
	column: number;
	ruleId: string;
}

function listCorpus(): string[] {
	return fs.readdirSync(CORPUS_DIR)
		.filter(f => f.endsWith('.ts'))
		.sort();
}

// One TypeScript 7 project over every corpus file so cross-file imports
// type-check. Reuse it across all rule runs for the same file, since
// `convertRule` keeps a per-file cache.
function buildProgram(files: string[]) {
	const { program, checker } = createProjectForFiles(files.map(f => path.join(CORPUS_DIR, f)), {
		target: 'es2020',
		lib: ['es2020'],
		module: 'nodenext',
		moduleResolution: 'nodenext',
		types: [],
		strict: true,
		noImplicitAny: false,
	});
	const sources = new Map<string, SourceFile>();
	for (const f of files) sources.set(f, program.getSourceFile(path.join(CORPUS_DIR, f))!);
	return { program, checker, sources };
}

function loadRule(ruleName: string): unknown {
	const eslintRoot = path.dirname(require.resolve('eslint/package.json'));
	return require(path.join(eslintRoot, 'lib/rules', ruleName + '.js'));
}

// Pre-register all rules with convertRule BEFORE running any of them on
// files. convertRule's shared traversal (`runSharedTraversal`) fires once
// per file using whatever rules are in `ruleRegistry` at that point. If
// rules are registered one-by-one interleaved with file processing, later
// rules miss the already-cached traversal. Pre-registering mirrors
// production usage (importESLintRules registers everything, then the CLI
// calls the returned functions on files).
const convertedRules = new Map<string, ReturnType<typeof compat.convertRule>>();

function preRegisterAllRules(): void {
	for (const [ruleName, options = []] of RULES) {
		const rule = loadRule(ruleName);
		convertedRules.set(ruleName, compat.convertRule(rule as any, options as any[], { id: ruleName }));
	}
}

function runTsslint(
	program: Program,
	checker: Checker,
	sf: SourceFile,
	ruleName: string,
	_options: unknown[],
): DiagLoc[] {
	const out: DiagLoc[] = [];
	const tsslintRule = convertedRules.get(ruleName)!;
	const reportFn: any = (msg: string, start: number, _end: number) => {
		const lc = sf.getLineAndCharacterOfPosition(start);
		if (process.env.BENCH_DEBUG && ruleName === process.env.BENCH_DEBUG) {
			console.log(`[${ruleName}] ${sf.fileName}:${lc.line + 1}:${lc.character + 1} — ${msg}`);
		}
		out.push({ file: '/' + path.basename(sf.fileName), line: lc.line + 1, column: lc.character + 1, ruleId: ruleName });
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
			withoutCache() {
				return r;
			},
		};
		return r;
	};
	try {
		tsslintRule({ file: sf, report: reportFn, program, checker } as any);
	}
	catch (e) {
		if (process.env.BENCH_DEBUG && ruleName === process.env.BENCH_DEBUG) {
			console.log(`[${ruleName}] ${sf.fileName} CRASH: ${(e as Error).message}`);
		}
	}
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
	if (process.env.BENCH_DEBUG_ESLINT && ruleName === process.env.BENCH_DEBUG_ESLINT) {
		console.log(`[ESLINT ${ruleName}] ${fileName} → ${messages.length} messages`, messages.slice(0, 3));
	}
	return messages
		.filter(m => m.ruleId === ruleName)
		.map(m => ({ file: '/' + path.basename(fileName), line: m.line ?? 0, column: m.column ?? 0, ruleId: ruleName }));
}

function key(d: DiagLoc): string {
	return `${d.file}:${d.line}:${d.column}`;
}

interface Diff {
	tsslintOnly: string[];
	eslintOnly: string[];
}

function diff(t: DiagLoc[], e: DiagLoc[]): Diff {
	const ts_ = new Set(t.map(key));
	const es_ = new Set(e.map(key));
	return {
		tsslintOnly: [...ts_].filter(k => !es_.has(k)).sort(),
		eslintOnly: [...es_].filter(k => !ts_.has(k)).sort(),
	};
}

interface BaselineEntry {
	tsslintOnly?: string[];
	eslintOnly?: string[];
	reason?: string;
}

function loadBaseline(): Record<string, Record<string, BaselineEntry>> {
	if (!fs.existsSync(BASELINE_PATH)) return {};
	return JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf8'));
}

function saveBaseline(b: Record<string, Record<string, BaselineEntry>>) {
	const ordered: Record<string, Record<string, BaselineEntry>> = {};
	for (const r of Object.keys(b).sort()) {
		ordered[r] = {};
		for (const f of Object.keys(b[r]).sort()) ordered[r][f] = b[r][f];
	}
	fs.writeFileSync(BASELINE_PATH, JSON.stringify(ordered, null, '\t') + '\n');
}

function diffsEqual(actual: Diff, expected: BaselineEntry): boolean {
	const ae = (a: string[] | undefined, b: string[] | undefined) => {
		const aa = a ?? [];
		const bb = b ?? [];
		if (aa.length !== bb.length) return false;
		for (let i = 0; i < aa.length; i++) if (aa[i] !== bb[i]) return false;
		return true;
	};
	return ae(actual.tsslintOnly, expected.tsslintOnly) && ae(actual.eslintOnly, expected.eslintOnly);
}

async function main() {
	const updateBaseline = process.argv.includes('--update-baseline');
	const verbose = process.argv.includes('--verbose');

	const corpus = listCorpus();
	const { program, checker, sources } = buildProgram(corpus);
	const linter = new Linter();
	const baseline = loadBaseline();
	const newBaseline: Record<string, Record<string, BaselineEntry>> = {};

	let totalRegressions = 0;
	let totalFixed = 0;

	preRegisterAllRules();

	for (const [ruleName, options = []] of RULES) {
		newBaseline[ruleName] = {};
		for (const file of corpus) {
			const sf = sources.get(file)!;
			const code = sf.text;
			const t = runTsslint(program, checker, sf, ruleName, options);
			const e = runEslint(linter, code, path.join(process.cwd(), file), ruleName, options);
			const d = diff(t, e);
			const hasDiff = d.tsslintOnly.length > 0 || d.eslintOnly.length > 0;

			if (hasDiff) {
				newBaseline[ruleName][file] = {
					...(d.tsslintOnly.length ? { tsslintOnly: d.tsslintOnly } : {}),
					...(d.eslintOnly.length ? { eslintOnly: d.eslintOnly } : {}),
				};
			}

			const expected = baseline[ruleName]?.[file];
			const expectedHas = expected !== undefined;
			if (!hasDiff && !expectedHas) continue; // clean

			if (updateBaseline) continue; // recording, no compare

			if (!hasDiff && expectedHas) {
				console.log(`✓ FIXED ${ruleName} ${file} — baseline expected diff is now clean`);
				totalFixed++;
				continue;
			}
			if (hasDiff && !expectedHas) {
				console.log(`✗ REGRESSION ${ruleName} ${file}`);
				if (d.tsslintOnly.length) console.log(`    TSSLint over: ${d.tsslintOnly.join(', ')}`);
				if (d.eslintOnly.length) console.log(`    TSSLint missed: ${d.eslintOnly.join(', ')}`);
				totalRegressions++;
				continue;
			}
			if (hasDiff && expectedHas && !diffsEqual(d, expected)) {
				console.log(`✗ DRIFTED ${ruleName} ${file}`);
				console.log(`    expected: ${JSON.stringify(expected)}`);
				console.log(`    actual:   ${JSON.stringify(newBaseline[ruleName][file])}`);
				totalRegressions++;
				continue;
			}
			// hasDiff && expectedHas && equal: known-broken, silently OK.
			if (verbose) console.log(`◌ baseline-known ${ruleName} ${file}`);
		}
		if (Object.keys(newBaseline[ruleName]).length === 0) delete newBaseline[ruleName];
	}

	if (updateBaseline) {
		saveBaseline(newBaseline);
		console.log(`baseline updated — ${Object.keys(newBaseline).length} rule(s) with known divergences`);
		return 0;
	}

	if (totalRegressions > 0) {
		console.log(`\n${totalRegressions} regression(s) — fix the code or run with --update-baseline if intended`);
		return 1;
	}
	if (totalFixed > 0) {
		console.log(`\n${totalFixed} previously-known divergence(s) are now clean — run with --update-baseline to refresh`);
		return 1;
	}
	console.log(`bench: ${RULES.length} rules × ${corpus.length} files = clean parity`);
	return 0;
}

main().then(code => process.exit(code)).catch(e => {
	console.error(e);
	process.exit(2);
});
