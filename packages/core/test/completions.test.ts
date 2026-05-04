// Tests for `linter.getCompletions` — the IDE-side aggregator that
// merges `resolveCompletions` results from configured plugins. Exists
// because pre-3.2 the `@tsslint/config` ignore plugin reached for the
// host's `LanguageService.getCompletionsAtPosition` directly via
// `LinterContext`. That coupling is gone — plugins now expose
// completions through this hook, and `typescript-plugin` merges the
// aggregator's output into the host LS's completion result.
//
// Run via:
//   node packages/core/test/completions.test.js

import type { Config, PluginInstance } from '@tsslint/types';
import * as ts from 'typescript';

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
	return { typescript: ts, program: () => languageService.getProgram()! };
}

// ── Test 1: no plugins → empty entries ───────────────────────────────────
{
	const ctx = makeContext({ '/a.ts': 'const x = 1;' });
	const config: Config = { rules: {} };
	const linter = core.createLinter(ctx, '/', config, () => []);
	const result = linter.getCompletions('/a.ts', 0);
	check('no plugins: returns empty array', Array.isArray(result) && result.length === 0);
}

// ── Test 2: single plugin contributes an entry ────────────────────────────
{
	const ctx = makeContext({ '/a.ts': 'const x = 1;' });
	const plugin: PluginInstance = {
		resolveCompletions(_file, _position, entries) {
			entries.push({
				name: 'my-completion',
				kind: ts.ScriptElementKind.keyword,
				sortText: 'a',
			});
			return entries;
		},
	};
	const config: Config = {
		rules: {},
		plugins: [() => plugin],
	};
	const linter = core.createLinter(ctx, '/', config, () => []);
	const result = linter.getCompletions('/a.ts', 0);
	check('single plugin: 1 entry returned', result.length === 1);
	check('single plugin: name is correct', result[0]?.name === 'my-completion');
}

// ── Test 3: multiple plugins compose; later plugin sees earlier entries ──
{
	const ctx = makeContext({ '/a.ts': 'const x = 1;' });
	let observedByPluginB: number | undefined;
	const pluginA: PluginInstance = {
		resolveCompletions(_file, _position, entries) {
			entries.push({ name: 'a', kind: ts.ScriptElementKind.keyword, sortText: 'a' });
			return entries;
		},
	};
	const pluginB: PluginInstance = {
		resolveCompletions(_file, _position, entries) {
			// B sees A's entry already in the array (proves left-to-right
			// composition with an aggregating accumulator).
			observedByPluginB = entries.length;
			entries.push({ name: 'b', kind: ts.ScriptElementKind.keyword, sortText: 'b' });
			return entries;
		},
	};
	const config: Config = {
		rules: {},
		plugins: [() => pluginA, () => pluginB],
	};
	const linter = core.createLinter(ctx, '/', config, () => []);
	const result = linter.getCompletions('/a.ts', 0);
	check('two plugins: 2 entries total', result.length === 2);
	check('plugin B saw plugin A\'s entry first', observedByPluginB === 1);
	check('order preserved: a before b', result[0]?.name === 'a' && result[1]?.name === 'b');
}

// ── Test 4: plugin without resolveCompletions doesn't break aggregator ───
{
	const ctx = makeContext({ '/a.ts': 'const x = 1;' });
	const pluginNoCompletions: PluginInstance = {
		resolveDiagnostics(_file, diagnostics) {
			return diagnostics;
		},
		// no resolveCompletions
	};
	const pluginWithCompletions: PluginInstance = {
		resolveCompletions(_file, _position, entries) {
			entries.push({ name: 'only', kind: ts.ScriptElementKind.keyword, sortText: 'a' });
			return entries;
		},
	};
	const config: Config = {
		rules: {},
		plugins: [() => pluginNoCompletions, () => pluginWithCompletions],
	};
	const linter = core.createLinter(ctx, '/', config, () => []);
	const result = linter.getCompletions('/a.ts', 0);
	check('skips plugin without resolveCompletions', result.length === 1);
	check('still gets entry from contributing plugin', result[0]?.name === 'only');
}

// ── Test 5: missing file returns empty (program.getSourceFile undefined) ──
{
	const ctx = makeContext({ '/a.ts': 'const x = 1;' });
	const plugin: PluginInstance = {
		resolveCompletions(_file, _position, entries) {
			entries.push({ name: 'should-not-appear', kind: ts.ScriptElementKind.keyword, sortText: 'a' });
			return entries;
		},
	};
	const config: Config = {
		rules: {},
		plugins: [() => plugin],
	};
	const linter = core.createLinter(ctx, '/', config, () => []);
	// Asking about a file not in the program — guard short-circuits to [].
	const result = linter.getCompletions('/does-not-exist.ts', 0);
	check('missing file: empty result, plugin not invoked', result.length === 0);
}

// ── Test 6: plugin receives the SourceFile for the requested file ────────
{
	const ctx = makeContext({ '/a.ts': 'const hello = 1;' });
	let observedFileName: string | undefined;
	let observedText: string | undefined;
	const plugin: PluginInstance = {
		resolveCompletions(file, _position, entries) {
			observedFileName = file.fileName;
			observedText = file.text;
			return entries;
		},
	};
	const config: Config = {
		rules: {},
		plugins: [() => plugin],
	};
	const linter = core.createLinter(ctx, '/', config, () => []);
	linter.getCompletions('/a.ts', 5);
	check('plugin sees correct fileName', observedFileName === '/a.ts');
	check('plugin sees correct text', observedText === 'const hello = 1;');
}

// ── Test 7: position is passed through to plugin verbatim ────────────────
{
	const ctx = makeContext({ '/a.ts': 'const hello = 1;' });
	let observedPosition: number | undefined;
	const plugin: PluginInstance = {
		resolveCompletions(_file, position, entries) {
			observedPosition = position;
			return entries;
		},
	};
	const config: Config = {
		rules: {},
		plugins: [() => plugin],
	};
	const linter = core.createLinter(ctx, '/', config, () => []);
	linter.getCompletions('/a.ts', 12);
	check('plugin receives requested position', observedPosition === 12);
}

process.stdout.write('\n');
if (failures.length) {
	console.error(`\n${failures.length} failure(s):`);
	for (const f of failures) console.error('  - ' + f);
	process.exit(1);
}
console.log('OK');
