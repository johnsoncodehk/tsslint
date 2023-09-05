require('esbuild').build({
	entryPoints: ['./node_modules/@tsslint/plugin/out/index.js'],
	bundle: true,
	outfile: './node_modules/@tsslint/plugin-bundle/index.js',
	external: ['vscode'],
	format: 'cjs',
	platform: 'node',
	tsconfig: './tsconfig.json',
	minify: process.argv.includes('--minify'),
	watch: process.argv.includes('--watch'),
}).catch(() => process.exit(1))
