require('esbuild').context({
	entryPoints: ['./node_modules/@tsslint/plugin/out/index.js'],
	bundle: true,
	outfile: './node_modules/@tsslint/plugin-bundle/index.js',
	external: ['vscode'],
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
