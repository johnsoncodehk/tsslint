import type { Config } from './types';
import path = require('path');

export async function loadConfig(dir = process.cwd()) {

	const dirs = [dir];

	let upDir: string;

	while ((upDir = path.resolve(dir, '..')) !== dirs[dirs.length - 1]) {
		dirs.push(upDir);
		dir = upDir;
	}

	for (const dir of dirs) {
		const config = await tryLoadConfig([dir], '.mjs')
			?? await tryLoadConfig([dir], '.js')
			?? await tryLoadConfig([dir], '.cjs');
		if (config) {
			return config;
		}
	}
}

async function tryLoadConfig(paths: string[], ext: string) {
	try {
		const configPath = require.resolve('./tsslint.config' + ext, { paths });
		const config: Config = (await import(configPath)).default;
		return config;
	} catch { }
}
