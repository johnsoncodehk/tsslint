"use strict";
// Vendored subset of eslint/lib/shared/ast-utils.js. CPA only reads
// `breakableTypePattern` to decide which kinds break out of loops /
// switches; the regex itself is the entire dependency.
exports.breakableTypePattern = /^(?:(?:Do)?While|For(?:In|Of)?|Switch)Statement$/u;
