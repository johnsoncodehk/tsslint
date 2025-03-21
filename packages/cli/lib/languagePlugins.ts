import { LanguagePlugin } from '@volar/language-core';
import path = require('path');
import ts = require('typescript');

const cache = new Map<string, LanguagePlugin<string>[]>();

export async function load(tsconfig: string, languages: string[]) {
	if (cache.has(tsconfig)) {
		return cache.get(tsconfig)!;
	}
	const plugins: LanguagePlugin<string>[] = [];

	if (languages.includes('vue')) {
		let vue: typeof import('@vue/language-core');
		let vueTscPkgPath: string | undefined;

		if (findPackageJson('@vue/language-core')) {
			vue = require('@vue/language-core');
		} else if (vueTscPkgPath = findPackageJson('vue-tsc')) {
			const vueTscPath = path.dirname(vueTscPkgPath);
			vue = require(require.resolve('@vue/language-core', { paths: [vueTscPath] }));
		} else {
			const pkg = ts.findConfigFile(path.dirname(tsconfig), ts.sys.fileExists, 'package.json');
			if (pkg) {
				throw new Error('Please install @vue/language-core or vue-tsc to ' + path.relative(process.cwd(), pkg));
			} else {
				throw new Error('Please install @vue/language-core or vue-tsc for ' + path.relative(process.cwd(), tsconfig));
			}
		}

		const commonLine = vue.createParsedCommandLine(ts, ts.sys, tsconfig);
		const vueLanguagePlugin = vue.createVueLanguagePlugin<string>(
			ts,
			commonLine.options,
			commonLine.vueOptions,
			fileName => fileName
		);
		plugins.push(vueLanguagePlugin);
	}

	if (languages.includes('vue-vine')) {
		let vue: typeof import('@vue/language-core');
		let vueVine: typeof import('@vue-vine/language-service');
		let pkgPath: string | undefined;

		if (pkgPath = findPackageJson('@vue-vine/language-service')) {
			const pkgDir = path.dirname(pkgPath);
			vueVine = require('@vue-vine/language-service');
			vue = require(require.resolve('@vue/language-core', { paths: [pkgDir] }));
		} else if (pkgPath = findPackageJson('vue-vine-tsc')) {
			const pkgDir = path.dirname(pkgPath);
			vue = require(require.resolve('@vue/language-core', { paths: [pkgDir] }));
			vueVine = require(require.resolve('@vue/language-core', { paths: [pkgDir] }));
		} else {
			const pkg = ts.findConfigFile(path.dirname(tsconfig), ts.sys.fileExists, 'package.json');
			if (pkg) {
				throw new Error('Please install @vue-vine/language-service or vue-vine-tsc to ' + path.relative(process.cwd(), pkg));
			} else {
				throw new Error('Please install @vue-vine/language-service or vue-vine-tsc for ' + path.relative(process.cwd(), tsconfig));
			}
		}

		const commonLine = vue.createParsedCommandLine(ts, ts.sys, tsconfig, true);
		const globalTypesFilePath = vueVine.setupGlobalTypes(path.dirname(tsconfig), commonLine.vueOptions as any, ts.sys);
		if (globalTypesFilePath) {
			commonLine.vueOptions.__setupedGlobalTypes = {
				absolutePath: globalTypesFilePath,
			};
		}

		plugins.push(
			vue.createVueLanguagePlugin<string>(
				ts,
				commonLine.options,
				commonLine.vueOptions,
				id => id
			)
		);

		plugins.push(
			vueVine.createVueVineLanguagePlugin(
				ts,
				{
					compilerOptions: commonLine.options,
					vueCompilerOptions: commonLine.vueOptions as any,
					target: 'tsc',
				}
			)
		);
	}

	if (languages.includes('mdx')) {
		let mdx: any;

		try {
			mdx = await import(require.resolve('@mdx-js/language-service', { paths: [path.dirname(tsconfig)] }));
		} catch {
			const pkg = ts.findConfigFile(path.dirname(tsconfig), ts.sys.fileExists, 'package.json');
			if (pkg) {
				throw new Error('Please install @mdx-js/language-service to ' + path.relative(process.cwd(), pkg));
			} else {
				throw new Error('Please install @mdx-js/language-service for ' + path.relative(process.cwd(), tsconfig));
			}
		}

		const mdxLanguagePlugin = mdx.createMdxLanguagePlugin();
		plugins.push(mdxLanguagePlugin);
	}

	if (languages.includes('astro')) {
		let astro: any;

		try {
			astro = require(require.resolve('@astrojs/ts-plugin/dist/language.js', { paths: [path.dirname(tsconfig)] }));
		} catch (err) {
			const pkg = ts.findConfigFile(path.dirname(tsconfig), ts.sys.fileExists, 'package.json');
			if (pkg) {
				throw new Error('Please install @astrojs/ts-plugin to ' + path.relative(process.cwd(), pkg));
			} else {
				throw new Error('Please install @astrojs/ts-plugin for ' + path.relative(process.cwd(), tsconfig));
			}
		}

		const astroLanguagePlugin = astro.getLanguagePlugin();
		plugins.push(astroLanguagePlugin);
	}

	if (languages.includes('ts-macro')) {
		let tsMacro: any;
		let tsMacroOptions: any;
		let tsmcPkgPath: string | undefined;

		if (tsmcPkgPath = findPackageJson('@ts-macro/language-plugin')) {
			tsMacro = await import(require.resolve('@ts-macro/language-plugin', { paths: [path.dirname(tsconfig)] }));
			tsMacroOptions = require(require.resolve('@ts-macro/language-plugin/options', { paths: [path.dirname(tsconfig)] }));
		} else if (tsmcPkgPath = findPackageJson('@ts-macro/tsc')) {
			const tsmcPath = path.dirname(tsmcPkgPath);
			tsMacro = require(require.resolve('@ts-macro/language-plugin', { paths: [tsmcPath] }));
			tsMacroOptions = require(require.resolve('@ts-macro/language-plugin/options', { paths: [tsmcPath] }))
		} else {
			const pkg = ts.findConfigFile(path.dirname(tsconfig), ts.sys.fileExists, 'package.json');
			if (pkg) {
				throw new Error('Please install @ts-macro/language-plugin or @ts-macro/tsc to ' + path.relative(process.cwd(), pkg));
			} else {
				throw new Error('Please install @ts-macro/language-plugin or @ts-macro/tsc for ' + path.relative(process.cwd(), tsconfig));
			}
		}
		
		const compilerOptions = ts.readConfigFile(tsconfig, ts.sys.readFile).config.compilerOptions;
		plugins.push(...tsMacro.getLanguagePlugins(ts, compilerOptions, tsMacroOptions.getOptions(ts)));
	}

	cache.set(tsconfig, plugins);
	return plugins;

	function findPackageJson(pkgName: string) {
		return ts.findConfigFile(path.dirname(tsconfig), ts.sys.fileExists, `node_modules/${pkgName}/package.json`);
	}
}
