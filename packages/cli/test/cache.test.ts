// Tests for the cache load/save module.
//
// Pure data-layer tests — no linter, no language service. Verifies:
//   - round-trip save → load preserves shape
//   - missing / corrupted / shape-mismatched files return empty cache
//   - cache file path key segregates by tsslint+ts version + config
//
// Run via:
//   node packages/cli/test/cache.test.js

import path = require('path');
import fs = require('fs');
import os = require('os');
import type { CacheData } from '../lib/cache.js';

const cache = require('../lib/cache.js') as typeof import('../lib/cache.js');

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

// Make a unique temp dir per test invocation so concurrent runs don't
// collide (and so we don't pollute prior tsslint-cache dirs).
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tsslint-cache-test-'));
function tmpFile(name: string, content = ''): string {
	const p = path.join(tmp, name);
	fs.writeFileSync(p, content);
	return p;
}

// The module hardcodes os.tmpdir(), so test artefacts land alongside real
// cache files. Unique config paths force unique hashes.
function configWithMarker(marker: string): string {
	return tmpFile(`config-${marker}.ts`, `// ${marker}`);
}

function withMarker(marker: string, data: Partial<CacheData> = {}): CacheData {
	return { ...cache.emptyCache(), globalKey: marker, ...data };
}

// Finds the cache file saved with `withMarker(marker)`.
function findCacheFile(marker: string): string | undefined {
	const stack = [path.join(os.tmpdir(), 'tsslint-cache')];
	while (stack.length) {
		const dir = stack.pop()!;
		let entries: fs.Dirent[];
		try {
			entries = fs.readdirSync(dir, { withFileTypes: true });
		}
		catch {
			continue;
		}
		for (const e of entries) {
			const full = path.join(dir, e.name);
			if (e.isDirectory()) {
				stack.push(full);
			}
			else if (e.isFile() && full.endsWith('.cache.json')) {
				try {
					if (JSON.parse(fs.readFileSync(full, 'utf8')).globalKey === marker) {
						return full;
					}
				}
				catch { /* ignore */ }
			}
		}
	}
}

// ── Test 1: empty load when file doesn't exist ───────────────────────────
{
	const tsconfig = tmpFile('tsconfig1.json', '{}');
	const config = configWithMarker('t1-' + Date.now());
	const data = cache.loadCache(tsconfig, config, '6.0.0');
	check('empty cache when file missing', data.files !== undefined && Object.keys(data.files).length === 0);
	check('graph empty', Object.keys(data.graph).length === 0);
	check('globalKey absent', data.globalKey === undefined);
	check('version present', typeof data.version === 'string');
}

// ── Test 2: round-trip save → load ───────────────────────────────────────
{
	const tsconfig = tmpFile('tsconfig2.json', '{}');
	const marker = 't2-' + Date.now();
	const config = configWithMarker(marker);
	const original = withMarker(marker, {
		graph: {
			'/abs/foo.ts': { mtime: 1234567890, size: 10, signature: 'sig', deps: ['/abs/bar.ts'], global: false },
		},
		files: {
			'/abs/foo.ts': { hasFix: true, diagnostics: [], touched: { '/abs/baz.ts': 'hash' } },
		},
	});
	cache.saveCache(tsconfig, config, '6.0.0', original);
	const loaded = cache.loadCache(tsconfig, config, '6.0.0');
	check('round-trip: globalKey preserved', loaded.globalKey === marker);
	check('round-trip: graph mtime preserved', loaded.graph['/abs/foo.ts']?.mtime === 1234567890);
	check('round-trip: signature preserved', loaded.graph['/abs/foo.ts']?.signature === 'sig');
	check('round-trip: deps preserved', loaded.graph['/abs/foo.ts']?.deps[0] === '/abs/bar.ts');
	check('round-trip: file entry preserved', loaded.files['/abs/foo.ts']?.hasFix === true);
	check('round-trip: touched files preserved', loaded.files['/abs/foo.ts']?.touched['/abs/baz.ts'] === 'hash');
}

// ── Test 3: corrupted JSON returns empty cache ───────────────────────────
{
	const tsconfig = tmpFile('tsconfig3.json', '{}');
	const marker = 't3-' + Date.now();
	const config = configWithMarker(marker);
	cache.saveCache(tsconfig, config, '6.0.0', withMarker(marker));
	const cacheFile = findCacheFile(marker);
	check('found newly-written cache file', !!cacheFile);
	if (cacheFile) {
		fs.writeFileSync(cacheFile, '{not valid json');
		const loaded = cache.loadCache(tsconfig, config, '6.0.0');
		check('corrupted JSON → empty cache', loaded.globalKey === undefined);
	}
}

// ── Test 4: version mismatch returns empty cache ─────────────────────────
{
	const tsconfig = tmpFile('tsconfig4.json', '{}');
	const marker = 't4-' + Date.now();
	const config = configWithMarker(marker);
	cache.saveCache(tsconfig, config, '6.0.0', withMarker(marker, { version: 'v4' }));
	const loaded = cache.loadCache(tsconfig, config, '6.0.0');
	check('version mismatch → empty', loaded.globalKey === undefined);
}

// ── Test 5: shape mismatch returns empty cache ───────────────────────────
{
	const tsconfig = tmpFile('tsconfig5.json', '{}');
	const marker = 't5-' + Date.now();
	const config = configWithMarker(marker);
	cache.saveCache(tsconfig, config, '6.0.0', withMarker(marker));
	const target = findCacheFile(marker);
	check('test 5 cache file found', !!target);
	if (target) {
		fs.writeFileSync(target, '"just a string"');
		const loaded = cache.loadCache(tsconfig, config, '6.0.0');
		check('shape mismatch → empty', loaded.globalKey === undefined);
	}
}

