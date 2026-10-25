// CLI integration tests. Spawns the local tsslint binary against a
// throwaway fixture and inspects diagnostics + cache state on disk.
// These complement the in-process cache-flow unit tests by exercising
// the actual lint loop, mtime check, --force gate, and cache file
// load/save round-trip.
//
// Run via:
//   node packages/cli/test/integration.test.js

import path = require('path');
import fs = require('fs');
import os = require('os');
import url = require('url');
import { spawnSync } from 'child_process';

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

const repoRoot = path.resolve(__dirname, '../../..');
const tsslintBin = path.join(repoRoot, 'packages/cli/bin/tsslint.js');
const noConsoleRule = path.join(repoRoot, 'fixtures/noConsoleRule.ts');
const configModule = path.join(repoRoot, 'packages/config/index.js');

// Module specifier for an absolute path; a bare `C:\...` path is not a
// valid ESM import on Windows.
function importPath(fileName: string): string {
	return JSON.stringify(url.pathToFileURL(fileName).href);
}

function makeFixture(): string {
	// Resolve symlinks (macOS' /var → /private/var) so paths line up with
	// the realpath-canonicalised keys the CLI stores in the cache file.
	const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tsslint-int-')));
	fs.writeFileSync(
		path.join(dir, 'tsconfig.json'),
		JSON.stringify({
			compilerOptions: {
				target: 'es2020',
				module: 'esnext',
				moduleResolution: 'bundler',
				strict: true,
				skipLibCheck: true,
			},
			include: ['*.ts'],
		}),
	);
	fs.writeFileSync(
		path.join(dir, 'tsslint.config.ts'),
		`import { defineConfig } from ${importPath(configModule)};\n`
			+ `export default defineConfig({\n`
			+ `  rules: {\n`
			+ `    'no-console': (await import(${importPath(noConsoleRule)})),\n`
			+ `  },\n`
			+ `});\n`,
	);
	fs.writeFileSync(path.join(dir, 'fixture.ts'), `console.log('hi');\n`);
	return dir;
}

