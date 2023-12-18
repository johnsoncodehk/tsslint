import type { Config } from '@tsslint/config';
import esbuild = require('esbuild');
import path = require('path');

export async function watchConfig(
	tsConfigPath: string,
	onBuild: (config: Config | undefined, result: esbuild.BuildResult) => void,
) {
	const outDir = path.resolve(
		path.dirname(
			require.resolve('@tsslint/typescript-plugin/package.json')
		),
		'..',
		'..',
		'.tsslint',
	);
	const outFileName = btoa(path.relative(outDir, tsConfigPath)) + '.cjs';
	const outFile = path.join(outDir, outFileName);
	const ctx = await esbuild.context({
		entryPoints: [tsConfigPath],
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
				build.onEnd(result => {
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
				});
			},
		}],
	});
	await ctx.watch();
	return ctx;
}