// ── Test 6: different ts version → different cache file ──────────────────
{
	const tsconfig = tmpFile('tsconfig6.json', '{}');
	const marker = 't6-' + Date.now();
	const config = configWithMarker(marker);
	cache.saveCache(tsconfig, config, '6.0.0', withMarker(marker));
	const loadedSameVersion = cache.loadCache(tsconfig, config, '6.0.0');
	const loadedDifferentVersion = cache.loadCache(tsconfig, config, '7.0.0');

	check('same ts version finds the cache', loadedSameVersion.globalKey === marker);
	check('different ts version → different file → empty', loadedDifferentVersion.globalKey === undefined);
}

// ── Test 7: editing the config file keeps the cache file ─────────────────
//
// The config and the modules it loads are part of `globalKey`, which
// re-lints every file when it changes; the path only depends on which
// config and tsconfig the cache belongs to.
{
	const tsconfig = tmpFile('tsconfig7.json', '{}');
	const marker = 't7-' + Date.now();
	const config = configWithMarker(marker);
	cache.saveCache(tsconfig, config, '6.0.0', withMarker(marker));

	fs.writeFileSync(config, '// changed content');
	const newTime = new Date(Date.now() + 60_000);
	fs.utimesSync(config, newTime, newTime);

	const loaded = cache.loadCache(tsconfig, config, '6.0.0');
	check('config edit keeps the cache path', loaded.globalKey === marker);
	check('different tsconfig → different file', cache.loadCache(config, tsconfig, '6.0.0').globalKey === undefined);
}

// ── Test 8: atomic write uses .tmp file ──────────────────────────────────
//
// Sanity: saveCache writes to <file>.tmp then renames. We can't easily
// observe the intermediate state, but we can verify no .tmp leaks
// after a successful save.
{
	const tsconfig = tmpFile('tsconfig8.json', '{}');
	const marker = 't8-' + Date.now();
	const config = configWithMarker(marker);
	cache.saveCache(tsconfig, config, '6.0.0', withMarker(marker));
	const target = findCacheFile(marker);
	check('test 8 cache file found', !!target);
	check('no .tmp leaked after successful save', !!target && !fs.existsSync(target + '.tmp'));
}

// ── Test 9: inner shape mismatch → empty cache ──────────────────────────
//
// isCacheData validates graph and file entries deeply: a bad inner shape
// must reject the whole cache instead of letting the load succeed and
// crashing later in the lint loop.
{
	const tsconfig = tmpFile('tsconfig9.json', '{}');
	const marker = 't9-' + Date.now();
	const config = configWithMarker(marker);
	cache.saveCache(tsconfig, config, '6.0.0', withMarker(marker));
	const target = findCacheFile(marker);
	check('test 9 cache file found', !!target);
	if (target) {
		const base = withMarker(marker);
		const cases: [string, unknown][] = [
			['graph mtime not a number', {
				...base,
				graph: { '/x': { mtime: 'nope', size: 1, deps: [], global: false } },
			}],
			['graph deps not an array', { ...base, graph: { '/x': { mtime: 1, size: 1, deps: null, global: false } } }],
			['file diagnostics not an array', {
				...base,
				files: { '/x': { hasFix: false, diagnostics: null, touched: {} } },
			}],
			['file hasFix missing', { ...base, files: { '/x': { diagnostics: [], touched: {} } } }],
			['file touched missing', { ...base, files: { '/x': { hasFix: false, diagnostics: [] } } }],
		];
		for (const [label, corrupt] of cases) {
			fs.writeFileSync(target, JSON.stringify(corrupt));
			const loaded = cache.loadCache(tsconfig, config, '6.0.0');
			check(`${label} → empty cache`, loaded.globalKey === undefined);
		}
	}
}

// ── Test 10: globalKey shape gate ───────────────────────────────────────
//
// `globalKey` is optional, but if present must be a string. A stray
// `globalKey: 42` must not be compared against a real key as if it were
// one.
{
	const tsconfig = tmpFile('tsconfig10.json', '{}');
	const marker = 't10-' + Date.now();
	const config = configWithMarker(marker);
	cache.saveCache(tsconfig, config, '6.0.0', withMarker(marker));
	const target = findCacheFile(marker);
	check('test 10 cache file found', !!target);
	if (target) {
		fs.writeFileSync(target, JSON.stringify({ ...cache.emptyCache(), globalKey: 42 }));
		const loaded = cache.loadCache(tsconfig, config, '6.0.0');
		check('globalKey wrong type → empty cache', loaded.globalKey === undefined);

		fs.writeFileSync(target, JSON.stringify({ ...cache.emptyCache(), globalKey: 'abc' }));
		const loaded2 = cache.loadCache(tsconfig, config, '6.0.0');
		check('globalKey string round-trips', loaded2.globalKey === 'abc');
	}
}

// ── Cleanup ─────────────────────────────────────────────────────────────
fs.rmSync(tmp, { recursive: true, force: true });

process.stdout.write('\n');
if (failures.length) {
	console.error(`\n${failures.length} failure(s):`);
	for (const f of failures) console.error('  - ' + f);
	process.exit(1);
}
console.log('OK');
