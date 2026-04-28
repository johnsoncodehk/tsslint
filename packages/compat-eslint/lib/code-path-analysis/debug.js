"use strict";
// Stub for `require("debug")("eslint:code-path")`. CPA emits debug logs
// only when DEBUG env var includes the namespace; we never enable it
// from the compat path, so a no-op shim avoids pulling the `debug`
// package as a runtime dep.
const noop = () => {};
noop.enabled = false;
module.exports = () => noop;
