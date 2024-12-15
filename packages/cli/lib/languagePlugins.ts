import { LanguagePlugin } from '@volar/language-core';
import path = require('path');
import ts = require('typescript');
import glob = require('glob');

const cache = new Map<string, LanguagePlugin<string>[]>();
const vueProjects = new Set<string>();

if (process.argv.includes('--vue-projects')) {
	const projectsIndex = process.argv.indexOf('--vue-projects');
	for (let i = projectsIndex + 1; i < process.argv.length; i++) {
		if (process.argv[i].startsWith('-')) {
			break;
		}
		const searchGlob = process.argv[i];
		const tsconfigs = glob.sync(searchGlob);
		for (let tsconfig of tsconfigs) {
			if (!tsconfig.startsWith('.')) {
				tsconfig = `./${tsconfig}`;
			}
			vueProjects.add(require.resolve(tsconfig, { paths: [process.cwd()] }));
		}
	}
}

export function load(tsconfig: string) {
	if (cache.has(tsconfig)) {
		return cache.get(tsconfig)!;
	}
	const plugins: LanguagePlugin<string>[] = [];

	if (vueProjects.has(tsconfig)) {
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

	cache.set(tsconfig, plugins);
	return plugins;

	function findPackageJson(pkgName: string) {
		try {
			return require.resolve(`${pkgName}/package.json`, { paths: [path.dirname(tsconfig)] });
		} catch { }
	}
}
