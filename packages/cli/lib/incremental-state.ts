// Layer 2 cross-session state. Wraps TypeScript's internal
// `getBuildInfo` / `createBuilderProgramUsingIncrementalBuildInfo`
// so two `tsslint --incremental` runs can share BuilderProgram state
// across processes via TS's own `tsBuildInfoFile` format.
//
// Why internal API: the public `BuilderProgram` interface only takes
// an `oldProgram` of type `SemanticDiagnosticsBuilderProgram` — there's
// no public path from disk back to BP. Manually serialising via
// `getAllDependencies` + content hash works (we shipped that in
// 68140be) but produces 17MB+ JSON on Dify-scale projects, drops
// node_modules tracking to fit, and uses content hashes where TS
// would use shape signatures. The internal route gives:
//   - shape signatures (smarter than content hash — body-only edits
//     don't propagate)
//   - bit-packed compact format (380 bytes for a 3-file program in
//     our spike, vs kilobytes manual)
//   - node_modules tracking included
//   - all the edge cases TS already debugged: ambient declarations,
//     module augmentations, lib changes, project references
//
// Risk surface:
//   - `getBuildInfo`, `createBuilderProgramUsingIncrementalBuildInfo`
//     are not in `typescript.d.ts`. They've been stable across TS
//     5.x → 6.x but no contract. Cache key already includes
//     `ts.version`, so version skew gives a clean miss instead of
//     corrupted state.
//   - On parse / shape mismatch, treat as cold start (the standard
//     "miss is always safe" invariant).

import type * as ts from 'typescript';

// Synthetic path used as the `tsBuildInfoFile` value passed to TS.
// TS uses this only to resolve relative paths inside the buildinfo
// payload — we never actually write here on disk; the buildinfo text
// is captured via the BuilderProgramHost's `writeFile` callback and
// stored in `IncrementalState.tsBuildInfoText`.
export const SYNTHETIC_BUILD_INFO_PATH = '/__tsslint__.tsbuildinfo';

// Hard cap on the captured buildinfo text length. The TS internal
// format is compact (~3.6MB on Dify's 5867 files), so 64MB leaves
// ~10–15× headroom on that scale — comfortably below V8's max string
// length and below the size where JSON.stringify of the surrounding
// cache object starts to feel sticky. If the cap fires we warn + skip
// persistence (cold start next session is preferable to a multi-second
// JSON serialise hit on every run).
const MAX_BUILD_INFO_BYTES = 64 * 1024 * 1024;

export interface IncrementalState {
	version: string;
	// Raw text TS wrote via `BuilderProgram.emitBuildInfo`. Opaque to
	// us — fed straight back to `ts.getBuildInfo` on the next session.
	tsBuildInfoText: string;
}

// Format version. Bump if we ever change what we store alongside
// `tsBuildInfoText`. The internal TS format itself is keyed on
// `ts.version` via the cache file's path component.
export const INCREMENTAL_STATE_VERSION = 'v3';

interface IncrementalAccess {
	getBuildInfo(file: string, text: string): unknown | undefined;
	createBuilderProgramUsingIncrementalBuildInfo(
		buildInfo: unknown,
		buildInfoPath: string,
		host: { useCaseSensitiveFileNames(): boolean; getCurrentDirectory(): string },
	): ts.BuilderProgram;
}

// Cast helper. Keeps the unsafe access concentrated and easy to find
// when TS upgrades.
export function asIncremental(ts: typeof import('typescript')): IncrementalAccess {
	return ts as unknown as IncrementalAccess;
}

// Warn the user that layer 2 cache is unavailable this session.
// Goes to stderr (yellow) so it doesn't interleave with the
// renderer's stdout output but stays visible by default. CI logs
// stderr by default; users who pipe stderr to /dev/null know what
// they signed up for.
//
// Each call site phrases its own reason — these are rare enough
// that we don't need rate-limiting. A single CLI invocation can
// emit at most one of each (load fails once at setup, save fails
// once at end-of-project).
function warn(msg: string): void {
	process.stderr.write('\x1b[93mwarn\x1b[0m  ' + msg + '\n');
}

