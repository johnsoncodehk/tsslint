import type { Config } from '@tsslint/config';
import esbuild = require('esbuild');
import path = require('path');

export async function watchConfig(
	tsConfigPath: string,
	onBuild: (config: Config | undefined, result: esbuild.BuildResult) => void,
) {
	const outFile = path.resolve(
		path.dirname(
			require.resolve('@tsslint/typescript-plugin/package.json')
		),
		'..',
		'.tsslint',
		'config.cjs'
	);
	const ctx = await esbuild.context({
		entryPoints: [tsConfigPath],
		bundle: true,
		outfile: outFile,
		format: 'cjs',
		platform: 'node',
		plugins: [{
			name: 'tsslint',
			setup(build) {
				build.onEnd(result => {
					let config: Config | undefined;
					if (!result.errors.length) {
						delete require.cache[outFile!];
						try {
							config = require(outFile).default;
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
