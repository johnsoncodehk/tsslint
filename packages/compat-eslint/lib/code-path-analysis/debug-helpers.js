"use strict";
// No-op stub for ESLint's `debug-helpers.js`. The original (223 lines)
// only does work when `DEBUG=eslint:code-path` is set in the env, which
// we never enable from the compat path. Replacing with a no-op shim
// avoids parsing + JIT-compiling the original's DOT-graph / ESTree-
// node-to-string code on every cold start.
//
// All exported callables are no-ops. `enabled` matches `debug.enabled`
// (always false here) so `dumpState`'s caller-side `if (debug.enabled)`
// guards keep behaving like upstream.

const noop = () => {};

module.exports = {
	enabled: false,
	dump: noop,
	dumpState: noop,
	dumpDot: noop,
};
