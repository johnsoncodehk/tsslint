// Patch sync fs methods that resolvers + module loaders pound on. TSSLint is a
// one-shot CLI that walks the project tree once, so files are stable for the
// duration of a run and we can serve repeat stat / read calls from memory.
//
// Hot callers we're aiming at:
//   - eslint-plugin-import-x's `tryRequire` retries the same resolver names
//     per file, each one walking node_modules with statSync until it finds
//     (or doesn't find) the module — ~200ms cold on Vite alone.
//   - Node's CJS loader stats each candidate file path during require.
//   - tsconfig / package.json reads that don't change during the run.

import fs = require('fs');

type StatEntry = { kind: 'ok'; value: fs.Stats } | { kind: 'err'; value: NodeJS.ErrnoException };

const statCache = new Map<string, StatEntry>();
const existsCache = new Map<string, boolean>();

function pathKey(p: fs.PathLike): string {
	return typeof p === 'string' ? p : p instanceof URL ? p.href : p.toString();
}

const realStatSync = fs.statSync.bind(fs);
(fs as { statSync: typeof fs.statSync }).statSync =
	((p: fs.PathLike, options?: fs.StatSyncOptions): fs.Stats | undefined => {
		const key = pathKey(p);
		let entry = statCache.get(key);
		if (!entry) {
			try {
				entry = { kind: 'ok', value: realStatSync(p, { bigint: false }) as fs.Stats };
			}
			catch (err) {
				entry = { kind: 'err', value: err as NodeJS.ErrnoException };
			}
			statCache.set(key, entry);
		}
		if (entry.kind === 'err') {
			if (options && options.throwIfNoEntry === false) {
				return undefined;
			}
			throw entry.value;
		}
		return entry.value;
	}) as typeof fs.statSync;

const realExistsSync = fs.existsSync.bind(fs);
fs.existsSync = (p: fs.PathLike): boolean => {
	const key = pathKey(p);
	let cached = existsCache.get(key);
	if (cached === undefined) {
		cached = realExistsSync(p);
		existsCache.set(key, cached);
	}
	return cached;
};

// readFileSync is hit once per file in TSSLint's flow (TS LS / plugin readers
// already keep their own per-file cache), so wrapping it would add a wrapper
// call per read with ~0% hit rate — pure overhead. Leave it untouched.

// Invalidate cache entries when something writes to a path — TSSLint's own
// cache file gets rewritten at end of run; if a future call (in the same
// process) reads it back we want fresh data.
const realWriteFileSync = fs.writeFileSync.bind(fs);
fs.writeFileSync = ((p: fs.PathOrFileDescriptor, ...rest: any[]) => {
	if (typeof p === 'string' || p instanceof URL) {
		const key = pathKey(p);
		statCache.delete(key);
		existsCache.delete(key);
	}
	return (realWriteFileSync as any)(p, ...rest);
}) as typeof fs.writeFileSync;
