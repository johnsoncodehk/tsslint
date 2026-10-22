// Test-only reference implementation for @tsslint/compat-eslint parity
// tests. typescript-eslint has no TypeScript 7 support, so the upstream
// ESTree converter and parser run here on their own TypeScript 6 copy.
// Nothing in the published packages depends on this.
module.exports = {
	get ts() {
		return require('typescript');
	},
	get typescriptEstree() {
		return require('@typescript-eslint/typescript-estree');
	},
	get typescriptEstreeInternals() {
		return require('@typescript-eslint/typescript-estree/use-at-your-own-risk');
	},
	get parser() {
		return require('@typescript-eslint/parser');
	},
	get visitorKeys() {
		return require('@typescript-eslint/visitor-keys');
	},
	get eslint() {
		return require('eslint');
	},
};
