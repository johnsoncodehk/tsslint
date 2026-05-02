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
		`import { defineConfig } from '${repoRoot}/packages/config/index.js';\n`
			+ `export default defineConfig({\n`
			+ `  rules: {\n`
			+ `    'no-console': (await import('${noConsoleRule}')),\n`
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
		try { entries = fs.readdirSync(cur, { withFileTypes: true }); }
		catch { continue; }
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

// ── Test 6: --incremental accepted, doesn't break the lint pass ─────────
{
	const dir = makeFixture();
	try {
		const r = runCli(dir, '--incremental');
		check('--incremental run produced diagnostic', r.stdout.includes('no-console'));
		const data = readCacheForFixture(dir) as any;
		check('cache written under --incremental', !!data);
		check(
			'incrementalState persisted to cache file',
			!!data?.incrementalState && Object.keys(data.incrementalState.files).length > 0,
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
	fs.writeFileSync(rulePath,
		`import { defineRule } from '${repoRoot}/packages/config/index.js';\n`
			+ `import * as fs from 'fs';\n`
			+ `export default defineRule(({ file, program, report }) => {\n`
			+ `  void program.getTypeChecker();\n`
			+ `  fs.appendFileSync(${JSON.stringify(markerPath)}, file.fileName + '\\n');\n`
			+ `  report('type-aware ran', 0, 1);\n`
			+ `});\n`,
	);
	fs.writeFileSync(path.join(dir, 'tsconfig.json'),
		JSON.stringify({
			compilerOptions: {
				target: 'es2020', module: 'esnext', moduleResolution: 'bundler',
				strict: true, skipLibCheck: true,
			},
			include: ['*.ts', '*.d.ts'],
		}),
	);
	fs.writeFileSync(path.join(dir, 'tsslint.config.ts'),
		`import { defineConfig } from '${repoRoot}/packages/config/index.js';\n`
			+ `export default defineConfig({\n`
			+ `  include: ['fixture.ts'],\n`
			+ `  rules: { 'type-aware': (await import('${rulePath}')) },\n`
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

// ── Test 7 (layer 2): --incremental skips type-aware rule on warm run ───
{
	const { dir, markerPath } = makeTypeAwareFixture();
	try {
		runCli(dir, '--incremental');
		const afterCold = markerLineCount(markerPath);
		check('cold --incremental ran rule once', afterCold === 1);

		runCli(dir, '--incremental');
		const afterWarm = markerLineCount(markerPath);
		check(
			'warm --incremental did NOT re-run rule (layer 2 cache hit)',
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
// type-aware results. The cross-session affected-file diff (content hash
// + transitive deps) must catch this.
{
	const { dir, markerPath, ambient } = makeTypeAwareFixture();
	try {
		runCli(dir, '--incremental');
		check('cold ran rule once', markerLineCount(markerPath) === 1);

		// Mutate the ambient declaration. fixture.ts's text doesn't change.
		fs.writeFileSync(ambient, `declare const FOO: string;\n`);
		const t = new Date(Date.now() + 60_000);
		fs.utimesSync(ambient, t, t);

		runCli(dir, '--incremental');
		check(
			'ambient edit forced fixture.ts re-lint (layer 2 invalidation)',
			markerLineCount(markerPath) === 2,
			`expected 2 marker lines after ambient edit, got ${markerLineCount(markerPath)}`,
		);

		// And the cache should re-hit again on the next warm run.
		runCli(dir, '--incremental');
		check(
			'warm after ambient edit cache-hits again',
			markerLineCount(markerPath) === 2,
		);
	}
	finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
}

// ── Test 9 (layer 2): without --incremental, type-aware rule always runs ─
{
	const { dir, markerPath } = makeTypeAwareFixture();
	try {
		runCli(dir);
		check('cold ran rule once (no --incremental)', markerLineCount(markerPath) === 1);

		runCli(dir);
		check(
			'warm without --incremental re-ran type-aware rule (no layer 2)',
			markerLineCount(markerPath) === 2,
			`expected 2 marker lines, got ${markerLineCount(markerPath)} — type-aware rules without layer 2 are not cached`,
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
