// Shared --tsgo / --tsgo-fast policy for CLI + worker.
//
// Two independent knobs:
//   - skip disk cache (layer-1) on multi-file --tsgo runs
//   - eager prepareFile all roots at setup (explicit --tsgo-fast only)
//
// Auto "fast" previously bundled both; eager-prepare on ~59-file full
// runs regressed wall time vs lazy per-file prepare.

export function isTsgoEnabled(): boolean {
	return process.argv.includes('--tsgo');
}

export function isTsgoFastExplicit(): boolean {
	return process.argv.includes('--tsgo-fast');
}

export function isTsgoFastDisabled(): boolean {
	return process.argv.includes('--no-tsgo-fast');
}

/** Skip layer-1 disk cache when --tsgo on multi-file projects. */
export function shouldTsgoSkipDiskCache(fileCount: number): boolean {
	if (!isTsgoEnabled()) return false;
	if (isTsgoFastDisabled()) return false;
	if (isTsgoFastExplicit()) return true;
	return fileCount > 1;
}

/** Eager prepareFile every root at setup — opt-in via --tsgo-fast. */
export function shouldTsgoEagerPrepare(_fileCount: number): boolean {
	if (!isTsgoEnabled()) return false;
	if (isTsgoFastDisabled()) return false;
	return isTsgoFastExplicit();
}

/** @deprecated alias — use shouldTsgoSkipDiskCache */
export function shouldTsgoFast(fileCount: number): boolean {
	return shouldTsgoSkipDiskCache(fileCount);
}

/** Hold JS-side binds until project dispose instead of per-file release. */
export function shouldTsgoDeferFileRelease(fileCount: number): boolean {
	if (!isTsgoEnabled()) return false;
	// Large monorepos (Dify-scale) still stream releases to cap RSS.
	return fileCount <= 512;
}
