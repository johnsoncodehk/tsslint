import esbuild = require('esbuild');
import _path = require('path');
import fs = require('fs');
import type { Config } from '@tsslint/config';
import { pathToFileURL } from 'url';

export async function watchConfigFile(
	configFilePath: string,
	onBuild: (config: Config | Config[] | undefined, result: esbuild.BuildResult) => void,
	watch = true,
	createHash: (path: string) => string = btoa,
	logger: Pick<typeof console, 'log' | 'warn' | 'error'> = console
) {
	let start: number;
	const outDir = _path.resolve(configFilePath, '..', 'node_modules', '.tsslint');
	const outFileName = createHash(_path.relative(outDir, configFilePath)) + '.mjs';
	const outFile = _path.join(outDir, outFileName);
	const resultHandler = async (result: esbuild.BuildResult) => {
		let config: Config | undefined;
		if (!result.errors.length) {
			try {
				config = (await import(pathToFileURL(outFile).toString() + '?time=' + Date.now())).default;
			} catch (e) {
				result.errors.push({ text: String(e) } as any);
			}
		}
		logger.log(`Built ${_path.relative(process.cwd(), configFilePath)} in ${Date.now() - start}ms`);
		onBuild(config, result);
	};
	const cacheDir = _path.resolve(outDir, 'http_resources');
	const cachePathToOriginalPath = new Map<string, string>();
	const ctx = await esbuild.context({
		entryPoints: [configFilePath],
		bundle: true,
		sourcemap: true,
		outfile: outFile,
		format: 'esm',
		platform: 'node',
		plugins: [{
			name: 'tsslint',
			setup(build) {
				build.onStart(() => {
					start = Date.now();
				});
				build.onResolve({ filter: /^https?:\/\// }, ({ path }) => {
					const cachePath = _path.join(cacheDir, createHash(path));
					cachePathToOriginalPath.set(cachePath, path);
					return { path: cachePath, namespace: 'http-url' };
				});
				build.onResolve({ filter: /.*/ }, ({ path, resolveDir }) => {
					if (!path.endsWith('.ts')) {
						try {
							const maybeJsPath = require.resolve(path, { paths: [resolveDir] });
							if (maybeJsPath !== path && !maybeJsPath.endsWith('.ts')) {
								return {
									path: pathToFileURL(maybeJsPath).toString(),
									external: true,
								};
							}
						} catch { }
					}
					return {};
				});
				build.onLoad({ filter: /.*/, namespace: 'http-url' }, async ({ path: cachePath }) => {
					const path = cachePathToOriginalPath.get(cachePath)!;
					if (fs.existsSync(cachePath)) {
						return {
							contents: fs.readFileSync(cachePath, 'utf8'),
							loader: 'ts',
						};
					}
					const response = await fetch(path);
					if (!response.ok) {
						throw new Error(`Failed to load ${path}`);
					}
					const text = await response.text();
					fs.mkdirSync(cacheDir, { recursive: true });
					fs.writeFileSync(cachePath, text, 'utf8');
					return {
						contents: text,
						loader: path.substring(path.lastIndexOf('.') + 1) as 'ts' | 'js',
					};
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
