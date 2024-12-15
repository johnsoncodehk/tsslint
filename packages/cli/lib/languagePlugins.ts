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

	cache.set(tsconfig, plugins);
	return plugins;

	function findPackageJson(pkgName: string) {
		try {
			return require.resolve(`${pkgName}/package.json`, { paths: [path.dirname(tsconfig)] });
		} catch { }
	}
}
