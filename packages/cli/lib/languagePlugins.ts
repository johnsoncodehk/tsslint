import type { LanguagePlugin } from '@volar/language-core';
import { createAstroPlugin, createMdxPlugin, createTsMacroPlugins, createVuePlugin, createVueVinePlugins } from '@volar/language-hub';
import ts = require('typescript');

const cache = new Map<string, LanguagePlugin<string>[]>();

export async function load(tsconfig: string, languages: string[]) {
	if (cache.has(tsconfig)) {
		return cache.get(tsconfig)!;
	}
	const plugins: LanguagePlugin<string>[] = [];
	if (languages.includes('vue')) {
		plugins.push(createVuePlugin(ts, tsconfig));
	}
	if (languages.includes('vue-vine')) {
		plugins.push(...createVueVinePlugins(ts, tsconfig));
	}
	if (languages.includes('mdx')) {
		plugins.push(await createMdxPlugin(ts, tsconfig));
	}
	if (languages.includes('astro')) {
		plugins.push(createAstroPlugin(ts, tsconfig));
	}
	if (languages.includes('ts-macro')) {
		plugins.push(...await createTsMacroPlugins(ts, tsconfig));
	}
	cache.set(tsconfig, plugins);
	return plugins;
}
