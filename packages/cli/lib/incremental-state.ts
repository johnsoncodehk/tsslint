// Layer 2 cross-session state. Persists per-file content hashes and
// transitive dependency lists between `tsslint --incremental` runs so
// the next session can compute which files' type-relevant inputs have
// moved.
//
// Path interning: every unique file path is stored once in a `paths`
// table and referenced by integer index in deps lists. A naive
// representation balloons past V8's max string length on Dify-scale
// projects (5867 source files × hundreds of transitive deps each →
// multi-hundred-MB JSON). With interning, paths are written once and
// deps become number arrays — fits comfortably under any practical
// limit and serialises faster.
//
// Why not `.tsbuildinfo`? TS reads/writes it via `getProgramBuildInfo` /
// `createBuilderProgramUsingProgramBuildInfo`, both internal and TS-
// major-coupled. Going through public `BuilderProgram.getAllDependencies`
// + a content-hash digest trades some hit rate (we invalidate on body-
// only edits where TS's shape signatures wouldn't) for a contract that
// survives TS upgrades.

import type * as ts from 'typescript';

export interface IncrementalState {
	version: string;
	// Interned path table. Indices into this array are used in `files`
	// keys and `deps` values throughout the rest of the structure.
	paths: string[];
	// `files[i]` is the entry for the file at `paths[i]`. Sparse: only
	// indices for source files actually present in the program at save
	// time appear. Deps are indices into `paths` — typically a much
	// smaller integer payload than the full path strings repeated.
	files: Record</* pathIndex */ string, {
		contentHash: string;
		deps: number[];
	}>;
}

export const INCREMENTAL_STATE_VERSION = 'v2';

// Files we don't track. node_modules content changes after `pnpm install`
// / `npm install`, which users typically pair with `--force` or a fresh
// CI run. Tracking node_modules deps blows the JSON past V8's max string
// length even with path interning (Dify-scale: 16M dep refs → 80MB+).
// Lib files only change when `compilerOptions.lib` flips, already
// covered by the cache path key.
//
// The trade-off: a `pnpm install` that bumps `@types/*` between two
// `tsslint --incremental` runs serves stale type-aware results until
// the next `--force`. Acceptable for CLI use; documented in CACHE.md.
function isUserFile(sf: ts.SourceFile, program: ts.Program): boolean {
	if (program.isSourceFileDefaultLibrary(sf)) return false;
	if (sf.fileName.includes('/node_modules/')) return false;
	return true;
}

// Build a fresh state snapshot from a wrapped BuilderProgram, to save
// alongside the cache file. Called after the lint pass.
//
// Ambient `.d.ts` files (`declare global`, top-level declarations in
// script-mode `.d.ts`) don't show up in any specific file's
// `getAllDependencies` because no file explicitly imports them — they
// connect via global scope. To catch their edits, we treat every
// user-controlled script-mode `.d.ts` as a universal dep.
export function buildIncrementalState(
	builder: ts.BuilderProgram,
	hash: (s: string) => string,
): IncrementalState {
	const program = builder.getProgram();
	const sourceFiles = program.getSourceFiles().filter(sf => isUserFile(sf, program));

	// Build the path table — one entry per tracked user file. The index
	// of each file's path becomes its key in `files` and its identifier
	// in every dep list. node_modules / lib are excluded — see
	// `isUserFile` for rationale.
	const paths: string[] = [];
	const pathIndex = new Map<string, number>();
	for (const sf of sourceFiles) {
		const i = paths.length;
		paths.push(sf.fileName);
		pathIndex.set(sf.fileName, i);
	}

	// Detect script-mode .d.ts via `externalModuleIndicator`. Field is
	// internal in TS's public types but stable at runtime — used by
	// typescript-eslint and ts-morph for the same purpose.
	const ambientIndices: number[] = [];
	for (const sf of sourceFiles) {
		if (
			sf.isDeclarationFile
			&& !(sf as { externalModuleIndicator?: unknown }).externalModuleIndicator
		) {
			ambientIndices.push(pathIndex.get(sf.fileName)!);
		}
	}

	const files: IncrementalState['files'] = {};
	for (const sf of sourceFiles) {
		const idx = pathIndex.get(sf.fileName)!;
		const depSet = new Set<number>();
		// Filter transitive deps to user files only — node_modules deps
		// would explode the cache size (transitive @types/* alone runs
		// into millions of references on monorepo-scale projects).
		for (const d of builder.getAllDependencies(sf)) {
			const di = pathIndex.get(d);
			if (di !== undefined) depSet.add(di);
		}
		for (const a of ambientIndices) depSet.add(a);
		files[String(idx)] = {
			contentHash: hash(sf.text),
			deps: [...depSet],
		};
	}
	return { version: INCREMENTAL_STATE_VERSION, paths, files };
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

	// Resolve `prev.paths[idx]` lazily. Building a Map<path, idx> for
	// reverse lookup pays off: we hit it once per current source file
	// (to find prev entry) and once per dep index (to read current hash).
	const prevPathToIdx = new Map<string, number>();
	for (let i = 0; i < prev.paths.length; i++) {
		prevPathToIdx.set(prev.paths[i], i);
	}

	// Step 1: hash every current file. Track which prev indices have
	// content that moved — the propagation step uses this set.
	const currentHashes = new Map<string, string>();
	const changedPrevIdx = new Set<number>();
	for (const sf of sourceFiles) {
		const h = hash(sf.text);
		currentHashes.set(sf.fileName, h);
		const pi = prevPathToIdx.get(sf.fileName);
		if (pi === undefined) {
			// New file — no prior entry. Affected; nothing to record in
			// `changedPrevIdx` because no prev consumer could list it.
			affected.add(sf.fileName);
			continue;
		}
		const prevEntry = prev.files[String(pi)];
		if (!prevEntry || prevEntry.contentHash !== h) {
			changedPrevIdx.add(pi);
			affected.add(sf.fileName);
		}
	}
	// Files removed from the program also count as changed — anyone who
	// listed them in deps is now affected.
	for (let i = 0; i < prev.paths.length; i++) {
		if (!currentHashes.has(prev.paths[i])) {
			changedPrevIdx.add(i);
		}
	}

	// Step 2: propagate. A file is affected if any of its prior deps
	// (by index) landed in `changedPrevIdx`. We use the prev session's
	// dep list — if the dep graph itself changed (file F gained or lost
	// an import), F's own content moved, so F is already in `affected`
	// → propagating from stale deps stays sound.
	for (const sf of sourceFiles) {
		if (affected.has(sf.fileName)) continue;
		const pi = prevPathToIdx.get(sf.fileName);
		if (pi === undefined) continue; // already added
		const prevEntry = prev.files[String(pi)];
		if (!prevEntry) continue;
		for (const dep of prevEntry.deps) {
			if (changedPrevIdx.has(dep)) {
				affected.add(sf.fileName);
				break;
			}
		}
	}

	return affected;
}
