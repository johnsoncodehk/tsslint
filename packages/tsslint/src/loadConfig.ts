import type { Config } from './types';
import path = require('path');
import esbuild = require('/Users/johnsonchu/Desktop/GitHub/tsslint/node_modules/.pnpm/esbuild@0.19.9/node_modules/esbuild/lib/main.js');

export interface LoadConfigResult {
	configFile: string;
	config: Config | undefined;
	errors: esbuild.Message[];
	warnings: esbuild.Message[];
}

export async function watchConfig(
	dir: string,
	onBuild: (result: LoadConfigResult) => void,
) {
	const dirs = [dir];
	let upDir: string;
	while ((upDir = path.resolve(dir, '..')) !== dirs[dirs.length - 1]) {
		dirs.push(upDir);
		dir = upDir;
	}

	for (const dir of dirs) {
		if (await tryLoadTSConfig([dir])) {
			break;
		}
	}

	async function tryLoadTSConfig(paths: string[]) {
		let tsConfigPath: string | undefined;
		try {
			tsConfigPath = require.resolve('./tsslint.config.ts', { paths });
		} catch { }

		if (tsConfigPath) {
			const jsConfigPath = tsConfigPath.slice(0, -'.ts'.length) + '.js';
			const ctx = await esbuild.context({
				entryPoints: [tsConfigPath],
				bundle: true,
				outfile: jsConfigPath,
				format: 'cjs',
				platform: 'node',
				// use build callback
				plugins: [{
					name: 'tsslint',
					setup(build) {
						build.onEnd(result => {
							let config: Config | undefined;
							if (!result.errors.length) {
								delete require.cache[jsConfigPath!];
								config = require(jsConfigPath).default;
							}
							onBuild({
								configFile: tsConfigPath!,
								config: config,
								errors: result.errors,
								warnings: result.warnings,
							});
						});
					},
				}],
			});
			await ctx.watch();
			return true;
		}

		return false;
	}
}
