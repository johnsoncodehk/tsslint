// CLI integration tests. Spawns the local tsslint binary against a
// throwaway fixture and inspects diagnostics + cache state on disk.
// These complement the in-process cache-flow unit tests by exercising
// the actual lint loop, dependency-based invalidation, --force gate, and
// cache file load/save round-trip.
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

let mtimeOffset = 0;
// Coarse filesystem timestamps could leave an edit with the same mtime.
function bumpMtime(fileName: string) {
	const t = new Date(Date.now() + 60_000 * ++mtimeOffset);
	fs.utimesSync(fileName, t, t);
}

function editFile(fileName: string, text: string) {
	fs.writeFileSync(fileName, text);
	bumpMtime(fileName);
}

// ── Test 1: cold run produces diagnostic + writes cache ─────────────────
{
	const dir = makeFixture();
	const fixturePath = path.join(dir, 'fixture.ts');
	try {
		const r = runCli(dir);
		check('cold run included no-console diagnostic', r.stdout.includes('no-console'));
		const data = readCacheForFixture(dir) as any;
		check('cache file written for the fixture', !!data);
		check("cache has the fixture's diagnostic", data?.files?.[fixturePath]?.diagnostics?.length === 1);
		check("cache has the fixture's graph node", typeof data?.graph?.[fixturePath]?.mtime === 'number');
		check('cache has a global key', typeof data?.globalKey === 'string' && data.globalKey.length > 0);
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
		const beforeMtime = before?.graph?.[fixturePath]?.mtime;
		check('cold run wrote a mtime', typeof beforeMtime === 'number');

		fs.writeFileSync(fixturePath, `console.warn('changed');\n`);
		bumpMtime(fixturePath);

		const r2 = runCli(dir);
		check('still produced diagnostic after edit', r2.stdout.includes('no-console'));
		const after = readCacheForFixture(dir) as any;
		const afterMtime = after?.graph?.[fixturePath]?.mtime;
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

// ── Test 4: --force bypasses cache (still produces diagnostic) ──────────
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

// A project with a dependency graph:
//
//   b.ts ──▶ a.ts ◀── r.ts (re-exports a) ◀── c.ts
//   u.ts (no dependencies)
//   g.d.ts (global script), m.ts (`declare global`)
//
// The `type-of` rule reads the checker, reports the type of every
// variable, and appends the linted file's name to `marker.log` each time
// it runs.
function makeGraphFixture(options: { ignorePlugin?: boolean } = {}) {
	const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tsslint-int-graph-')));
	const markerPath = path.join(dir, 'marker.log');
	const rulePath = path.join(dir, 'type-of-rule.ts');
	fs.writeFileSync(
		rulePath,
		`import { defineRule } from ${importPath(configModule)};\n`
			+ `import * as fs from 'fs';\n`
			+ `export default defineRule(({ typescript: ts, file, checker, report }) => {\n`
			+ `  fs.appendFileSync(${JSON.stringify(markerPath)}, file.fileName + '\\n');\n`
			+ `  for (const statement of file.statements) {\n`
			+ `    if (!ts.isVariableStatement(statement)) continue;\n`
			+ `    for (const decl of statement.declarationList.declarations) {\n`
			+ `      if (!ts.isIdentifier(decl.name)) continue;\n`
			+ `      const type = checker.typeToString(checker.getTypeAtLocation(decl.name));\n`
			+ `      report(decl.name.text + ' has type ' + type, decl.name.getStart(file), decl.name.getEnd());\n`
			+ `    }\n`
			+ `  }\n`
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
			files: ['a.ts', 'b.ts', 'r.ts', 'c.ts', 'u.ts', 'g.d.ts', 'm.ts'],
		}),
	);
	fs.writeFileSync(
		path.join(dir, 'tsslint.config.ts'),
		`import { defineConfig, createIgnorePlugin } from ${importPath(configModule)};\n`
			+ `export default defineConfig({\n`
			+ `  rules: { 'type-of': (await import(${importPath(rulePath)})).default },\n`
			+ (options.ignorePlugin ? `  plugins: [createIgnorePlugin('eslint-disable-next-line', true)],\n` : '')
			+ `});\n`,
	);
	const files = {
		a: path.join(dir, 'a.ts'),
		b: path.join(dir, 'b.ts'),
		r: path.join(dir, 'r.ts'),
		c: path.join(dir, 'c.ts'),
		u: path.join(dir, 'u.ts'),
		g: path.join(dir, 'g.d.ts'),
		m: path.join(dir, 'm.ts'),
	};
	fs.writeFileSync(files.a, `export function f() {\n\treturn 1;\n}\n`);
	fs.writeFileSync(
		files.b,
		(options.ignorePlugin
			? `import { f } from './a';\n// eslint-disable-next-line type-of\n`
			: `import { f } from './a';\n`)
			+ `export const v = f();\n`,
	);
	fs.writeFileSync(files.r, `export { f } from './a';\n`);
	fs.writeFileSync(files.c, `import { f } from './r';\nexport const w = f();\n`);
	fs.writeFileSync(
		files.u,
		(options.ignorePlugin ? `// eslint-disable-next-line nope\n` : '') + `export const u = 1;\n`,
	);
	fs.writeFileSync(files.g, `declare const G: number;\n`);
	fs.writeFileSync(files.m, `export {};\ndeclare global {\n\tvar M: number;\n}\n`);
	return { dir, markerPath, files };
}

