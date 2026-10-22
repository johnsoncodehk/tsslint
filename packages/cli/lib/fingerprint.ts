// Layer 2 cache key. A type-aware rule's result for a file can depend on
// any file the program loaded (imports, ambient `.d.ts`, lib) and on the
// compiler options, so the key covers all of them. Coarse by design: any
// change anywhere in the program re-runs every type-aware rule, which
// keeps the check sound without a dependency graph.

import crypto = require('crypto');
import fs = require('fs');
import type { Program } from 'typescript/sync';

export function getProgramFingerprint(program: Program): string {
	const hash = crypto.createHash('sha256');
	hash.update(JSON.stringify(program.getCompilerOptions()));
	for (const fileName of [...program.getSourceFileNames()].sort()) {
		// Bundled lib files have no on-disk path; the TS version in the
		// cache path already covers them.
		const stat = fs.statSync(fileName, { throwIfNoEntry: false });
		hash.update(`\0${fileName}\0${stat?.mtimeMs ?? -1}\0${stat?.size ?? -1}`);
	}
	return hash.digest('hex');
}