// Reconstruct an old BuilderProgram from a previously captured
// `tsBuildInfoText`. Used as the `oldProgram` argument when creating
// the current session's BP. Returns undefined on any deserialization
// failure (cold-start fallback).
export function reconstructOldBuilder(
	ts: typeof import('typescript'),
	prev: IncrementalState | undefined,
	host: { useCaseSensitiveFileNames(): boolean; getCurrentDirectory(): string },
): ts.BuilderProgram | undefined {
	// Schema-version mismatch and "no prev cache" are normal cold-start
	// paths (e.g. cache invalidated by config change, or first run);
	// don't warn about either.
	if (!prev || prev.version !== INCREMENTAL_STATE_VERSION) return undefined;
	const api = asIncremental(ts);
	if (
		typeof api.getBuildInfo !== 'function'
		|| typeof api.createBuilderProgramUsingIncrementalBuildInfo !== 'function'
	) {
		warn(
			`TypeScript ${ts.version} is missing internal APIs `
				+ `(getBuildInfo / createBuilderProgramUsingIncrementalBuildInfo). `
				+ `Type-aware cache disabled — every type-aware rule will re-run from cold start.`,
		);
		return undefined;
	}
	try {
		const buildInfo = api.getBuildInfo(SYNTHETIC_BUILD_INFO_PATH, prev.tsBuildInfoText);
		if (!buildInfo) return undefined;
		return api.createBuilderProgramUsingIncrementalBuildInfo(
			buildInfo,
			SYNTHETIC_BUILD_INFO_PATH,
			host,
		);
	}
	catch (e) {
		warn(
			`Could not load previous incremental state on TypeScript ${ts.version}: `
				+ `${(e as Error).message}. Type-aware cache will rebuild from cold start.`,
		);
		return undefined;
	}
}

// Capture a `tsBuildInfoText` from a live BuilderProgram. Triggers a
// `BuilderProgram.emitBuildInfo` with a writeFile callback that
// intercepts what TS would otherwise write to disk.
//
// `emitBuildInfo` is on the runtime `BuilderProgram` shape but not in
// the public d.ts (the public surface only exposes the `emit()` family
// that wraps it). Cast through `unknown` to silence the type error;
// runtime is stable across TS 5.x → 6.x.
//
// On any failure (method missing on a future TS, or it threw), warn +
// return undefined. Caller persists no `incrementalState` for this
// session, which means next session starts cold for layer 2 — the
// layer-1 mtime cache still works. Wrong miss > wrong hit.
export function captureIncrementalState(
	tsVersion: string,
	builder: ts.BuilderProgram,
): IncrementalState | undefined {
	const builderAny = builder as unknown as {
		emitBuildInfo?(writeFile: (path: string, content: string) => void): void;
	};
	if (typeof builderAny.emitBuildInfo !== 'function') {
		warn(
			`TypeScript ${tsVersion} BuilderProgram is missing emitBuildInfo. `
				+ `Type-aware cache cannot be persisted — next run will start cold.`,
		);
		return undefined;
	}
	let captured: string | undefined;
	try {
		builderAny.emitBuildInfo((_path, content) => {
			captured = content;
		});
	}
	catch (e) {
		warn(
			`Could not persist incremental state on TypeScript ${tsVersion}: `
				+ `${(e as Error).message}. Type-aware cache cannot be persisted — next run will start cold.`,
		);
		return undefined;
	}
	if (!captured) return undefined;
	if (captured.length > MAX_BUILD_INFO_BYTES) {
		const mb = (captured.length / 1024 / 1024).toFixed(1);
		const capMb = MAX_BUILD_INFO_BYTES / 1024 / 1024;
		warn(
			`Incremental state too large (${mb}MB > ${capMb}MB cap). `
				+ `Type-aware cache cannot be persisted — next run will start cold.`,
		);
		return undefined;
	}
	return { version: INCREMENTAL_STATE_VERSION, tsBuildInfoText: captured };
}
