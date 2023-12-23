import path = require('path');

export function findConfigFile(dir: string) {
	const dirs = [dir];
	let upDir: string;

	while ((upDir = path.resolve(dir, '..')) !== dirs[dirs.length - 1]) {
		dirs.push(upDir);
		dir = upDir;
	}

	for (const dir of dirs) {
		try {
			return require.resolve('./tsslint.config.ts', { paths: [dir] });
		} catch { }
	}
}
