import core = require('@tsslint/core');
import path = require('path');
import fs = require('fs');

export type CacheData = Record<string /* fileName */, core.FileLintCache>;

export function loadCache(
	tsconfig: string,
	configFilePath: string,
	createHash: (path: string) => string = btoa
): CacheData {
	const outDir = getDotTsslintPath(configFilePath);
	const cacheFileName = createHash(path.relative(outDir, configFilePath)) + '_' + createHash(JSON.stringify(process.argv)) + '_' + createHash(path.relative(outDir, tsconfig)) + '.cache.json';
	const cacheFilePath = path.join(outDir, cacheFileName);
	const cacheFileStat = fs.statSync(cacheFilePath, { throwIfNoEntry: false });
	const configFileStat = fs.statSync(configFilePath, { throwIfNoEntry: false });
	if (cacheFileStat?.isFile() && cacheFileStat.mtimeMs > (configFileStat?.mtimeMs ?? 0)) {
		try {
			return require(cacheFilePath);
		} catch {
			return {};
		}
	}
	return {};
}

export function saveCache(
	tsconfig: string,
	configFilePath: string,
	cache: CacheData,
	createHash: (path: string) => string = btoa
): void {
	const outDir = getDotTsslintPath(configFilePath);
	const cacheFileName = createHash(path.relative(outDir, configFilePath)) + '_' + createHash(JSON.stringify(process.argv)) + '_' + createHash(path.relative(outDir, tsconfig)) + '.cache.json';
	const cacheFilePath = path.join(outDir, cacheFileName);
	fs.mkdirSync(outDir, { recursive: true });
	fs.writeFileSync(cacheFilePath, JSON.stringify(cache));
}

function getDotTsslintPath(configFilePath: string): string {
	return path.resolve(configFilePath, '..', 'node_modules', '.tsslint');
}