// Names of the files the rule ran on during `run`.
function lintedDuring(markerPath: string, run: () => void): string {
	const before = fs.existsSync(markerPath) ? fs.readFileSync(markerPath, 'utf8').length : 0;
	run();
	const after = fs.existsSync(markerPath) ? fs.readFileSync(markerPath, 'utf8') : '';
	return after.slice(before).split('\n').filter(Boolean).map(f => path.basename(f)).sort().join(',');
}

const ALL_GRAPH_FILES = 'a.ts,b.ts,c.ts,g.d.ts,m.ts,r.ts,u.ts';

// ── Test 5: warm run lints nothing ──────────────────────────────────────
{
	const { dir, markerPath } = makeGraphFixture();
	try {
		check('cold run lints every file', lintedDuring(markerPath, () => runCli(dir)) === ALL_GRAPH_FILES);
		let out = '';
		const linted = lintedDuring(markerPath, () => out = runCli(dir).stdout);
		check('warm run lints nothing', linted === '', linted);
		check('warm run replays type-aware results', out.includes('v has type number'), out);
	}
	finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
}

// ── Test 6: editing a function body re-lints only that file ─────────────
{
	const { dir, markerPath, files } = makeGraphFixture();
	try {
		runCli(dir);
		editFile(files.a, `export function f() {\n\treturn 2;\n}\n`);
		const linted = lintedDuring(markerPath, () => runCli(dir));
		check('body edit re-lints only a.ts', linted === 'a.ts', linted);
	}
	finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
}

// ── Test 7: changing an exported type re-lints importers transitively ──
//
// b.ts imports a.ts directly; c.ts reaches it through r.ts's re-export,
// whose own declaration text doesn't change.
{
	const { dir, markerPath, files } = makeGraphFixture();
	try {
		runCli(dir);
		editFile(files.a, `export function f() {\n\treturn 'x';\n}\n`);
		let out = '';
		const linted = lintedDuring(markerPath, () => out = runCli(dir).stdout);
		check('type change re-lints a.ts, b.ts, r.ts, c.ts', linted === 'a.ts,b.ts,c.ts,r.ts', linted);
		check('importer reports the new type', out.includes('v has type string'), out);
		check('importer through re-export reports the new type', out.includes('w has type string'), out);
		check('no stale type is reported', !/[vw] has type number/.test(out), out);

		const warm = lintedDuring(markerPath, () => out = runCli(dir).stdout);
		check('warm run after type change lints nothing', warm === '', warm);
		check('warm run replays the new types', out.includes('w has type string'), out);
	}
	finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
}

