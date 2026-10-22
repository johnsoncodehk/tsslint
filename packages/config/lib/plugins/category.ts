import type { Plugin } from '@tsslint/types';
import type { DiagnosticCategory } from 'typescript/sync';

import minimatch = require('minimatch');

export function create(config: Record<string, DiagnosticCategory>, source = 'tsslint'): Plugin {
	const matchCache = new Map<string | number, DiagnosticCategory | undefined>();
	return () => ({
		resolveDiagnostics(_file, diagnostics) {
			for (const diagnostic of diagnostics) {
				if (diagnostic.source !== source) {
					continue;
				}
				const category = match(diagnostic.code.toString());
				if (category !== undefined) {
					diagnostic.category = category;
				}
			}
			return diagnostics;
		},
	});
	function match(code: string) {
		if (matchCache.has(code)) {
			return matchCache.get(code);
		}
		for (const pattern in config) {
			const category = config[pattern];
			if (minimatch.minimatch(code, pattern, { dot: true })) {
				matchCache.set(code, category);
				return category;
			}
		}
	}
}