function runCli(dir: string, ...extraArgs: string[]): { stdout: string; status: number } {
	const result = spawnSync(
		process.execPath,
		[tsslintBin, '--project', path.join(dir, 'tsconfig.json'), ...extraArgs],
		{ stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' },
	);
	return { stdout: result.stdout || '', status: result.status ?? -1 };
}

function findCacheFiles(): string[] {
	const root = path.join(os.tmpdir(), 'tsslint-cache');
	const out: string[] = [];
	const stack = [root];
	while (stack.length) {
		const cur = stack.pop()!;
		let entries: fs.Dirent[];
		try {
			entries = fs.readdirSync(cur, { withFileTypes: true });
		}
		catch {
			continue;
		}
		for (const e of entries) {
			const full = path.join(cur, e.name);
			if (e.isDirectory()) stack.push(full);
			else if (e.isFile() && full.endsWith('.cache.json')) out.push(full);
		}
	}
	return out;
}

function readCacheForFixture(fixtureDir: string): unknown {
	// Find the cache file that mentions our fixture.ts in its files map.
	const target = path.join(fixtureDir, 'fixture.ts');
	for (const f of findCacheFiles()) {
		try {
			const data = JSON.parse(fs.readFileSync(f, 'utf8'));
			if (data?.files?.[target]) return data;
		}
		catch { /* skip */ }
	}
	return null;
}

// ── Test 1: cold run produces diagnostic + writes cache ─────────────────
{
	const dir = makeFixture();
	try {
		const r = runCli(dir);
		check('cold run included no-console diagnostic', r.stdout.includes('no-console'));
		const data = readCacheForFixture(dir) as { files: any };
		check('cache file written for the fixture', !!data);
		check(
			'cache has rule entry for fixture',
			!!data?.files?.[path.join(dir, 'fixture.ts')]?.rules?.['no-console/default'],
		);
	}
	finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
}

// ── Test 2: warm run produces the same diagnostic ───────────────────────
{
	const dir = makeFixture();
	try {
		runCli(dir);
		const r2 = runCli(dir);
		check('warm run included no-console diagnostic', r2.stdout.includes('no-console'));
	}
	finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
}

// ── Test 3: editing the linted file invalidates its entry on next run ───
{
	const dir = makeFixture();
	const fixturePath = path.join(dir, 'fixture.ts');
	try {
		runCli(dir);
		const before = readCacheForFixture(dir) as any;
		const beforeMtime = before?.files?.[fixturePath]?.mtime;
		check('cold run wrote a mtime', typeof beforeMtime === 'number');

		// Edit the file. Bump mtime explicitly so coarse filesystem
		// timestamps don't cause a flaky "same mtime" hit.
		fs.writeFileSync(fixturePath, `console.warn('changed');\n`);
		const t = new Date(Date.now() + 60_000);
		fs.utimesSync(fixturePath, t, t);

		const r2 = runCli(dir);
		check('still produced diagnostic after edit', r2.stdout.includes('no-console'));
		const after = readCacheForFixture(dir) as any;
		const afterMtime = after?.files?.[fixturePath]?.mtime;
		check(
			'cache mtime moved past the edit',
			typeof afterMtime === 'number' && afterMtime > beforeMtime,
			`before=${beforeMtime}, after=${afterMtime}`,
		);
	}
	finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
}

// ── Test 4: editing tsslint.config.ts mints a fresh cache file ──────────
{
	const dir = makeFixture();
	const configPath = path.join(dir, 'tsslint.config.ts');
	try {
		runCli(dir);
		const before = readCacheForFixture(dir);
		check('cache exists after cold run', !!before);

		// Touch the config so its mtime+size change. Adding a comment is
		// enough — the cache key includes config mtime+size.
		const original = fs.readFileSync(configPath, 'utf8');
		fs.writeFileSync(configPath, `// touched\n` + original);

		const r2 = runCli(dir);
		check('still produced diagnostic with new config mtime', r2.stdout.includes('no-console'));
		// The current cache file (under new key) should have entries; the
		// old one is orphaned. Both might exist; verify the new run
		// produced a valid cache by re-reading.
		const after = readCacheForFixture(dir);
		check('new cache file written under new key', !!after);
	}
	finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
}

// ── Test 5: --force bypasses cache (still produces diagnostic) ──────────
{
	const dir = makeFixture();
	try {
		runCli(dir);
		const r2 = runCli(dir, '--force');
		check('--force run produced diagnostic', r2.stdout.includes('no-console'));
		check('--force run exits non-zero (errors/messages)', r2.status !== 0);
	}
	finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
}

// ── Test 6: programFingerprint always persisted (layer 2 default-on) ───
{
	const dir = makeFixture();
	try {
		const r = runCli(dir);
		check('default run produced diagnostic', r.stdout.includes('no-console'));
		const data = readCacheForFixture(dir) as any;
		check('cache written', !!data);
		check(
			'programFingerprint persisted to cache file',
			typeof data?.programFingerprint === 'string' && data.programFingerprint.length > 0,
		);
	}
	finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
}

// Build a fixture that exercises layer 2: a type-aware rule that touches
// `program` (classifies it type-aware via the runtime probe), writes the
// linted file's name to a marker file each time it runs, and reports a
// fixed diagnostic. The marker file's line count tells us how many times
// the rule actually executed across runs.
function makeTypeAwareFixture(): { dir: string; markerPath: string; ambient: string; fixture: string } {
	const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tsslint-int-l2-')));
	const markerPath = path.join(dir, 'marker.log');
	const rulePath = path.join(dir, 'type-aware-rule.ts');
	fs.writeFileSync(
		rulePath,
		`import { defineRule } from ${importPath(configModule)};\n`
			+ `import * as fs from 'fs';\n`
			+ `export default defineRule(({ file, checker, report }) => {\n`
			+ `  void checker;\n`
			+ `  fs.appendFileSync(${JSON.stringify(markerPath)}, file.fileName + '\\n');\n`
			+ `  report('type-aware ran', 0, 1);\n`
			+ `});\n`,
	);
	fs.writeFileSync(
		path.join(dir, 'tsconfig.json'),
		JSON.stringify({
			compilerOptions: {
				target: 'es2020',
				module: 'esnext',
				moduleResolution: 'bundler',
				strict: true,
				skipLibCheck: true,
			},
			include: ['*.ts', '*.d.ts'],
		}),
	);
	fs.writeFileSync(
		path.join(dir, 'tsslint.config.ts'),
		`import { defineConfig } from ${importPath(configModule)};\n`
			+ `export default defineConfig({\n`
			+ `  include: ['fixture.ts'],\n`
			+ `  rules: { 'type-aware': (await import(${importPath(rulePath)})) },\n`
			+ `});\n`,
	);
	const ambient = path.join(dir, 'ambient.d.ts');
	const fixture = path.join(dir, 'fixture.ts');
	fs.writeFileSync(ambient, `declare const FOO: number;\n`);
	fs.writeFileSync(fixture, `const z = FOO;\nexport {};\n`);
	return { dir, markerPath, ambient, fixture };
}

function markerLineCount(markerPath: string): number {
	if (!fs.existsSync(markerPath)) return 0;
	return fs.readFileSync(markerPath, 'utf8').split('\n').filter(Boolean).length;
}

// ── Test 7 (layer 2): warm run skips type-aware rule (cache hit) ────────
{
	const { dir, markerPath } = makeTypeAwareFixture();
	try {
		runCli(dir);
		const afterCold = markerLineCount(markerPath);
		check('cold ran rule once', afterCold === 1);

		runCli(dir);
		const afterWarm = markerLineCount(markerPath);
		check(
			'warm did NOT re-run rule (layer 2 cache hit)',
			afterWarm === 1,
			`expected 1 marker line, got ${afterWarm}`,
		);
	}
	finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
}

// ── Test 8 (layer 2): editing ambient.d.ts forces re-run on dependent ───
//
// The killer case for layer 2: ambient declaration edits don't move the
// dependent file's mtime, so layer 1 alone would silently serve stale
// type-aware results. The program fingerprint covers every file the
// program loaded, so it must catch this.
{
	const { dir, markerPath, ambient } = makeTypeAwareFixture();
	try {
		runCli(dir);
		check('cold ran rule once', markerLineCount(markerPath) === 1);

		// Mutate the ambient declaration. fixture.ts's text doesn't change.
		fs.writeFileSync(ambient, `declare const FOO: string;\n`);
		const t = new Date(Date.now() + 60_000);
		fs.utimesSync(ambient, t, t);

		runCli(dir);
		check(
			'ambient edit forced fixture.ts re-lint (layer 2 invalidation)',
			markerLineCount(markerPath) === 2,
			`expected 2 marker lines after ambient edit, got ${markerLineCount(markerPath)}`,
		);

		// And the cache should re-hit again on the next warm run.
		runCli(dir);
		check(
			'warm after ambient edit cache-hits again',
			markerLineCount(markerPath) === 2,
		);
	}
	finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
}

// ── Test 9 (--force): type-aware rule re-runs every time ────────────────
//
// `--force` is the opt-out from layer 2. It skips the cache load, so
// the linter starts cold every invocation — the type-aware rule has
// no prev state to cache-hit against and runs fresh.
{
	const { dir, markerPath } = makeTypeAwareFixture();
	try {
		runCli(dir, '--force');
		check('first --force ran rule once', markerLineCount(markerPath) === 1);

		runCli(dir, '--force');
		check(
			'second --force re-ran type-aware rule',
			markerLineCount(markerPath) === 2,
			`expected 2 marker lines, got ${markerLineCount(markerPath)} — --force should bypass layer 2`,
		);
	}
	finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
}

// A minimal tsconfig content mapper process; `transform` is the source
// of a `function transform(content)` returning the transform result.
const mapperServer = (transform: string) => `
let input = Buffer.alloc(0);
process.stdin.on('data', chunk => {
	input = Buffer.concat([input, chunk]);
	while (true) {
		const headerEnd = input.indexOf('\\r\\n\\r\\n');
		if (headerEnd < 0) return;
		const length = Number(/Content-Length:\\s*(\\d+)/i.exec(input.subarray(0, headerEnd).toString('ascii'))[1]);
		const start = headerEnd + 4;
		if (input.length < start + length) return;
		const message = JSON.parse(input.subarray(start, start + length).toString('utf8'));
		input = input.subarray(start + length);
		respond(message.id, handle(message.method, message.params));
	}
});
function handle(method, params) {
	if (method === 'initialize') return { positionEncoding: 'utf-16', diagnosticSource: 'test' };
	if (method === 'openProject') return { configIdentity: 'test' };
	if (method === 'transform') return transform(params.content);
	return null;
}
function respond(id, result) {
	const body = Buffer.from(JSON.stringify({ jsonrpc: '2.0', id, result }));
	process.stdout.write('Content-Length: ' + body.length + '\\r\\n\\r\\n');
	process.stdout.write(body);
}
${transform}
`;

// The `<script lang="ts">` body is copied verbatim (one exact segment)
// and `export {};` is appended as unmapped generated code.
const MAPPER_SERVER = mapperServer(`
function transform(content) {
	const open = '<script lang="ts">';
	const start = content.indexOf(open) + open.length;
	const body = content.slice(start, content.indexOf('</script>'));
	return { text: body + '\\nexport {};\\n', extension: '.ts', mappings: [[0, body.length, start, body.length, 0, 1048575]] };
}
`);

function writeMapperProject(dir: string, server: string) {
	const mapperDir = path.join(dir, 'node_modules', 'test-mapper');
	fs.mkdirSync(mapperDir, { recursive: true });
	fs.writeFileSync(
		path.join(mapperDir, 'package.json'),
		JSON.stringify({
			name: 'test-mapper',
			version: '1.0.0',
			typescript: { contentMapper: { exec: ['node', 'server.js'], dynamicConfig: true } },
		}),
	);
	fs.writeFileSync(path.join(mapperDir, 'server.js'), server);
	fs.writeFileSync(
		path.join(dir, 'tsconfig.json'),
		JSON.stringify({
			compilerOptions: { target: 'es2020', strict: true, skipLibCheck: true },
			contentMappers: [{ package: 'test-mapper', extensions: ['.vue'] }],
			include: ['*.vue'],
		}),
	);
}

function makeContentMapperFixture(newLine: string): { dir: string; vue: string } {
	const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tsslint-int-cm-')));
	writeMapperProject(dir, MAPPER_SERVER);
	fs.writeFileSync(
		path.join(dir, 'tsslint.config.ts'),
		`import { defineConfig, defineRule } from ${importPath(configModule)};\n`
			+ `export default defineConfig({\n`
			+ `  rules: {\n`
			+ `    'no-console': (await import(${importPath(noConsoleRule)})),\n`
			+ `    'generated': defineRule(({ file, report }) => {\n`
			+ `      const start = file.text.lastIndexOf('export {}');\n`
			+ `      report('in generated code', start, start + 9).withFix('rewrite generated code', () => [\n`
			+ `        { pos: start, end: start + 9, newText: 'void 0;' },\n`
			+ `      ]);\n`
			+ `    }),\n`
			+ `  },\n`
			+ `});\n`,
	);
	const vue = path.join(dir, 'App.vue');
	fs.writeFileSync(
		vue,
		['<template>', '  <div></div>', '</template>', '<script lang="ts">', `console.log('hi');`, '</script>', ''].join(
			newLine,
		),
	);
	return { dir, vue };
}

function stripAnsi(text: string): string {
	return text.replace(/\x1b\[[0-9;]*m/g, '');
}

// ── Test 10 (content mapper): diagnostics land on the original file ────
{
	const { dir } = makeContentMapperFixture('\n');
	try {
		const out = stripAnsi(runCli(dir).stdout);
		check('mapped diagnostic points at App.vue:5:1', out.includes('App.vue:5:1'), out);
		check('diagnostic in unmapped generated code is dropped', !out.includes('in generated code'), out);
	}
	finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
}

// ── Test 11 (content mapper): --fix edits the original text, exactly ───
//
// CRLF line endings: positions must stay in original-file coordinates.
// The fix touching generated code has no exact original span and must be
// skipped without blocking the exact one.
{
	const { dir, vue } = makeContentMapperFixture('\r\n');
	try {
		const before = fs.readFileSync(vue, 'utf8');
		runCli(dir, '--fix');
		const after = fs.readFileSync(vue, 'utf8');
		check(
			'--fix rewrote the mapped span in App.vue',
			after === before.replace(`console.log('hi')`, '/* deleted */'),
			JSON.stringify(after),
		);
		const out = stripAnsi(runCli(dir).stdout);
		check('no diagnostics after --fix', !out.includes('no-console'), out);
	}
	finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
}

// ── Test 12 (content mapper): diagnostic directives suppress reports ───
//
// Shaped like Vue's output: template expressions are appended to the
// script inside a generated function, `@vue-ignore` / `@vue-expect-error`
// become Ignore / Expect directives over the next expression, and the
// generated code between the script and the first expression is covered
// by a synthesized Ignore (no original range). `__VLS_template` maps to
// the `template` tag name with no language features, so without the
// synthesized Ignore a report on it would land on `<template>`.
{
	const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tsslint-int-cm-')));
	writeMapperProject(
		dir,
		mapperServer(`
function transform(content) {
	const open = '<script lang="ts">';
	const start = content.indexOf(open) + open.length;
	const body = content.slice(start, content.indexOf('</script>'));
	const mappings = [[0, body.length, start, body.length, 0, 1048575]];
	const directives = [];
	let text = body + '\\nexport {};\\nfunction ';
	mappings.push([text.length, 14, 1, 8, 1, 0]);
	text += '__VLS_template() {\\n';
	directives.push([0, 0, body.length, text.length, 0]);
	for (const m of content.matchAll(/(?:<!-- (@vue-ignore|@vue-expect-error) -->\\s*)?<p>\\{\\{ (.*?) \\}\\}<\\/p>/g)) {
		const exprStart = m.index + m[0].indexOf('{{ ') + 3;
		const virtualStart = text.length;
		mappings.push([virtualStart, m[2].length, exprStart, m[2].length, 0, 1048575]);
		text += m[2] + ';\\n';
		const commentLength = m[0].indexOf('-->') + 3;
		if (m[1] === '@vue-ignore') directives.push([m.index, commentLength, virtualStart, text.length, 0]);
		if (m[1] === '@vue-expect-error') directives.push([m.index, commentLength, virtualStart, text.length, 1, 0]);
	}
	text += '}\\n';
	return {
		text,
		extension: '.ts',
		mappings,
		diagnosticDirectives: { unusedExpectDirectiveDiagnostics: [{ code: 2578, messageText: 'Unused directive.' }], directives },
	};
}
`),
	);
	fs.writeFileSync(
		path.join(dir, 'tsslint.config.ts'),
		`import { defineConfig, defineRule } from ${importPath(configModule)};\n`
			+ `export default defineConfig({\n`
			+ `  rules: {\n`
			+ `    'no-console': (await import(${importPath(noConsoleRule)})),\n`
			+ `    'generated': defineRule(({ file, report }) => {\n`
			+ `      const start = file.text.indexOf('__VLS_template');\n`
			+ `      report('generated identifier', start, start + 14);\n`
			+ `    }),\n`
			+ `  },\n`
			+ `});\n`,
	);
	fs.writeFileSync(
		path.join(dir, 'App.vue'),
		[
			'<template>',
			'\t<!-- @vue-ignore -->',
			`\t<p>{{ console.log('ignored') }}</p>`,
			'\t<!-- @vue-expect-error -->',
			`\t<p>{{ console.log('expected') }}</p>`,
			`\t<p>{{ console.log('kept') }}</p>`,
			'</template>',
			'<script lang="ts">',
			`console.log('script');`,
			'</script>',
			'',
		].join('\n'),
	);
	try {
		const out = stripAnsi(runCli(dir).stdout);
		check('report outside directives is kept', out.includes('App.vue:6:8') && out.includes('App.vue:9:1'), out);
		check('@vue-ignore suppresses the report in its range', !out.includes('App.vue:3:'), out);
		check('@vue-expect-error suppresses the report in its range', !out.includes('App.vue:5:'), out);
		check('synthesized Ignore suppresses the generated-code report', !out.includes('generated identifier'), out);
		check('no unused report for directives', !/unused/i.test(out), out);
		check('exactly the two kept reports', out.includes('2 messages'), out);
	}
	finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
}

// ── Test 13 (content mapper): one fix per original range ──────────────
//
// The script body is copied twice; the second copy carries only a
// navigation feature, like Vue's navigation-only copies. The same
// insertion reported on both copies must land in App.vue once.
{
	const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tsslint-int-cm-')));
	writeMapperProject(
		dir,
		mapperServer(`
function transform(content) {
	const open = '<script lang="ts">';
	const start = content.indexOf(open) + open.length;
	const body = content.slice(start, content.indexOf('</script>'));
	return {
		text: body + '\\n' + body + '\\nexport {};\\n',
		extension: '.ts',
		mappings: [[0, body.length, start, body.length, 0, 1048575], [body.length + 1, body.length, start, body.length, 0, 8]],
	};
}
`),
	);
	fs.writeFileSync(
		path.join(dir, 'tsslint.config.ts'),
		`import { defineConfig, defineRule } from ${importPath(configModule)};\n`
			+ `export default defineConfig({\n`
			+ `  rules: {\n`
			+ `    'mark': defineRule(({ file, report }) => {\n`
			+ `      for (let i = file.text.indexOf('console'); i >= 0; i = file.text.indexOf('console', i + 1)) {\n`
			+ `        if (file.text.slice(0, i).endsWith('/* checked */ ')) continue;\n`
			+ `        report('unchecked', i, i + 7).withFix('mark', () => [\n`
			+ `          { pos: i, end: i, newText: '/* checked */ ' },\n`
			+ `        ]);\n`
			+ `      }\n`
			+ `    }),\n`
			+ `  },\n`
			+ `});\n`,
	);
	const vue = path.join(dir, 'App.vue');
	fs.writeFileSync(vue, ['<script lang="ts">', `console.log('hi');`, '</script>', ''].join('\n'));
	try {
		runCli(dir, '--fix');
		const after = fs.readFileSync(vue, 'utf8');
		check(
			'insertion from both copies applied once',
			after === ['<script lang="ts">', `/* checked */ console.log('hi');`, '</script>', ''].join('\n'),
			JSON.stringify(after),
		);
	}
	finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
}

// ── Test 14 (content mapper): compiler diagnostics are mapped once ─────
//
// `getSemanticDiagnostics` on a content-mapped file already returns
// original positions.
{
	const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tsslint-int-cm-')));
	writeMapperProject(dir, MAPPER_SERVER);
	fs.writeFileSync(
		path.join(dir, 'tsslint.config.ts'),
		`import { defineConfig, createDiagnosticsPlugin } from ${importPath(configModule)};\n`
			+ `export default defineConfig({ plugins: [createDiagnosticsPlugin('semantic')] });\n`,
	);
	fs.writeFileSync(
		path.join(dir, 'App.vue'),
		['<template>', '  <div></div>', '</template>', '<script lang="ts">', 'const s: string = 1;', '</script>', ''].join(
			'\n',
		),
	);
	try {
		const out = stripAnsi(runCli(dir).stdout);
		check(
			'compiler diagnostic points at App.vue:5:7',
			out.includes('App.vue:5:7') && out.includes(`Type 'number' is not assignable to type 'string'.`),
			out,
		);
	}
	finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
}

// ── Done ────────────────────────────────────────────────────────────────
process.stdout.write('\n');
if (failures.length) {
	console.error(`\n${failures.length} failure(s):`);
	for (const f of failures) console.error('  - ' + f);
	process.exit(1);
}
console.log('OK');
