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

import * as path from 'path';
import * as fs from 'fs';
import * as ts from 'typescript';

const compat = require('../../index.js') as typeof import('../../index.js');
const { Linter } = require('eslint') as typeof import('eslint');
const tsParser = require('@typescript-eslint/parser');

const { RULES } = require('./rules.config.js') as { RULES: Array<[string, unknown[]?]> };

// Repo-root-relative paths for the dogfood corpus. All real
// production .ts files in the monorepo (excluding .d.ts, fixtures,
// tests, bench, node_modules, worktrees).
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const DOGFOOD_FILES = [
	'packages/cli/index.ts',
	'packages/cli/lib/cache.ts',
	'packages/cli/lib/colors.ts',
	'packages/cli/lib/fs-cache.ts',
	'packages/cli/lib/languagePlugins.ts',
	'packages/cli/lib/render.ts',
	'packages/cli/lib/worker.ts',
	'packages/compat-eslint/index.ts',
	'packages/compat-eslint/lib/lazy-estree.ts',
	'packages/compat-eslint/lib/selector-analysis.ts',
	'packages/compat-eslint/lib/tokens.ts',
	'packages/compat-eslint/lib/ts-ast-scan.ts',
	'packages/compat-eslint/lib/ts-scope-manager.ts',
	'packages/compat-eslint/lib/visitor-keys.ts',
	'packages/config/index.ts',
	'packages/config/lib/eslint-gen.ts',
	'packages/config/lib/eslint-types.ts',
	'packages/config/lib/eslint.ts',
	'packages/config/lib/plugins/category.ts',
	'packages/config/lib/plugins/diagnostics.ts',
	'packages/config/lib/plugins/ignore.ts',
	'packages/config/lib/tsl.ts',
	'packages/config/lib/tslint-gen.ts',
	'packages/config/lib/tslint-types.ts',
	'packages/config/lib/tslint.ts',
	'packages/config/lib/utils.ts',
	'packages/core/index.ts',
	'packages/types/index.ts',
	'packages/typescript-plugin/index.ts',
	'tsslint.config.ts',
];

interface DiagLoc { file: string; line: number; column: number; ruleId: string }

function buildProgram(files: string[]) {
	const realLibPath = ts.getDefaultLibFilePath({ target: ts.ScriptTarget.ES2020 });
	const realLibName = realLibPath.split(/[\\/]/).pop()!;
	const realLib = ts.createSourceFile(realLibPath, ts.sys.readFile(realLibPath) ?? '', ts.ScriptTarget.ES2020, true, ts.ScriptKind.TS);
	const sources = new Map<string, ts.SourceFile>();
	for (const f of files) {
		const abs = path.join(REPO_ROOT, f);
		const text = fs.readFileSync(abs, 'utf8');
		// Use the in-repo absolute path so cross-imports between
		// packages resolve naturally; the program never writes.
		sources.set(abs, ts.createSourceFile(abs, text, ts.ScriptTarget.ES2020, true, ts.ScriptKind.TS));
	}
	const host: ts.CompilerHost = {
		getSourceFile: name => sources.get(name) ?? (name === realLibPath ? realLib : undefined),
		getDefaultLibFileName: () => realLibName,
		writeFile: () => {},
		getCurrentDirectory: () => REPO_ROOT,
		getDirectories: () => [],
		fileExists: name => sources.has(name) || name === realLibPath || ts.sys.fileExists(name),
		readFile: name => {
			const sf = sources.get(name);
			if (sf) return sf.text;
			if (name === realLibPath) return realLib.text;
			return ts.sys.readFile(name);
		},
		getCanonicalFileName: n => n,
		useCaseSensitiveFileNames: () => true,
		getNewLine: () => '\n',
	};
	const program = ts.createProgram({
		rootNames: [...sources.keys()],
		options: {
			target: ts.ScriptTarget.ES2020,
			lib: ['es2020'],
			module: ts.ModuleKind.NodeNext,
			moduleResolution: ts.ModuleResolutionKind.NodeNext,
			types: [],
			noEmit: true,
			strict: false,
			noImplicitAny: false,
			allowJs: false,
			skipLibCheck: true,
		},
		host,
	});
	return { program, sources };
}

function runTsslint(program: ts.Program, sf: ts.SourceFile, ruleName: string, options: unknown[]): DiagLoc[] {
	const eslintRoot = path.dirname(require.resolve('eslint/package.json'));
	const rule = require(path.join(eslintRoot, 'lib/rules', ruleName + '.js'));
	const out: DiagLoc[] = [];
	const tsslintRule = compat.convertRule(rule, options as any[], { id: ruleName } as any);
	const reportFn: any = (_msg: string, start: number, _end: number) => {
		const lc = sf.getLineAndCharacterOfPosition(start);
		out.push({ file: sf.fileName, line: lc.line + 1, column: lc.character + 1, ruleId: ruleName });
		const r: any = { at() { return r; }, asWarning() { return r; }, asError() { return r; }, asSuggestion() { return r; }, withFix() { return r; }, withRefactor() { return r; }, withDeprecated() { return r; }, withUnnecessary() { return r; }, withoutCache() { return r; } };
		return r;
	};
	tsslintRule({ file: sf, report: reportFn, program } as any);
	return out;
}

function runEslint(linter: import('eslint').Linter, code: string, fileName: string, ruleName: string, options: unknown[]): DiagLoc[] {
	const messages = linter.verify(code, [{
		files: ['**/*.ts'],
		languageOptions: {
			parser: tsParser,
			parserOptions: { ecmaVersion: 'latest', sourceType: 'module' },
		},
		rules: { [ruleName]: ['error', ...options] },
	}], path.join(process.cwd(), fileName));
	return messages
		.filter(m => m.ruleId === ruleName)
		.map(m => ({ file: fileName, line: m.line ?? 0, column: m.column ?? 0, ruleId: ruleName }));
}

function key(d: DiagLoc): string { return `${d.line}:${d.column}`; }

interface CrashRecord { rule: string; file: string; runner: 'tsslint' | 'eslint'; message: string }
interface DivergenceRecord {
	rule: string;
	file: string;
	tsslintOnly: string[];
	eslintOnly: string[];
}

async function main() {
	const corpus = DOGFOOD_FILES;
	const { program, sources } = buildProgram(corpus);
	const linter = new Linter();

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
				t = runTsslint(program, sf, ruleName, options);
			} catch (err: any) {
				crashes.push({ rule: ruleName, file, runner: 'tsslint', message: err?.message ?? String(err) });
			}
			try {
				e = runEslint(linter, code, file, ruleName, options);
			} catch (err: any) {
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
				} else if (!example && r.eslintOnly.length) {
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
				if (r.tsslintOnly.length) parts.push(`over[${r.tsslintOnly.length}]: ${overTail}${r.tsslintOnly.length > 3 ? ', ...' : ''}`);
				if (r.eslintOnly.length) parts.push(`missed[${r.eslintOnly.length}]: ${missTail}${r.eslintOnly.length > 3 ? ', ...' : ''}`);
				console.log(`      ${r.file} — ${parts.join(' | ')}`);
			}
		}
	}

	if (!crashes.length && !divergences.length) {
		console.log(`\nclean across ${corpus.length} files × ${RULES.length} rules`);
		return 0;
	}
	return 0;  // Don't fail CI — this is exploratory.
}

main().then(code => process.exit(code)).catch(e => { console.error(e); process.exit(2); });
