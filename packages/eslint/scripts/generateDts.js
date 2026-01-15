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

try {
	const { generate } = require('../lib/dtsGenerate.js');
	generate(nodeModulesDirs).then(({ dts, stats }) => {
		fs.writeFileSync(path.resolve(__dirname, '..', 'lib', 'types.d.ts'), dts);

		const indexPath = path.resolve(__dirname, '..', 'index.d.ts');
		if (fs.existsSync(indexPath)) {
			let indexContent = fs.readFileSync(indexPath, 'utf8');
			const defineRulesIndex = indexContent.indexOf('export declare function defineRules');
			const jsDocEnd = indexContent.lastIndexOf('*/', defineRulesIndex) + 2;
			const jsDocStart = indexContent.lastIndexOf('/**', jsDocEnd);

			if (jsDocStart !== -1 && jsDocEnd !== -1 && jsDocStart < defineRulesIndex) {
					const statsTable = [
						'| Plugin | Rules |',
						'| :--- | :--- |',
						...Object.entries(stats)
							.filter(([_, count]) => count > 0)
							.sort((a, b) => b[1] - a[1])
							.map(([name, count]) => `| <span>${name}</span> | ${count} |`),
					].join('\n	 * ');

					const newJsDoc = `/**
	 * Converts an ESLint rules configuration to TSSLint rules.
	 *
	 * ${statsTable}
	 *
	 * ---
	 * If you have added new ESLint plugins, please run \\\`npx tsslint-eslint-generate\\\` to update this list.
	 * 
	 * ---
	 */`;
				indexContent = indexContent.slice(0, jsDocStart) + newJsDoc + indexContent.slice(jsDocEnd);
				fs.writeFileSync(indexPath, indexContent);
			}
		}
	});
} catch (err) {
	console.error(err);
}
