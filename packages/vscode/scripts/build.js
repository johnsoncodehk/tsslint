// @ts-check
const path = require('path');
const esbuild = require('esbuild');

esbuild.context({
	entryPoints: {
		'tsl-typescript-plugin-bundled/index': './node_modules/@tsslint/typescript-plugin/index.js',
	},
	outdir: path.resolve(__dirname, '../node_modules'),
	bundle: true,
	external: [],
	format: 'cjs',
	platform: 'node',
	tsconfig: './tsconfig.json',
	minify: process.argv.includes('--minify'),
}).then(async ctx => {
	console.log('building...');
	if (process.argv.includes('--watch')) {
		await ctx.watch();
		console.log('watching...');
	} else {
		await ctx.rebuild();
		await ctx.dispose();
		console.log('finished.');
	}
});
