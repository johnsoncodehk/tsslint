#!/usr/bin/env node

const path = require('path');
const fs = require('fs');
const nodeModulesDirs = [];

let dir = __dirname;

while (true) {
	const nodeModuleDir = path.join(dir, 'node_modules');
	if (fs.existsSync(nodeModuleDir)) {
		nodeModulesDirs.push(nodeModuleDir);
	}
	const parentDir = path.resolve(dir, '..');
	if (parentDir === dir) {
		break;
	}
	dir = parentDir;
}

const dtsGeneratePath = path.resolve(__dirname, '..', 'lib', 'dtsGenerate.ts');
if (fs.existsSync(dtsGeneratePath)) {
	console.log('Skip dts generation: lib/dtsGenerate.ts exists.');
	process.exit(0);
}

try {
	const { generateESlintTypes } = require('../lib/eslint-gen');
	const { generateTSLintTypes } = require('../lib/tslint-gen');
	const { generateTSLTypes } = require('../lib/tsl-gen');

	generateESlintTypes(nodeModulesDirs).then(({ dts, stats }) => {
		fs.writeFileSync(path.resolve(__dirname, '..', 'lib', 'eslint-types.d.ts'), dts);

		const indexPath = path.resolve(__dirname, '..', 'lib', 'eslint.d.ts');
		if (fs.existsSync(indexPath)) {
			let indexContent = fs.readFileSync(indexPath, 'utf8');
			const fnIndex = indexContent.indexOf('export declare function importESLintRules');
			const jsDocEnd = indexContent.lastIndexOf('*/', fnIndex) + 2;
			const jsDocStart = indexContent.lastIndexOf('/**', jsDocEnd);

			if (jsDocStart !== -1 && jsDocEnd !== -1 && jsDocStart < fnIndex) {
				const statsTable = [
					'| Plugin | Rules |',
					'| :--- | :--- |',
					...Object.entries(stats)
						.filter(([_, count]) => count > 0)
						.sort((a, b) => b[1] - a[1])
						.map(([name, count]) => `| <span>${name}</span> | ${count} |`),
				].join('\n * ');

				const newJsDoc = `/**
 * Converts an ESLint rules configuration to TSSLint rules.
 *
 * ${statsTable}
 *
 * If you have added new ESLint plugins, please run \`npx tsslint-config-update\` to update this list.
 */`;
				indexContent = indexContent.slice(0, jsDocStart) + newJsDoc + indexContent.slice(jsDocEnd);
				fs.writeFileSync(indexPath, indexContent);
			}
		}
	});
	generateTSLintTypes(nodeModulesDirs).then(({ dts, stats }) => {
		fs.writeFileSync(path.resolve(__dirname, '..', 'lib', 'tslint-types.d.ts'), dts);

		const indexPath = path.resolve(__dirname, '..', 'lib', 'tslint.d.ts');
		if (fs.existsSync(indexPath)) {
			let indexContent = fs.readFileSync(indexPath, 'utf8');
			const fnIndex = indexContent.indexOf('export declare function importTSLintRules');
			const jsDocEnd = indexContent.lastIndexOf('*/', fnIndex) + 2;
			const jsDocStart = indexContent.lastIndexOf('/**', jsDocEnd);

			if (jsDocStart !== -1 && jsDocEnd !== -1 && jsDocStart < fnIndex) {
				const statsTable = [
					'| Dir | Rules |',
					'| :--- | :--- |',
					...Object.entries(stats)
						.filter(([_, count]) => count > 0)
						.sort((a, b) => b[1] - a[1])
						.map(([name, count]) => `| <span>${name}</span> | ${count} |`),
				].join('\n * ');

				const newJsDoc = `/**
 * Converts a TSLint rules configuration to TSSLint rules.
 *
 * ${statsTable}
 *
 * If you have added new TSLint plugins, please run \`npx tsslint-config-update\` to update this list.
 */`;
				indexContent = indexContent.slice(0, jsDocStart) + newJsDoc + indexContent.slice(jsDocEnd);
				fs.writeFileSync(indexPath, indexContent);
			}
		}
	});
	generateTSLTypes(nodeModulesDirs).then(({ dts, stats }) => {
		fs.writeFileSync(path.resolve(__dirname, '..', 'lib', 'tsl-types.d.ts'), dts);

		const indexPath = path.resolve(__dirname, '..', 'lib', 'tsl.d.ts');
		if (fs.existsSync(indexPath)) {
			let indexContent = fs.readFileSync(indexPath, 'utf8');
			const fnIndex = indexContent.indexOf('export declare function importTSLRules');
			const jsDocEnd = indexContent.lastIndexOf('*/', fnIndex) + 2;
			const jsDocStart = indexContent.lastIndexOf('/**', jsDocEnd);

			if (jsDocStart !== -1 && jsDocEnd !== -1 && jsDocStart < fnIndex) {
				const statsTable = [
					'| Plugin | Rules |',
					'| :--- | :--- |',
					...Object.entries(stats)
						.filter(([_, count]) => count > 0)
						.sort((a, b) => b[1] - a[1])
						.map(([name, count]) => `| <span>${name}</span> | ${count} |`),
				].join('\n * ');

				const newJsDoc = `/**
 * Converts a TSL rules configuration to TSSLint rules.
 *
 * ${statsTable}
 *
 * If you have added new TSL plugins, please run \`npx tsslint-config-update\` to update this list.
 */`;
				indexContent = indexContent.slice(0, jsDocStart) + newJsDoc + indexContent.slice(jsDocEnd);
				fs.writeFileSync(indexPath, indexContent);
			}
		}
	});
}
catch (err) {
	console.error(err);
}
