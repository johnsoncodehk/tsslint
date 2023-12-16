import type { Config } from './types';
import path = require('path');
import esbuild = require('/Users/johnsonchu/Desktop/GitHub/tsslint/node_modules/.pnpm/esbuild@0.19.9/node_modules/esbuild/lib/main.js');

export interface LoadConfigResult {
	config: Config | undefined;
	errors: esbuild.Message[];
	warnings: esbuild.Message[];
}

export function findConfigFile(dir: string) {
	const dirs = [dir];
	let upDir: string;

	while ((upDir = path.resolve(dir, '..')) !== dirs[dirs.length - 1]) {
		dirs.push(upDir);
		dir = upDir;
	}

	for (const dir of dirs) {
		try {
			return require.resolve('./tsslint.config.ts', { paths: [dir] });
		} catch { }
	}
}

export async function watchConfig(
	tsConfigPath: string,
	onBuild: (result: LoadConfigResult) => void,
) {
	const jsConfigPath = tsConfigPath.slice(0, -'.ts'.length) + '.cjs';
	const ctx = await esbuild.context({
		entryPoints: [tsConfigPath],
		bundle: true,
		outfile: jsConfigPath,
		format: 'cjs',
		platform: 'node',
		plugins: [{
			name: 'tsslint',
			setup(build) {
				build.onEnd(result => {
					let config: Config | undefined;
					if (!result.errors.length) {
						delete require.cache[jsConfigPath!];
						try {
							config = require(jsConfigPath).default;
						} catch (e) {
							result.errors.push({ text: String(e) } as any);
						}
					}
					onBuild({
						config: config,
						errors: result.errors,
						warnings: result.warnings,
					});
				});
			},
		}],
	});
	await ctx.watch();
	return ctx;
}
