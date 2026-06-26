// Shared --tsgo / --tsgo-fast policy for CLI + worker.
//
// Multi-file projects auto-enable the fast path (skip disk cache,
// eager-prepare at setup). Single-file runs keep the normal path so
// per-file prepare overhead stays minimal. Override with --tsgo-fast or
// --no-tsgo-fast.

export function isTsgoEnabled(): boolean {
	return process.argv.includes('--tsgo');
}

export function isTsgoFastExplicit(): boolean {
	return process.argv.includes('--tsgo-fast');
}

export function isTsgoFastDisabled(): boolean {
	return process.argv.includes('--no-tsgo-fast');
}

/** Fast path when --tsgo and (explicit fast OR multi-file without opt-out). */
export function shouldTsgoFast(fileCount: number): boolean {
	if (!isTsgoEnabled()) return false;
	if (isTsgoFastDisabled()) return false;
	if (isTsgoFastExplicit()) return true;
	return fileCount > 1;
}
