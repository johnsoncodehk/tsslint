import { LanguagePlugin } from '@volar/language-core';
import path = require('path');
import ts = require('typescript');

export function load(tsconfig: string) {
	const plugins: LanguagePlugin<string>[] = [];

	if (process.argv.includes('--enable-vue-support')) {
		let vue: typeof import('@vue/language-core');

		if (hasPackage('@vue/language-core')) {
			vue = require('@vue/language-core');
		} else if (hasPackage('vue-tsc')) {
			const vueTscPath = path.dirname(require.resolve('vue-tsc/package.json'));
			vue = require(require.resolve('@vue/language-core', { paths: [vueTscPath] }));
		} else {
			throw new Error('Please install @vue/language-core or vue-tsc');
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

	return plugins;
}

function hasPackage(pkgName: string) {
	try {
		require.resolve(`${pkgName}/package.json`);
		return true;
	} catch {
		return false;
	}
}
