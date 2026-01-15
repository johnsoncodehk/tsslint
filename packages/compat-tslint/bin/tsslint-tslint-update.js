#!/usr/bin/env node

const path = require('path');
const fs = require('fs');

let projectRoot = process.cwd();
while (true) {
	if (fs.existsSync(path.join(projectRoot, 'tslint.json')) || fs.existsSync(path.join(projectRoot, 'package.json'))) {
		break;
	}
	const parentDir = path.resolve(projectRoot, '..');
	if (parentDir === projectRoot) {
		projectRoot = process.cwd();
		break;
	}
	projectRoot = parentDir;
}

const dtsGeneratePath = path.resolve(__dirname, '..', 'lib', 'dtsGenerate.ts');
if (fs.existsSync(dtsGeneratePath)) {
	console.log('Skip dts generation: lib/dtsGenerate.ts exists.');
	process.exit(0);
}

try {
	const { generate } = require('../lib/dtsGenerate.js');
	generate(projectRoot).then(({ dts, stats }) => {
		fs.writeFileSync(path.resolve(__dirname, '..', 'lib', 'types.d.ts'), dts);

		const indexPath = path.resolve(__dirname, '..', 'index.d.ts');
		if (fs.existsSync(indexPath)) {
			let indexContent = fs.readFileSync(indexPath, 'utf8');
			const importTSLintRulesIndex = indexContent.indexOf('export declare function importTSLintRules');
			const jsDocEnd = indexContent.lastIndexOf('*/', importTSLintRulesIndex) + 2;
			const jsDocStart = indexContent.lastIndexOf('/**', jsDocEnd);

			if (jsDocStart !== -1 && jsDocEnd !== -1 && jsDocStart < importTSLintRulesIndex) {
				const statsTable = [
					'| Directory | Rules |',
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
 * ---
 * If you have updated your tslint.json or rules directories, please run \`npx tsslint-tslint-update\` to update this list.
 */`;
				indexContent = indexContent.slice(0, jsDocStart) + newJsDoc + indexContent.slice(jsDocEnd);
				fs.writeFileSync(indexPath, indexContent);
			}
		}
	});
} catch (err) {
	console.error(err);
}
