// Cache-aware wrapper around `linter.lint`. A file's cached result is the
// diagnostics it produced after plugins ran; `lib/invalidation.ts` deletes the
// entries that are no longer valid before linting starts, so an entry that is
// still here can be replayed as is.

import { type Linter, NO_CACHE } from '@tsslint/core';
import type { Diagnostic, LintTarget } from '@tsslint/types';
import type { FileCache } from './cache.js';

export function lintWithCache(
	linter: Linter,
	target: LintTarget,
	files: Record<string, FileCache>,
	options?: {
		// Fixes are closures that don't survive the cache, so a file with
		// fixes has to be linted again to apply them.
		fix?: boolean;
	},
): Diagnostic[] {
	const fileName = target.file.fileName;
	const cached = files[fileName];
	if (cached && !(options?.fix && cached.hasFix)) {
		return cached.diagnostics.map(diagnostic => ({ ...diagnostic }));
	}

	const diagnostics = linter.lint(target);
	if (linter.getRawLintResult(fileName).some(diagnostic => (diagnostic as any)[NO_CACHE])) {
		delete files[fileName];
	}
	else {
		files[fileName] = {
			hasFix: linter.hasCodeFixes(fileName),
			diagnostics: diagnostics.map(diagnostic => ({ ...diagnostic })),
		};
	}
	return diagnostics;
}
