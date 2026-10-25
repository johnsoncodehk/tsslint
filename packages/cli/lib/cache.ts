// CLI cache module.
//
// Persistent JSON cache file at:
//   os.tmpdir()/tsslint-cache/<tsslint-version>/<ts-version>/<key>.cache.json
//
// Path key includes:
//   - tsslint version (segment) → bumping the package invalidates everything
//   - typescript version (segment) → checker output can change across TS
//     versions, so segregate per TS version
//   - hash of (configFilePath, tsconfig)
//
// Everything else that can invalidate results (compiler options, config
// and rule modules, content mappers, files in the program) is checked
// through `globalKey` and the dependency graph; see `lib/invalidation.ts`.
//
// Soundness invariants the loader enforces:
//   - any parse / shape / version mismatch returns an empty cache (treated
//     as cold start). Wrong cache hit corrupts a code-review tool; wrong
//     miss costs a re-run. Bias hard.
//   - atomic write via temp file + rename. SIGINT during write can leave
//     a stray .tmp but the canonical file stays intact.

import path = require('path');
import fs = require('fs');
import os = require('os');
import crypto = require('crypto');

import type { Diagnostic } from '@tsslint/types';

const pkg = require('../package.json');

// Bump when the on-disk shape changes incompatibly. Mismatching version
// returns an empty cache; we don't migrate (cold start is the safe default).
const CACHE_FORMAT_VERSION = 'v6';

export interface CacheData {
	version: string;
	// Hash of every input whose change re-lints all files.
	globalKey?: string;
	// Every program file outside `node_modules`.
	graph: Record</* abs file path */ string, GraphNode>;
	// Lint results that are still valid, by linted file.
	files: Record</* abs file path */ string, FileCache>;
}

export interface GraphNode {
	mtime: number;
	size: number;
	// Hash of the file's declaration emit, or of its text when there is
	// none. Only kept for files that other files depend on, and for global
	// files.
	signature?: string;
	// Program files outside `node_modules` this file imports or references.
	deps: string[];
	// Declares globals or augments modules, so a signature change can affect
	// any file.
	global: boolean;
}

// Diagnostics after plugins ran, as the CLI reports them.
export interface FileCache {
	hasFix: boolean;
	diagnostics: Diagnostic[];
	// Hash of the text of each other program file the rules read beyond its
	// declarations (see `getTouchedFiles` in @tsslint/core).
	touched: Record</* abs file path */ string, string>;
}

export function loadCache(
	tsconfig: string,
	configFilePath: string,
	tsVersion: string,
	createHash: (s: string) => string = defaultHash,
): CacheData {
	const filePath = getCacheFilePath(tsconfig, configFilePath, tsVersion, createHash);
	if (!fs.statSync(filePath, { throwIfNoEntry: false })?.isFile()) {
		return emptyCache();
	}
	let raw: string;
	try {
		raw = fs.readFileSync(filePath, 'utf8');
	}
	catch {
		return emptyCache();
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	}
	catch {
		return emptyCache();
	}
	if (!isCacheData(parsed)) {
		return emptyCache();
	}
	if (parsed.version !== CACHE_FORMAT_VERSION) {
		return emptyCache();
	}
	return parsed;
}

export function saveCache(
	tsconfig: string,
	configFilePath: string,
	tsVersion: string,
	cache: CacheData,
	createHash: (s: string) => string = defaultHash,
): void {
	const filePath = getCacheFilePath(tsconfig, configFilePath, tsVersion, createHash);
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	const tmpPath = filePath + '.tmp';
	fs.writeFileSync(tmpPath, JSON.stringify(cache));
	// `fs.renameSync` calls `MoveFileEx` on Windows (replaces existing) and
	// `rename(2)` on POSIX (atomic same-fs replacement). If a process is
	// killed between writeFileSync and renameSync, the canonical cache file
	// is untouched and only the .tmp leaks.
	fs.renameSync(tmpPath, filePath);
}

export function emptyCache(): CacheData {
	return { version: CACHE_FORMAT_VERSION, graph: {}, files: {} };
}

// Deep shape check. A corrupt `files` entry (wrong `mtime` type, missing
// `rules` map) would otherwise pass the gate and crash the lint loop
// later with a confusing TypeError. Cost of a single full traversal at
// load time is negligible against the cost of a mid-lint crash.
function isCacheData(x: unknown): x is CacheData {
	if (typeof x !== 'object' || x === null) return false;
	const o = x as Record<string, unknown>;
	if (typeof o.version !== 'string') return false;
	if (o.globalKey !== undefined && typeof o.globalKey !== 'string') return false;
	if (typeof o.graph !== 'object' || o.graph === null) return false;
	for (const v of Object.values(o.graph as Record<string, unknown>)) {
		if (typeof v !== 'object' || v === null) return false;
		const n = v as Record<string, unknown>;
		if (typeof n.mtime !== 'number' || typeof n.size !== 'number') return false;
		if (!Array.isArray(n.deps) || typeof n.global !== 'boolean') return false;
	}
	if (typeof o.files !== 'object' || o.files === null) return false;
	for (const v of Object.values(o.files as Record<string, unknown>)) {
		if (typeof v !== 'object' || v === null) return false;
		const f = v as Record<string, unknown>;
		if (typeof f.hasFix !== 'boolean' || !Array.isArray(f.diagnostics)) return false;
		if (typeof f.touched !== 'object' || f.touched === null) return false;
	}
	return true;
}

function getCacheFilePath(
	tsconfig: string,
	configFilePath: string,
	tsVersion: string,
	createHash: (s: string) => string,
): string {
	const cacheKey = [configFilePath, tsconfig].join('\0');
	return path.join(
		getTsslintCachePath(),
		tsVersion,
		createHash(cacheKey) + '.cache.json',
	);
}

function getTsslintCachePath(): string {
	return path.join(os.tmpdir(), 'tsslint-cache', pkg.version);
}

function defaultHash(s: string): string {
	return crypto.createHash('sha256').update(s).digest('hex');
}
