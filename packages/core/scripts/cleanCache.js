const fs = require('fs');
const path = require('path');

let dir = __dirname;

while (true) {
	const cachePath = path.join(dir, 'node_modules', '.tsslint');
	if (fs.existsSync(cachePath)) {
		console.log(`Removing ${cachePath}`);
		fs.rmSync(cachePath, { recursive: true });
		break;
	}

	const parentDir = path.resolve(dir, '..');
	if (parentDir === dir) {
		break;
	}

	dir = parentDir;
}