// ── Test 8: editing a global declaration re-lints everything ────────────
{
	const { dir, markerPath, files } = makeGraphFixture();
	try {
		runCli(dir);
		editFile(files.g, `declare const G: string;\n`);
		const script = lintedDuring(markerPath, () => runCli(dir));
		check('global script edit re-lints every file', script === ALL_GRAPH_FILES, script);

		editFile(files.m, `export {};\ndeclare global {\n\tvar M: string;\n}\n`);
		const augmentation = lintedDuring(markerPath, () => runCli(dir));
		check('`declare global` edit re-lints every file', augmentation === ALL_GRAPH_FILES, augmentation);
	}
	finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
}

// ── Test 9: editing a global file without changing its declarations ────
//
// A body edit leaves the declaration signature of a script or of a module
// with `declare global` / `declare module '...'` as is, so only that file
// is re-linted. A changed signature, also one that changes through an
// import, re-lints everything.
{
	const { dir, markerPath, files } = makeGraphFixture();
	const tsconfigPath = path.join(dir, 'tsconfig.json');
	const script = path.join(dir, 's.ts');
	const augmentation = (body: string, type: string) =>
		`import type { f } from './a';\n`
		+ `export function h() {\n\treturn ${body};\n}\n`
		+ `declare global {\n\tvar M: number;\n}\n`
		+ `declare module './a' {\n\tinterface Extra {\n\t\tx: ${type};\n\t\ty: ReturnType<typeof f>;\n\t}\n}\n`;
	const withScript = 'a.ts,b.ts,c.ts,g.d.ts,m.ts,r.ts,s.ts,u.ts';
	try {
		fs.writeFileSync(script, `function sf() {\n\treturn 1;\n}\n`);
		const tsconfig = JSON.parse(fs.readFileSync(tsconfigPath, 'utf8'));
		tsconfig.files.push('s.ts');
		fs.writeFileSync(tsconfigPath, JSON.stringify(tsconfig));
		fs.writeFileSync(files.m, augmentation('1', 'number'));
		runCli(dir);

		editFile(script, `function sf() {\n\treturn 2;\n}\n`);
		const scriptBody = lintedDuring(markerPath, () => runCli(dir));
		check('script body edit re-lints only s.ts', scriptBody === 's.ts', scriptBody);

		editFile(files.m, augmentation('2', 'number'));
		const augmentationBody = lintedDuring(markerPath, () => runCli(dir));
		check('augmenting module body edit re-lints only m.ts', augmentationBody === 'm.ts', augmentationBody);

		editFile(files.m, augmentation('2', 'string'));
		const augmentationType = lintedDuring(markerPath, () => runCli(dir));
		check('`declare module` type edit re-lints every file', augmentationType === withScript, augmentationType);

		editFile(script, `function sf() {\n\treturn '';\n}\n`);
		const scriptType = lintedDuring(markerPath, () => runCli(dir));
		check('script type edit re-lints every file', scriptType === withScript, scriptType);

		// m.ts's declaration text stays the same, but the type it names changes.
		editFile(files.a, `export function f() {\n\treturn 'x';\n}\n`);
		const propagated = lintedDuring(markerPath, () => runCli(dir));
		check('a type change reaching an augmentation re-lints every file', propagated === withScript, propagated);
		const warm = lintedDuring(markerPath, () => runCli(dir));
		check('warm run after it lints nothing', warm === '', warm);
	}
	finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
}

// ── Test 10: a compiler option change re-lints everything ────────────────
{
	const { dir, markerPath } = makeGraphFixture();
	const tsconfigPath = path.join(dir, 'tsconfig.json');
	try {
		runCli(dir);
		const tsconfig = JSON.parse(fs.readFileSync(tsconfigPath, 'utf8'));
		tsconfig.compilerOptions.noUnusedLocals = true;
		editFile(tsconfigPath, JSON.stringify(tsconfig));
		const linted = lintedDuring(markerPath, () => runCli(dir));
		check('compiler option change re-lints every file', linted === ALL_GRAPH_FILES, linted);
	}
	finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
}

