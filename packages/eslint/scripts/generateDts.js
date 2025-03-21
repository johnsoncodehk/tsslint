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
	generate(nodeModulesDirs).then(dts => {
		fs.writeFileSync(path.resolve(__dirname, '..', 'lib', 'types.d.ts'), dts);
	});
} catch { }
