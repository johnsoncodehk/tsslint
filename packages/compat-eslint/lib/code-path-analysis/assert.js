"use strict";
// Vendored from eslint/lib/shared/assert.js. Self-contained ok() throw.
function ok(value, message = "Assertion failed.") {
	if (!value) throw new Error(message);
}
module.exports = ok;
