const path = require("path");
const fs = require("fs");
const { generate } = require("../lib/dtsGenerate.js");

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

generate(nodeModulesDirs).then(dts => {
	fs.writeFileSync(path.resolve(__dirname, '..', 'lib', 'types.d.ts'), dts);
	console.log("Generated packages/tslint/lib/types.d.ts for importTslintRules.");
});
