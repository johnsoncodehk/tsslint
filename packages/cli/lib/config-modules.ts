// Tracks which modules a tsslint config loads, so editing a rule file or
// upgrading a dependency it imports invalidates the cache the same way
// editing the config does.

import crypto = require('crypto');
import fs = require('fs');
import Module = require('module');
import url = require('url');

const imports = new Map</* parent URL */ string, Set</* URL */ string>>();
let tracking = false;

// Must run before the config is imported; modules loaded earlier have no
// recorded edges.
export function trackImports() {
	if (tracking) {
		return;
	}
	tracking = true;
	// Added in Node.js 22.15; on older versions only the config file itself
	// is keyed (see `getConfigModulesKey`).
	const registerHooks = (Module as { registerHooks?: (hooks: object) => void }).registerHooks;
	registerHooks?.({
		resolve(
			specifier: string,
			context: { parentURL?: string },
			nextResolve: (specifier: string, context: object) => { url: string },
		) {
			const result = nextResolve(specifier, context);
			if (context.parentURL) {
				let children = imports.get(context.parentURL);
				if (!children) {
					imports.set(context.parentURL, children = new Set());
				}
				children.add(result.url);
			}
			return result;
		},
	});
}

// Name, mtime and size of every file module reachable from the config.
// Modules a rule imports lazily while linting are not covered.
export function getConfigModulesKey(configFile: string): string {
	const entry = url.pathToFileURL(configFile).href;
	const seen = new Set([entry]);
	const queue = [entry];
	while (queue.length) {
		for (const child of imports.get(queue.pop()!) ?? []) {
			if (!seen.has(child)) {
				seen.add(child);
				queue.push(child);
			}
		}
	}
	const hash = crypto.createHash('sha256');
	for (const moduleUrl of [...seen].sort()) {
		if (!moduleUrl.startsWith('file:')) {
			continue;
		}
		const fileName = url.fileURLToPath(moduleUrl);
		const stat = fs.statSync(fileName, { throwIfNoEntry: false });
		hash.update(`\0${fileName}\0${stat?.mtimeMs ?? -1}\0${stat?.size ?? -1}`);
	}
	return hash.digest('hex');
}
