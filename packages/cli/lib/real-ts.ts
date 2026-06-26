// Captures the real `typescript` module reference BEFORE the tsgo facade
// installs its `Module._resolveFilename` hook. Imported at worker top-level
// so the cache entry is the genuine ts module; subsequent imports of this
// file from anywhere (including code that runs after the facade installs)
// receive the captured-at-load reference unchanged.
//
// Use this from any internal CLI code that needs real ts behaviour
// (parser, binder, scanner) — `require('typescript')` from those callsites
// would otherwise hit the facade and return the tsgo-shaped substitute.
import ts = require('typescript');
export = ts;
