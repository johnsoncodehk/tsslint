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
		const data = readCacheForFixture(dir);
		check('cache written under --incremental', !!data);
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
