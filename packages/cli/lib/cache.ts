// CLI cache module.
//
// Persistent JSON cache file at:
//   os.tmpdir()/tsslint-cache/<tsslint-version>/<ts-version>/<key>.cache.json
//
// Path key includes:
//   - tsslint version (segment) → bumping the package invalidates everything
//   - typescript version (segment) → checker output can change across TS
//     versions, so segregate per TS version
//   - hash of (configFilePath, tsconfig, configFile mtime+size)
//     → editing tsslint.config.ts mints a fresh cache file
//
// Cache file shape — see packages/cli/CACHE.md "Cache file format" section.
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
const CACHE_FORMAT_VERSION = 'v4';

export interface CacheData {
	version: string;
	// Sticky per-rule classification. Only "type-aware" entries are
	// stored — anything missing is treated as syntactic (or unclassified,
	// which currently means the same thing: cache write happens).
	ruleModes: Record</* ruleId */ string, 'type-aware'>;
	files: Record</* abs file path */ string, FileCache>;
	// Layer 2: fingerprint of every file in the program (path, mtime,
	// size) plus compiler options, from the session that wrote this
	// cache. Type-aware rule entries are reused only when the current
	// program's fingerprint matches. See `lib/fingerprint.ts`.
	programFingerprint?: string;
}

export interface FileCache {
	mtime: number;
	rules: Record</* ruleId */ string, RuleCache>;
}

export interface RuleCache {
	hasFix: boolean;
	diagnostics: Diagnostic[];
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
	return { version: CACHE_FORMAT_VERSION, ruleModes: {}, files: {} };
}

// Deep shape check. A corrupt `files` entry (wrong `mtime` type, missing
// `rules` map) would otherwise pass the gate and crash the lint loop
// later with a confusing TypeError. Cost of a single full traversal at
// load time is negligible against the cost of a mid-lint crash.
function isCacheData(x: unknown): x is CacheData {
	if (typeof x !== 'object' || x === null) return false;
	const o = x as Record<string, unknown>;
	if (typeof o.version !== 'string') return false;
	if (typeof o.ruleModes !== 'object' || o.ruleModes === null) return false;
	if (typeof o.files !== 'object' || o.files === null) return false;
	for (const v of Object.values(o.files as Record<string, unknown>)) {
		if (typeof v !== 'object' || v === null) return false;
		const f = v as Record<string, unknown>;
		if (typeof f.mtime !== 'number') return false;
		if (typeof f.rules !== 'object' || f.rules === null) return false;
	}
	if (o.programFingerprint !== undefined && typeof o.programFingerprint !== 'string') return false;
	return true;
}

function getCacheFilePath(
	tsconfig: string,
	configFilePath: string,
	tsVersion: string,
	createHash: (s: string) => string,
): string {
	const configStat = fs.statSync(configFilePath, { throwIfNoEntry: false });
	const cacheKey = [
		configFilePath,
		tsconfig,
		configStat?.mtimeMs ?? 0,
		configStat?.size ?? 0,
	].join('\0');
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
