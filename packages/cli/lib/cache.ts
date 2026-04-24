import core = require('@tsslint/core');
import path = require('path');
import fs = require('fs');
import os = require('os');

export type CacheData = Record<string, /* fileName */ core.FileLintCache>;

const pkg = require('../package.json');

export function loadCache(
	tsconfig: string,
	configFilePath: string,
	languages: string[],
	createHash: (path: string) => string = btoa,
): CacheData {
	const cacheFilePath = getCacheFilePath(tsconfig, configFilePath, languages, createHash);
	if (fs.statSync(cacheFilePath, { throwIfNoEntry: false })?.isFile()) {
		try {
			return JSON.parse(fs.readFileSync(cacheFilePath, 'utf8'));
		}
		catch {}
	}
	return {};
}

export function saveCache(
	tsconfig: string,
	configFilePath: string,
	languages: string[],
	cache: CacheData,
	createHash: (path: string) => string = btoa,
): void {
	const cacheFilePath = getCacheFilePath(tsconfig, configFilePath, languages, createHash);
	fs.mkdirSync(path.dirname(cacheFilePath), { recursive: true });
	fs.writeFileSync(cacheFilePath, JSON.stringify(cache));
}

function getCacheFilePath(
	tsconfig: string,
	configFilePath: string,
	languages: string[],
	createHash: (path: string) => string,
): string {
	const configStat = fs.statSync(configFilePath, { throwIfNoEntry: false });
	const cacheKey = [
		configFilePath,
		tsconfig,
		languages.sort().join(','),
		configStat?.mtimeMs ?? 0,
		configStat?.size ?? 0,
	].join('\0');
	return path.join(getTsslintCachePath(), createHash(cacheKey) + '.cache.json');
}

function getTsslintCachePath(): string {
	return path.join(os.tmpdir(), 'tsslint-cache', pkg.version);
}
