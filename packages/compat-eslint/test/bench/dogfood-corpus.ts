// Repo-relative paths for the dogfood corpus. All real production .ts
// files in the monorepo (excluding .d.ts, fixtures, tests, bench,
// node_modules, worktrees). Imported by:
//   - test/bench/dogfood.ts (rule-level parity diff)
//   - test/lazy-estree.test.ts (node-level structural parity sweep)
//
// Adding a new production file? Append the repo-relative path here and
// both consumers pick it up. The structural sweep is exhaustive over
// every TS node in every listed file — drift in any hand-written class's
// getter against typescript-estree's astMaps fails CI.
export const DOGFOOD_FILES = [
	'packages/cli/index.ts',
	'packages/cli/lib/cache.ts',
	'packages/cli/lib/colors.ts',
	'packages/cli/lib/fs-cache.ts',
	'packages/cli/lib/languagePlugins.ts',
	'packages/cli/lib/render.ts',
	'packages/cli/lib/worker.ts',
	'packages/compat-eslint/index.ts',
	'packages/compat-eslint/lib/lazy-estree.ts',
	'packages/compat-eslint/lib/selector-analysis.ts',
	'packages/compat-eslint/lib/tokens.ts',
	'packages/compat-eslint/lib/ts-ast-scan.ts',
	'packages/compat-eslint/lib/ts-scope-manager.ts',
	'packages/compat-eslint/lib/visitor-keys.ts',
	'packages/config/index.ts',
	'packages/config/lib/eslint-gen.ts',
	'packages/config/lib/eslint-types.ts',
	'packages/config/lib/eslint.ts',
	'packages/config/lib/plugins/category.ts',
	'packages/config/lib/plugins/diagnostics.ts',
	'packages/config/lib/plugins/ignore.ts',
	'packages/config/lib/tsl.ts',
	'packages/config/lib/tslint-gen.ts',
	'packages/config/lib/tslint-types.ts',
	'packages/config/lib/tslint.ts',
	'packages/config/lib/utils.ts',
	'packages/core/index.ts',
	'packages/types/index.ts',
	'packages/typescript-plugin/index.ts',
	'tsslint.config.ts',
] as const;
