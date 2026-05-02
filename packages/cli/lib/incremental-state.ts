// Layer 2 cross-session state. Persists per-file content hashes and
// transitive dependency lists between `tsslint --incremental` runs so
// the next session can compute which files' type-relevant inputs have
// moved.
//
// Why not `.tsbuildinfo`? TS's `BuilderProgram` reads/writes that file
// via internal APIs (`getProgramBuildInfo` / `createBuilderProgramUsing-
// ProgramBuildInfo`), and the format is explicitly TS-major-coupled.
// Going through the public `getAllDependencies` + a content-hash digest
// trades some cache hit rate (we invalidate on body-only edits where
// TS's shape signatures wouldn't) for a sustainable contract that
// doesn't break on TS upgrades.

import type * as ts from 'typescript';

export interface IncrementalState {
	version: string;
	files: Record</* fileName */ string, {
		contentHash: string;
		// Transitive dependency file paths as `BuilderProgram.getAll-
		// Dependencies` reported them at the previous session's end.
		// Includes ambient `.d.ts` files and lib files — the gap that
		// per-file mtime caches can't close.
		deps: string[];
	}>;
}

export const INCREMENTAL_STATE_VERSION = 'v1';

// Build a fresh state snapshot from a wrapped BuilderProgram, to save
// alongside the cache file. Called after the lint pass.
//
// Ambient `.d.ts` files (`declare global`, top-level declarations in
// script-mode `.d.ts`) don't show up in any specific file's
// `getAllDependencies` because no file explicitly imports them — they
// connect via global scope. To catch their edits, we treat every
// non-lib script-mode `.d.ts` as a universal dep. Lib files are
// excluded because they only change when `compilerOptions.lib` flips,
// which already invalidates the entire cache file via the path key.
export function buildIncrementalState(
	builder: ts.BuilderProgram,
	hash: (s: string) => string,
): IncrementalState {
	const program = builder.getProgram();
	// Detect script-mode .d.ts via `externalModuleIndicator`. Field is
	// internal in TS's public types but stable at runtime — used by tools
	// across the ecosystem (typescript-eslint, ts-morph) for the same
	// reason. The public `ts.isExternalModule` check would work too but
	// is itself runtime-only at the API level.
	const ambients: string[] = [];
	for (const sf of program.getSourceFiles()) {
		if (
			sf.isDeclarationFile
			&& !(sf as { externalModuleIndicator?: unknown }).externalModuleIndicator
			&& !program.isSourceFileDefaultLibrary(sf)
		) {
			ambients.push(sf.fileName);
		}
	}

	const files: IncrementalState['files'] = {};
	for (const sf of program.getSourceFiles()) {
		const deps = new Set(builder.getAllDependencies(sf));
		for (const a of ambients) deps.add(a);
		files[sf.fileName] = {
			contentHash: hash(sf.text),
			deps: [...deps],
		};
	}
	return { version: INCREMENTAL_STATE_VERSION, files };
}

// Diff a previous state against the current program to figure out which
// files' type-relevant inputs are affected since the last session. The
// result feeds `cacheFlow.lintWithCache(..., { typeAwareUnaffected })`:
// a file NOT in the affected set has unchanged dep hashes, so its
// type-aware rule cache entries are still valid.
export function computeAffectedFiles(
	prev: IncrementalState | undefined,
	program: ts.Program,
	hash: (s: string) => string,
): Set<string> {
	const affected = new Set<string>();
	const sourceFiles = program.getSourceFiles();
	if (!prev || prev.version !== INCREMENTAL_STATE_VERSION) {
		// No prior state (or schema bump): every file is affected.
		for (const sf of sourceFiles) affected.add(sf.fileName);
		return affected;
	}

	// Step 1: hash every current file. Files whose own content moved go
	// straight into `changed`. Files newly added (no prev entry) go into
	// `affected` directly — we have nothing cached for them anyway.
	const currentHashes = new Map<string, string>();
	const changed = new Set<string>();
	for (const sf of sourceFiles) {
		const h = hash(sf.text);
		currentHashes.set(sf.fileName, h);
		const prevEntry = prev.files[sf.fileName];
		if (!prevEntry) {
			affected.add(sf.fileName);
		}
		else if (prevEntry.contentHash !== h) {
			changed.add(sf.fileName);
			affected.add(sf.fileName);
		}
	}
	// Files removed from the program also count as a change — anyone who
	// listed them in `deps` is now affected.
	for (const prevName of Object.keys(prev.files)) {
		if (!currentHashes.has(prevName)) {
			changed.add(prevName);
		}
	}

	// Step 2: propagate. A file is affected if any of its prior deps
	// landed in `changed`. We use the prev session's dep list — if the
	// dep graph itself changed (file F gained or lost an import), F's
	// own content moved, so it's already in `changed` → propagating from
	// stale deps stays sound.
	for (const sf of sourceFiles) {
		if (affected.has(sf.fileName)) continue;
		const prevEntry = prev.files[sf.fileName];
		if (!prevEntry) continue; // already added above
		for (const dep of prevEntry.deps) {
			if (changed.has(dep)) {
				affected.add(sf.fileName);
				break;
			}
		}
	}

	return affected;
}