// ── Test 11: config and rule module edits re-lint everything ────────────
//
// The rule module is only reachable through the config's import.
{
	const { dir, markerPath } = makeGraphFixture();
	const configPath = path.join(dir, 'tsslint.config.ts');
	const rulePath = path.join(dir, 'type-of-rule.ts');
	try {
		runCli(dir);
		editFile(configPath, `// touched\n` + fs.readFileSync(configPath, 'utf8'));
		const config = lintedDuring(markerPath, () => runCli(dir));
		check('config edit re-lints every file', config === ALL_GRAPH_FILES, config);

		editFile(rulePath, fs.readFileSync(rulePath, 'utf8').replace(`' has type '`, `' is typed '`));
		let out = '';
		const rule = lintedDuring(markerPath, () => out = runCli(dir).stdout);
		check('rule module edit re-lints every file', rule === ALL_GRAPH_FILES, rule);
		check('rule module edit reports the new message', out.includes('v is typed number'), out);
	}
	finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
}

// ── Test 12: ignore plugin results stay correct on warm runs ────────────
//
// b.ts's report is suppressed by a used comment; u.ts's comment targets a
// rule that never fires, so it's reported as unused.
{
	const { dir, markerPath, files } = makeGraphFixture({ ignorePlugin: true });
	try {
		const runs: string[] = [];
		runs.push(runCli(dir).stdout);
		runs.push(runCli(dir).stdout);
		editFile(files.a, `export function f() {\n\treturn 2;\n}\n`);
		const linted = lintedDuring(markerPath, () => runs.push(runCli(dir).stdout));
		check('body edit with ignore plugin re-lints only a.ts', linted === 'a.ts', linted);
		for (const [i, out] of runs.entries()) {
			const label = ['cold', 'warm', 'after body edit'][i];
			check(`${label}: suppressed report stays hidden`, !out.includes('v has type'), out);
			check(`${label}: used comment is not reported`, (out.match(/Unused comment/g) ?? []).length === 1, out);
			check(`${label}: unused comment is reported for u.ts`, /u\.ts:1:\d+/.test(stripAnsi(out)), out);
		}
	}
	finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
}

// ── Test 13: a project opened through a symlink keeps precise invalidation
//
// File names in the program then differ from the real paths on disk.
{
	const { dir, markerPath, files } = makeGraphFixture();
	const link = dir + '-link';
	fs.symlinkSync(dir, link, 'dir');
	try {
		runCli(link);
		editFile(files.a, `export function f() {\n\treturn 2;\n}\n`);
		const body = lintedDuring(markerPath, () => runCli(link));
		check('body edit through a symlink re-lints only a.ts', body === 'a.ts', body);
		editFile(files.a, `export function f() {\n\treturn 'x';\n}\n`);
		const type = lintedDuring(markerPath, () => runCli(link));
		check('type change through a symlink re-lints importers', type === 'a.ts,b.ts,c.ts,r.ts', type);
	}
	finally {
		fs.rmSync(link, { force: true });
		fs.rmSync(dir, { recursive: true, force: true });
	}
}

// ── Test 14: --force re-lints every file every time ─────────────────────
{
	const { dir, markerPath } = makeGraphFixture();
	try {
		runCli(dir);
		const linted = lintedDuring(markerPath, () => runCli(dir, '--force'));
		check('--force re-lints every file', linted === ALL_GRAPH_FILES, linted);
	}
	finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
}

