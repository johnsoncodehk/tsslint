import esbuild = require('esbuild');
import _path = require('path');
import fs = require('fs');
import url = require('url');

export async function watchConfig(
	configFilePath: string,
	onBuild: (config: string | undefined, result: esbuild.BuildResult) => void,
	watch = true,
	createHash: (path: string) => string = btoa,
	// @ts-expect-error
	spinner?: ReturnType<typeof import('@clack/prompts').spinner>,
	stopSnipper?: (message: string, code?: number) => void
) {
	const outDir = getDotTsslintPath(configFilePath);
	const outFileName = createHash(_path.relative(outDir, configFilePath)) + '.mjs';
	const outFile = _path.join(outDir, outFileName);
	const resultHandler = (result: esbuild.BuildResult) => {
		if (!result.errors.length) {
			onBuild(outFile, result);
		} else {
			onBuild(undefined, result);
		}
	};
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
				build.onResolve({ filter: /^https?:\/\// }, async ({ path: importUrl }) => {
					const cachePath = _path.join(outDir, importUrl.split('://')[0], ...importUrl.split('://')[1].split('/'));
					if (!fs.existsSync(cachePath)) {
						const start = Date.now();
						spinner?.message('Downloading ' + importUrl);
						const response = await fetch(importUrl);
						if (!response.ok) {
							throw new Error(`Failed to load ${importUrl}`);
						}
						stopSnipper?.('Downloaded ' + importUrl + ' in ' + (Date.now() - start) + 'ms');
						const text = await response.text();
						fs.mkdirSync(_path.dirname(cachePath), { recursive: true });
						fs.writeFileSync(cachePath, text, 'utf8');
					}
					if (isTsFile(cachePath)) {
						return {
							path: cachePath,
							external: false,
						};
					} else {
						return {
							path: url.pathToFileURL(cachePath).toString(),
							external: true,
						};
					}
				});
				build.onResolve({ filter: /.*/ }, ({ path, resolveDir }) => {
					if (!isTsFile(path)) {
						try {
							const maybeJsPath = require.resolve(path, { paths: [resolveDir] });
							if (!isTsFile(maybeJsPath) && fs.existsSync(maybeJsPath)) {
								return {
									path: url.pathToFileURL(maybeJsPath).toString(),
									external: true,
								};
							}
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
		try {
			const result = await ctx.rebuild(); // could throw
			await ctx.dispose();
			resultHandler(result);
		} catch (e) {
			throw e;
		}
	}
	return ctx;
}

function isTsFile(path: string) {
	return path.endsWith('.ts') || path.endsWith('.tsx') || path.endsWith('.cts') || path.endsWith('.mts');
}

export function getDotTsslintPath(configFilePath: string): string {
	return _path.resolve(configFilePath, '..', 'node_modules', '.tsslint');
}
