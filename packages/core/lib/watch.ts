import esbuild = require('esbuild');
import _path = require('path');
import fs = require('fs');
import url = require('url');
import type { Config } from '@tsslint/config';
import ErrorStackParser = require('error-stack-parser');

export async function watchConfigFile(
	configFilePath: string,
	onBuild: (config: Config | Config[] | undefined, result: esbuild.BuildResult) => void,
	watch = true,
	createHash: (path: string) => string = btoa,
	// @ts-expect-error
	logger?: typeof import('@clack/prompts')
) {
	const outDir = getDotTsslintPath(configFilePath);
	const outFileName = createHash(_path.relative(outDir, configFilePath)) + '.mjs';
	const outFile = _path.join(outDir, outFileName);
	const configFileDisplayPath = _path.relative(process.cwd(), configFilePath);
	const resultHandler = async (result: esbuild.BuildResult) => {
		let config: Config | undefined;
		for (const error of [
			...result.errors,
			...result.warnings,
		]) {
			if (error.id) {
				error.id = 'esbuild:' + error.id;
			}
			else {
				error.id = 'config-build-error';
			}
		}
		const buildResultText = 'Built ' + configFileDisplayPath + ' in ' + (Date.now() - buildStart) + 'ms';
		configBuildingSpinner?.message(buildResultText);
		if (!result.errors.length) {
			const loadStart = Date.now();
			configBuildingSpinner?.message(buildResultText + ', importing...');
			try {
				config = (await import(url.pathToFileURL(outFile).toString() + '?time=' + Date.now())).default;
				configBuildingSpinner?.stop(buildResultText + ', imported in ' + (Date.now() - loadStart) + 'ms.');
			} catch (e: any) {
				configBuildingSpinner?.stop(buildResultText + ', failed to import.');
				if (e.stack) {
					const stack = ErrorStackParser.parse(e)[0];
					if (stack.fileName && stack.lineNumber !== undefined && stack.columnNumber !== undefined) {
						let fileName = stack.fileName
							.replace(/\\/g, '/')
							.split('?time=')[0];
						if (fileName.startsWith('file://')) {
							fileName = fileName.substring('file://'.length);
						}
						result.errors.push({
							id: 'config-import-error',
							text: String(e),
							location: {
								file: fileName,
								line: stack.lineNumber,
								column: stack.columnNumber - 1,
								lineText: '',
							},
						} as any);
					} else {
						result.errors.push({
							id: 'config-import-error',
							text: String(e),
						} as any);
					}
				} else {
					result.errors.push({
						id: 'config-import-error',
						text: String(e),
					} as any);
				}
			}
		}
		onBuild(config, result);
	};

	let buildStart: number;

	const configBuildingSpinner = logger?.spinner();
	configBuildingSpinner?.start('Building ' + configFileDisplayPath);

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
					buildStart = Date.now();
				});
				build.onResolve({ filter: /^https?:\/\// }, async ({ path: importUrl }) => {
					const cachePath = _path.join(outDir, importUrl.split('://')[0], ...importUrl.split('://')[1].split('/'));
					if (!fs.existsSync(cachePath)) {
						configBuildingSpinner?.message('Downloading ' + importUrl);
						const response = await fetch(importUrl);
						configBuildingSpinner?.message('Building ' + configFileDisplayPath);
						if (!response.ok) {
							throw new Error(`Failed to load ${importUrl}`);
						}
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
		const result = await ctx.rebuild();
		await ctx.dispose();
		resultHandler(result);
	}
	return ctx;
}

function isTsFile(path: string) {
	return path.endsWith('.ts') || path.endsWith('.tsx') || path.endsWith('.cts') || path.endsWith('.mts');
}

export function getDotTsslintPath(configFilePath: string): string {
	return _path.resolve(configFilePath, '..', 'node_modules', '.tsslint');
}