// ── Test 15: a rule reading another file's function body ─────────────
//
// The `awaits` rule looks into the body of each called function; uses.ts
// and mid.ts call `load`. typed.ts reads `load`'s type alone, so a body edit
// in lib.ts must re-lint uses.ts and mid.ts but not typed.ts. top.ts reads
// mid.ts's syntax, which stays the same.
{
	const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tsslint-int-touched-')));
	const markerPath = path.join(dir, 'marker.log');
	const rulePath = path.join(dir, 'awaits-rule.ts');
	const lib = path.join(dir, 'lib.ts');
	const libText = (body: string) => `export async function load(): Promise<number> {\n${body}\treturn 1;\n}\n`;
	try {
		fs.writeFileSync(
			rulePath,
			`import { defineRule } from ${importPath(configModule)};\n`
				+ `import * as fs from 'fs';\n`
				+ `export default defineRule(({ typescript: ts, file, checker, report }) => {\n`
				+ `  fs.appendFileSync(${JSON.stringify(markerPath)}, file.fileName + '\\n');\n`
				+ `  for (const statement of file.statements) {\n`
				+ `    if (!ts.isExpressionStatement(statement) || !ts.isCallExpression(statement.expression)) continue;\n`
				+ `    const alias = checker.getSymbolAtLocation(statement.expression.expression);\n`
				+ `    const declaration = alias && checker.getAliasedSymbol(alias).valueDeclaration?.resolve();\n`
				+ `    if (declaration && /\\bawait\\b/.test(declaration.getText())) {\n`
				+ `      report('calls a function that awaits', statement.getStart(file), statement.getEnd());\n`
				+ `    }\n`
				+ `  }\n`
				+ `});\n`,
		);
		fs.writeFileSync(
			path.join(dir, 'tsslint.config.ts'),
			`import { defineConfig } from ${importPath(configModule)};\n`
				+ `export default defineConfig({\n`
				+ `  rules: { awaits: (await import(${importPath(rulePath)})).default },\n`
				+ `});\n`,
		);
		fs.writeFileSync(
			path.join(dir, 'tsconfig.json'),
			JSON.stringify({
				compilerOptions: { target: 'es2020', module: 'esnext', moduleResolution: 'bundler', strict: true },
				files: ['lib.ts', 'mid.ts', 'top.ts', 'typed.ts', 'uses.ts'],
			}),
		);
		fs.writeFileSync(lib, libText(''));
		fs.writeFileSync(path.join(dir, 'uses.ts'), `import { load } from './lib';\nload();\n`);
		fs.writeFileSync(path.join(dir, 'typed.ts'), `import { load } from './lib';\nexport const p = load;\n`);
		fs.writeFileSync(path.join(dir, 'mid.ts'), `import { load } from './lib';\nload();\nexport function run() {}\n`);
		fs.writeFileSync(path.join(dir, 'top.ts'), `import { run } from './mid';\nrun();\n`);

		let out = runCli(dir).stdout;
		check('cold: no report before the body awaits', !out.includes('calls a function that awaits'), out);

		editFile(lib, libText('\tawait 0;\n'));
		const added = lintedDuring(markerPath, () => out = runCli(dir).stdout);
		check('body edit re-lints the files reading the body', added === 'lib.ts,mid.ts,uses.ts', added);
		check('the new body is reported', out.includes('calls a function that awaits'), out);

		const warm = lintedDuring(markerPath, () => out = runCli(dir).stdout);
		check('warm run after the body edit lints nothing', warm === '', warm);
		check('warm run replays the report', out.includes('calls a function that awaits'), out);

		editFile(lib, libText(''));
		const removed = lintedDuring(markerPath, () => out = runCli(dir).stdout);
		check('reverting the body re-lints the files reading it', removed === 'lib.ts,mid.ts,uses.ts', removed);
		check('the report goes away', !out.includes('calls a function that awaits'), out);

		bumpMtime(lib);
		const touched = lintedDuring(markerPath, () => runCli(dir));
		check('an unchanged text does not re-lint the file reading it', touched === 'lib.ts', touched);
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

// ── Test 16 (content mapper): diagnostics land on the original file ────
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

// ── Test 17 (content mapper): --fix edits the original text, exactly ───
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

// ── Test 18 (content mapper): diagnostic directives suppress reports ───
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

// ── Test 19 (content mapper): one fix per original range ──────────────
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

// ── Test 20 (content mapper): compiler diagnostics are mapped once ─────
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

// ── Test 21 (content mapper): a rule crash is reported without a position
//
// The transformed text starts with generated code, so a crash placed at
// offset 0 would have no original position and be dropped.
{
	const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tsslint-int-cm-')));
	writeMapperProject(
		dir,
		mapperServer(`
function transform(content) {
	const open = '<script lang="ts">';
	const start = content.indexOf(open) + open.length;
	const body = content.slice(start, content.indexOf('</script>'));
	const prefix = 'export {};\\n';
	return { text: prefix + body, extension: '.ts', mappings: [[prefix.length, body.length, start, body.length, 0, 1048575]] };
}
`),
	);
	fs.writeFileSync(
		path.join(dir, 'tsslint.config.ts'),
		`import { defineConfig, defineRule } from ${importPath(configModule)};\n`
			+ `export default defineConfig({\n`
			+ `  rules: {\n`
			+ `    'crash': defineRule(() => { throw new Error('rule exploded'); }),\n`
			+ `  },\n`
			+ `});\n`,
	);
	fs.writeFileSync(path.join(dir, 'App.vue'), ['<script lang="ts">', 'const a = 1;', '</script>', ''].join('\n'));
	try {
		const out = stripAnsi(runCli(dir).stdout);
		check(
			'crash is reported for App.vue without a position',
			out.includes('App.vue - message crash: Error: rule exploded') && !/App\.vue:\d+:\d+/.test(out),
			out,
		);
	}
	finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
}

// ── Test 22 (content mapper): editing the mapper re-lints everything ───
//
// A cache hit shows the `--force` hint.
{
	const { dir } = makeContentMapperFixture('\n');
	const serverPath = path.join(dir, 'node_modules', 'test-mapper', 'server.js');
	try {
		runCli(dir);
		check('unchanged mapper → cache hit', runCli(dir).stdout.includes('--force'));
		editFile(serverPath, fs.readFileSync(serverPath, 'utf8') + '\n// changed\n');
		const out = runCli(dir).stdout;
		check('mapper edit → no cache hit', !out.includes('--force'), out);
		check('mapper edit still reports', out.includes('no-console'), out);
	}
	finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
}

// ── Test 23 (content mapper): mapped files compare declaration signatures
//
// Editing a function body in A.vue doesn't re-lint B.vue, which imports
// it; changing its return type does.
{
	const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tsslint-int-cm-')));
	writeMapperProject(dir, MAPPER_SERVER);
	const markerPath = path.join(dir, 'marker.log');
	fs.writeFileSync(
		path.join(dir, 'tsslint.config.ts'),
		`import { defineConfig, defineRule } from ${importPath(configModule)};\n`
			+ `import * as fs from 'fs';\n`
			+ `export default defineConfig({\n`
			+ `  rules: {\n`
			+ `    'marker': defineRule(({ file }) => {\n`
			+ `      fs.appendFileSync(${JSON.stringify(markerPath)}, file.fileName + '\\n');\n`
			+ `    }),\n`
			+ `  },\n`
			+ `});\n`,
	);
	const a = path.join(dir, 'A.vue');
	const vue = (script: string) =>
		['<template>', '  <div></div>', '</template>', '<script lang="ts">', script, '</script>', ''].join('\n');
	fs.writeFileSync(a, vue(`export function f() { return 1; }`));
	fs.writeFileSync(path.join(dir, 'B.vue'), vue(`import { f } from './A.vue';\nexport const v = f();`));
	try {
		check('cold run lints both files', lintedDuring(markerPath, () => runCli(dir)) === 'A.vue,B.vue');
		editFile(a, vue(`export function f() { return 2; }`));
		const body = lintedDuring(markerPath, () => runCli(dir));
		check('mapped body edit re-lints only A.vue', body === 'A.vue', body);
		editFile(a, vue(`export function f() { return 'x'; }`));
		const type = lintedDuring(markerPath, () => runCli(dir));
		check('mapped type change re-lints B.vue', type === 'A.vue,B.vue', type);
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
