// CLI cache module.
//
// Persistent JSON cache file at:
//   os.tmpdir()/tsslint-cache/<tsslint-version>/<ts-version>/<key>.cache.json
//
// Path key includes:
//   - tsslint version (segment) → bumping the package invalidates everything
//   - typescript version (segment) → .tsbuildinfo format / TS internals can
//     change across TS majors, so segregate per TS version
//   - hash of (configFilePath, tsconfig, languages, configFile mtime+size)
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

import type * as ts from 'typescript';
import type { IncrementalState } from './incremental-state.js';

const pkg = require('../package.json');

// Bump when the on-disk shape changes incompatibly. Mismatching version
// returns an empty cache; we don't migrate (cold start is the safe default).
const CACHE_FORMAT_VERSION = 'v2';

export interface CacheData {
	version: string;
	// Sticky per-rule classification. Only "type-aware" entries are
	// stored — anything missing is treated as syntactic (or unclassified,
	// which currently means the same thing: cache write happens).
	ruleModes: Record</* ruleId */ string, 'type-aware'>;
	files: Record</* abs file path */ string, FileCache>;
	// Layer 2 cross-session state. Present iff the previous session ran
	// with `--incremental`. Lets the next session compute which files'
	// type-relevant inputs (incl. ambient `.d.ts`) have changed since.
	// See `lib/incremental-state.ts`. Optional so layer-1-only sessions
	// stay schema-clean.
	incrementalState?: IncrementalState;
}

export interface FileCache {
	mtime: number;
	rules: Record</* ruleId */ string, RuleCache>;
}

export interface RuleCache {
	hasFix: boolean;
	diagnostics: SerializedDiagnostic[];
}

// `ts.DiagnosticWithLocation` minus the live `file` reference — that gets
// re-attached on load by looking up the SourceFile from the current Program.
// `relatedInformation` similarly stores `{ fileName }` placeholders.
export type SerializedDiagnostic = Omit<ts.DiagnosticWithLocation, 'file' | 'relatedInformation'> & {
	relatedInformation?: SerializedRelatedInfo[];
};

export type SerializedRelatedInfo = Omit<ts.DiagnosticRelatedInformation, 'file'> & {
	file?: { fileName: string };
};

export function loadCache(
	tsconfig: string,
	configFilePath: string,
	languages: string[],
	tsVersion: string,
	createHash: (s: string) => string = defaultHash,
): CacheData {
	const filePath = getCacheFilePath(tsconfig, configFilePath, languages, tsVersion, createHash);
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
	languages: string[],
	tsVersion: string,
	cache: CacheData,
	createHash: (s: string) => string = defaultHash,
): void {
	const filePath = getCacheFilePath(tsconfig, configFilePath, languages, tsVersion, createHash);
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

function isCacheData(x: unknown): x is CacheData {
	if (typeof x !== 'object' || x === null) return false;
	const o = x as Record<string, unknown>;
	return typeof o.version === 'string'
		&& typeof o.ruleModes === 'object' && o.ruleModes !== null
		&& typeof o.files === 'object' && o.files !== null;
}

function getCacheFilePath(
	tsconfig: string,
	configFilePath: string,
	languages: string[],
	tsVersion: string,
	createHash: (s: string) => string,
): string {
	const configStat = fs.statSync(configFilePath, { throwIfNoEntry: false });
	const cacheKey = [
		configFilePath,
		tsconfig,
		languages.sort().join(','),
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
