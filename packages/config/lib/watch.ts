import esbuild = require('esbuild');
import path = require('path');
import type { Config } from './types';

export async function watchConfigFile(
	configFilePath: string,
	onBuild: (config: Config | undefined, result: esbuild.BuildResult) => void,
	watch = true,
) {
	const outDir = path.resolve(
		__dirname,
		'..',
		'..',
		'.tsslint',
	);
	const outFileName = btoa(path.relative(outDir, configFilePath)) + '.cjs';
	const outFile = path.join(outDir, outFileName);
	const resultHandler = (result: esbuild.BuildResult) => {
		let config: Config | undefined;
		if (!result.errors.length) {
			try {
				config = require(outFile).default;
				delete require.cache[outFile!];
			} catch (e) {
				result.errors.push({ text: String(e) } as any);
			}
		}
		onBuild(config, result);
	};
	const ctx = await esbuild.context({
		entryPoints: [configFilePath],
		bundle: true,
		sourcemap: true,
		outfile: outFile,
		format: 'cjs',
		platform: 'node',
		plugins: [{
			name: 'tsslint',
			setup(build) {
				build.onResolve({ filter: /.*/ }, args => {
					if (!args.path.endsWith('.ts')) {
						try {
							const jsPath = require.resolve(args.path, { paths: [args.resolveDir] });
							return {
								path: jsPath,
								external: true,
							};
						} catch { }
					}
					return {};
				});
				if (watch) {
					build.onEnd(resultHandler);
				}
			},
		}],
	});
	if (watch) {
		await ctx.watch();
	}
	else {
		const result = await ctx.rebuild();
		await ctx.dispose();
		resultHandler(result);
	}
	return ctx;
}
