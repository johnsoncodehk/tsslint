import core = require('@tsslint/core');
import path = require('path');
import fs = require('fs');
import type * as ts from 'typescript';

export type CacheData = Record<string /* fileName */, [
	fileMtime: number,
	ruleIds: string[],
	result: ts.DiagnosticWithLocation[],
	resolvedResult: ts.DiagnosticWithLocation[],
	minimatchResult: Record<string, boolean>,
]>;

export function loadCache(
	configFilePath: string,
	createHash: (path: string) => string = btoa
): CacheData {
	const outDir = core.getDotTsslintPath(configFilePath);
	const cacheFileName = createHash(path.relative(outDir, configFilePath)) + '.cache.json';
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
	configFilePath: string,
	cache: CacheData,
	createHash: (path: string) => string = btoa
): void {
	const outDir = core.getDotTsslintPath(configFilePath);
	const cacheFileName = createHash(path.relative(outDir, configFilePath)) + '.cache.json';
	const cacheFilePath = path.join(outDir, cacheFileName);
	fs.writeFileSync(cacheFilePath, JSON.stringify(cache));
}
