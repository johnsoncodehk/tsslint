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

// Override the cache root path. The module hardcodes os.tmpdir() —
// can't redirect cleanly, so just accept that test artefacts land
// alongside real cache files. Use a unique tsslint version segment via
// monkey-patching require.cache to make tests isolated.
//
// Simpler: just use unique configFile contents to force unique hashes.

function configWithMarker(marker: string): string {
	return tmpFile(`config-${marker}.ts`, `// ${marker}`);
}

// ── Test 1: empty load when file doesn't exist ───────────────────────────
{
	const tsconfig = tmpFile('tsconfig1.json', '{}');
	const config = configWithMarker('t1-' + Date.now());
	const data = cache.loadCache(tsconfig, config, [], '6.0.0');
	check('empty cache when file missing', data.files !== undefined && Object.keys(data.files).length === 0);
	check('ruleModes empty', Object.keys(data.ruleModes).length === 0);
	check('version present', typeof data.version === 'string');
}

// ── Test 2: round-trip save → load ───────────────────────────────────────
{
	const tsconfig = tmpFile('tsconfig2.json', '{}');
	const config = configWithMarker('t2-' + Date.now());
	const original: import('../lib/cache.js').CacheData = {
		version: 'v2',
		ruleModes: { 'no-undef': 'type-aware' },
		files: {
			'/abs/foo.ts': {
				mtime: 1234567890,
				rules: {
					'semi': { hasFix: false, diagnostics: [] },
				},
			},
		},
	};
	cache.saveCache(tsconfig, config, [], '6.0.0', original);
	const loaded = cache.loadCache(tsconfig, config, [], '6.0.0');
	check('round-trip: ruleModes preserved', loaded.ruleModes['no-undef'] === 'type-aware');
	check('round-trip: file mtime preserved', loaded.files['/abs/foo.ts']?.mtime === 1234567890);
	check('round-trip: rule entry preserved', !!loaded.files['/abs/foo.ts']?.rules['semi']);
}

// ── Test 3: corrupted JSON returns empty cache ───────────────────────────
{
	const tsconfig = tmpFile('tsconfig3.json', '{}');
	const config = configWithMarker('t3-' + Date.now());
	cache.saveCache(tsconfig, config, [], '6.0.0', cache.emptyCache());

	// Find the cache file and corrupt it.
	const cacheRoot = path.join(os.tmpdir(), 'tsslint-cache');
	const findCacheFile = (): string | null => {
		const stack = [cacheRoot];
		while (stack.length) {
			const dir = stack.pop()!;
			let entries: fs.Dirent[];
			try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
			catch { continue; }
			for (const e of entries) {
				const full = path.join(dir, e.name);
				if (e.isDirectory()) stack.push(full);
				else if (e.isFile() && full.endsWith('.cache.json')) {
					try {
						const content = fs.readFileSync(full, 'utf8');
						const parsed = JSON.parse(content);
						// Find the one we just wrote (heuristic: empty data).
						if (parsed.version === 'v2'
							&& Object.keys(parsed.ruleModes).length === 0
							&& Object.keys(parsed.files).length === 0) {
							return full;
						}
					}
					catch { /* ignore */ }
				}
			}
		}
		return null;
	};
	const cacheFile = findCacheFile();
	check('found newly-written cache file', !!cacheFile);
	if (cacheFile) {
		fs.writeFileSync(cacheFile, '{not valid json');
		const loaded = cache.loadCache(tsconfig, config, [], '6.0.0');
		check('corrupted JSON → empty cache', Object.keys(loaded.files).length === 0);
	}
}

// ── Test 4: version mismatch returns empty cache ─────────────────────────
{
	const tsconfig = tmpFile('tsconfig4.json', '{}');
	const config = configWithMarker('t4-' + Date.now());
	const stale = {
		version: 'v1', // wrong
		ruleModes: { 'old-rule': 'type-aware' },
		files: { '/x': { mtime: 1, rules: {} } },
	};
	// Manually write a stale-version file
	cache.saveCache(tsconfig, config, [], '6.0.0', stale as any);
	const loaded = cache.loadCache(tsconfig, config, [], '6.0.0');
	check('version mismatch → empty', Object.keys(loaded.ruleModes).length === 0);
}

