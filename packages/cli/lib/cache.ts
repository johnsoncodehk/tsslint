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
	const outDir = getTsslintCachePath();
	const cacheKey = configFilePath + '\0' + tsconfig + '\0' + languages.sort().join(',');
	const cacheFileName = createHash(cacheKey) + '.cache.json';
	const cacheFilePath = path.join(outDir, cacheFileName);
	const cacheFileStat = fs.statSync(cacheFilePath, { throwIfNoEntry: false });
	const configFileStat = fs.statSync(configFilePath, { throwIfNoEntry: false });
	if (cacheFileStat?.isFile() && cacheFileStat.mtimeMs > (configFileStat?.mtimeMs ?? 0)) {
		try {
			return JSON.parse(fs.readFileSync(cacheFilePath, 'utf8'));
		}
		catch {
			return {};
		}
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
	const outDir = getTsslintCachePath();
	const cacheKey = configFilePath + '\0' + tsconfig + '\0' + languages.sort().join(',');
	const cacheFileName = createHash(cacheKey) + '.cache.json';
	const cacheFilePath = path.join(outDir, cacheFileName);
	fs.mkdirSync(outDir, { recursive: true });
	fs.writeFileSync(cacheFilePath, JSON.stringify(cache));
}

function getTsslintCachePath(): string {
	return path.join(os.tmpdir(), 'tsslint-cache', pkg.version);
}