// ── Test 5: shape mismatch returns empty cache ───────────────────────────
{
	const tsconfig = tmpFile('tsconfig5.json', '{}');
	const config = configWithMarker('t5-' + Date.now());
	cache.saveCache(tsconfig, config, [], '6.0.0', cache.emptyCache());
	// Corrupt to a valid-JSON-but-wrong-shape value. Find the file we
	// just wrote (heuristic: empty cache contents).
	const cacheRoot = path.join(os.tmpdir(), 'tsslint-cache');
	const all: string[] = [];
	const stack = [cacheRoot];
	while (stack.length) {
		const dir = stack.pop()!;
		let entries: fs.Dirent[];
		try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
		catch { continue; }
		for (const e of entries) {
			const full = path.join(dir, e.name);
			if (e.isDirectory()) stack.push(full);
			else if (e.isFile() && full.endsWith('.cache.json')) all.push(full);
		}
	}
	// Look for one whose content is empty cache (the one we just wrote).
	let target: string | null = null;
	for (const f of all) {
		try {
			const o = JSON.parse(fs.readFileSync(f, 'utf8'));
			if (o.version === 'v2' && Object.keys(o.files).length === 0
				&& Object.keys(o.ruleModes).length === 0) {
				// Could be from a previous test; pick first.
				target = f;
				break;
			}
		}
		catch { /* ignore */ }
	}
	if (target) {
		fs.writeFileSync(target, '"just a string"');
		const loaded = cache.loadCache(tsconfig, config, [], '6.0.0');
		check('shape mismatch → empty', Object.keys(loaded.files).length === 0);
	}
}

// ── Test 6: different ts version → different cache file ──────────────────
{
	const tsconfig = tmpFile('tsconfig6.json', '{}');
	const config = configWithMarker('t6-' + Date.now());
	const data: import('../lib/cache.js').CacheData = {
		version: 'v2',
		ruleModes: { 'rule6a': 'type-aware' },
		files: {},
	};
	cache.saveCache(tsconfig, config, [], '6.0.0', data);
	const loadedSameVersion = cache.loadCache(tsconfig, config, [], '6.0.0');
	const loadedDifferentVersion = cache.loadCache(tsconfig, config, [], '7.0.0');

	check(
		'same ts version finds the cache',
		loadedSameVersion.ruleModes['rule6a'] === 'type-aware',
	);
	check(
		'different ts version → different file → empty',
		!loadedDifferentVersion.ruleModes['rule6a'],
	);
}

// ── Test 7: editing config file changes cache file path ──────────────────
//
// configStat.mtimeMs / size is in the cache key. Mutating the config
// content + bumping mtime should land at a different cache file.
{
	const tsconfig = tmpFile('tsconfig7.json', '{}');
	const config = configWithMarker('t7-' + Date.now());

	const data: import('../lib/cache.js').CacheData = {
		version: 'v2',
		ruleModes: { 'rule7': 'type-aware' },
		files: {},
	};
	cache.saveCache(tsconfig, config, [], '6.0.0', data);

	// Bump config size + mtime.
	fs.writeFileSync(config, '// changed content');
	// Bump mtime explicitly to make sure the test isn't flaky on
	// filesystems with low mtime resolution.
	const newTime = new Date(Date.now() + 60_000);
	fs.utimesSync(config, newTime, newTime);

	const loaded = cache.loadCache(tsconfig, config, [], '6.0.0');
	check(
		'config edit invalidates cache (different path key)',
		!loaded.ruleModes['rule7'],
		'expected fresh cache after config mtime+size change',
	);
}

// ── Test 8: atomic write uses .tmp file ──────────────────────────────────
//
// Sanity: saveCache writes to <file>.tmp then renames. We can't easily
// observe the intermediate state, but we can verify no .tmp leaks
// after a successful save.
{
	const tsconfig = tmpFile('tsconfig8.json', '{}');
	const config = configWithMarker('t8-' + Date.now());
	cache.saveCache(tsconfig, config, [], '6.0.0', cache.emptyCache());

	const cacheRoot = path.join(os.tmpdir(), 'tsslint-cache');
	let tmpLeaked = false;
	const stack = [cacheRoot];
	while (stack.length) {
		const dir = stack.pop()!;
		let entries: fs.Dirent[];
		try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
		catch { continue; }
		for (const e of entries) {
			const full = path.join(dir, e.name);
			if (e.isDirectory()) stack.push(full);
			else if (e.isFile() && full.endsWith('.tmp')) tmpLeaked = true;
		}
	}
	check('no .tmp leaked after successful save', !tmpLeaked);
}

// ── Test 9: inner shape mismatch (corrupt file entry) → empty cache ─────
//
// isCacheData now validates `files[*]` entries deeply: a bad inner shape
// (mtime is a string, rules is null) must reject the whole cache instead
// of letting the load succeed and crashing later in the lint loop.
{
	const tsconfig = tmpFile('tsconfig9.json', '{}');
	const config = configWithMarker('t9-' + Date.now());
	cache.saveCache(tsconfig, config, [], '6.0.0', cache.emptyCache());
	const cacheRoot = path.join(os.tmpdir(), 'tsslint-cache');
	let target: string | null = null;
	const stack = [cacheRoot];
	while (stack.length) {
		const dir = stack.pop()!;
		let entries: fs.Dirent[];
		try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
		catch { continue; }
		for (const e of entries) {
			const full = path.join(dir, e.name);
			if (e.isDirectory()) stack.push(full);
			else if (e.isFile() && full.endsWith('.cache.json')) {
				try {
					const o = JSON.parse(fs.readFileSync(full, 'utf8'));
					if (o.version === 'v2' && Object.keys(o.files).length === 0) {
						target = full;
						break;
					}
				}
				catch { /* ignore */ }
			}
		}
		if (target) break;
	}
	if (target) {
		// mtime is a string, not a number — must reject.
		const corrupt = {
			version: 'v2',
			ruleModes: {},
			files: { '/x': { mtime: 'not-a-number', rules: {} } },
		};
		fs.writeFileSync(target, JSON.stringify(corrupt));
		const loaded = cache.loadCache(tsconfig, config, [], '6.0.0');
		check('inner mtime mismatch → empty cache', Object.keys(loaded.files).length === 0);

		// rules is null — must also reject.
		const corrupt2 = {
			version: 'v2',
			ruleModes: {},
			files: { '/x': { mtime: 1, rules: null } },
		};
		fs.writeFileSync(target, JSON.stringify(corrupt2));
		const loaded2 = cache.loadCache(tsconfig, config, [], '6.0.0');
		check('inner rules null → empty cache', Object.keys(loaded2.files).length === 0);
	}
}

// ── Test 10: incrementalState shape gate ────────────────────────────────
//
// `incrementalState` is optional, but if present must be a
// `{version, tsBuildInfoText}` object. A stray `incrementalState: 42`
// would otherwise sneak past and crash later when reconstructOldBuilder
// reads `.tsBuildInfoText`.
{
	const tsconfig = tmpFile('tsconfig10.json', '{}');
	const config = configWithMarker('t10-' + Date.now());
	cache.saveCache(tsconfig, config, [], '6.0.0', cache.emptyCache());
	const cacheRoot = path.join(os.tmpdir(), 'tsslint-cache');
	let target: string | null = null;
	const stack = [cacheRoot];
	while (stack.length) {
		const dir = stack.pop()!;
		let entries: fs.Dirent[];
		try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
		catch { continue; }
		for (const e of entries) {
			const full = path.join(dir, e.name);
			if (e.isDirectory()) stack.push(full);
			else if (e.isFile() && full.endsWith('.cache.json')) {
				try {
					const o = JSON.parse(fs.readFileSync(full, 'utf8'));
					if (o.version === 'v2' && Object.keys(o.files).length === 0) {
						target = full;
						break;
					}
				}
				catch { /* ignore */ }
			}
		}
		if (target) break;
	}
	if (target) {
		const corrupt = { version: 'v2', ruleModes: {}, files: {}, incrementalState: 42 };
		fs.writeFileSync(target, JSON.stringify(corrupt));
		const loaded = cache.loadCache(tsconfig, config, [], '6.0.0');
		check('incrementalState wrong type → empty cache', loaded.incrementalState === undefined);

		const corrupt2 = {
			version: 'v2', ruleModes: {}, files: {},
			incrementalState: { version: 'v3' /* tsBuildInfoText missing */ },
		};
		fs.writeFileSync(target, JSON.stringify(corrupt2));
		const loaded2 = cache.loadCache(tsconfig, config, [], '6.0.0');
		check('incrementalState missing field → empty cache', loaded2.incrementalState === undefined);
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
