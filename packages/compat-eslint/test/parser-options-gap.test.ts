// Probe rules read `context.parserOptions.ecmaFeatures.{jsx,globalReturn,
// impliedStrict}` and the same fields under `context.languageOptions.
// parserOptions`. We derive these per-file from TS truth — jsx from the
// file extension, globalReturn from script-mode, impliedStrict from
// module-mode — so jsx-aware rules and strict-mode-gated rules see the
// right value without any caller config.
//
// These tests are a regression guard: they all pass today; if anyone
// strips the ecmaFeatures derivation in `runSharedTraversal` they'll
// fail. Run via:
//   tsc --build && node packages/compat-eslint/test/parser-options-gap.test.js

import type * as ESLint from 'eslint';
import * as ts from 'typescript';

const compat = require('../index.js') as typeof import('../index.js');

const failures: string[] = [];
function expect(name: string, actual: unknown, predicate: (v: unknown) => boolean, expectedDesc: string) {
	if (predicate(actual)) {
		process.stdout.write('.');
	}
	else {
		failures.push(`${name} — got ${JSON.stringify(actual)}, expected ${expectedDesc}`);
		process.stdout.write('F');
	}
}

// In-memory ts.Program. Same shape as compat-pipeline.test.ts; kept
// inline to avoid cross-test dep on a non-exported helper.
function buildProgram(
	code: string,
	kind: ts.ScriptKind,
): { program: ts.Program; file: ts.SourceFile } {
	const isJs = kind === ts.ScriptKind.JS || kind === ts.ScriptKind.JSX;
	const fileName = kind === ts.ScriptKind.TSX
		? '/test.tsx'
		: kind === ts.ScriptKind.JSX
		? '/test.jsx'
		: kind === ts.ScriptKind.JS
		? '/test.js'
		: '/test.ts';
	const sf = ts.createSourceFile(fileName, code, ts.ScriptTarget.Latest, true, kind);
	const realLibPath = ts.getDefaultLibFilePath({ target: ts.ScriptTarget.Latest });
	const realLibName = realLibPath.split(/[\\/]/).pop()!;
	const realLibContent = ts.sys.readFile(realLibPath) ?? '';
	const realLib = ts.createSourceFile(
		realLibPath,
		realLibContent,
		ts.ScriptTarget.Latest,
		true,
		ts.ScriptKind.TS,
	);
	const host: ts.CompilerHost = {
		getSourceFile: n => n === fileName ? sf : (n === realLibPath ? realLib : undefined),
		getDefaultLibFileName: () => realLibName,
		getDefaultLibLocation: () => realLibPath.replace('/' + realLibName, ''),
		writeFile: () => {},
		getCurrentDirectory: () => '/',
		getDirectories: () => [],
		fileExists: n => n === fileName || n === realLibPath,
		readFile: n => n === fileName ? code : (n === realLibPath ? realLibContent : undefined),
		getCanonicalFileName: n => n,
		useCaseSensitiveFileNames: () => true,
		getNewLine: () => '\n',
	};
	const program = ts.createProgram({
		rootNames: [fileName],
		options: {
			target: ts.ScriptTarget.Latest,
			lib: [realLibName],
			noEmit: true,
			allowJs: isJs || undefined,
			jsx: kind === ts.ScriptKind.TSX || kind === ts.ScriptKind.JSX
				? ts.JsxEmit.Preserve
				: undefined,
		},
		host,
	});
	return { program, file: sf };
}

// Run a probe rule that just snapshots `context.parserOptions` and
// `context.languageOptions` at create-time. Rule never reports.
function captureContext(
	code: string,
	kind: ts.ScriptKind,
): {
	parserOptions: any;
	languageOptions: any;
} {
	let captured: { parserOptions: any; languageOptions: any } = {
		parserOptions: undefined,
		languageOptions: undefined,
	};
	const probeRule: ESLint.Rule.RuleModule = {
		meta: { type: 'problem', schema: [], messages: { x: 'x' } } as any,
		create(ctx) {
			captured = {
				parserOptions: ctx.parserOptions,
				languageOptions: (ctx as any).languageOptions,
			};
			return { Program() {} };
		},
	};
	const tsslintRule = compat.convertRule(probeRule, [], { id: 'probe' });
	const reportFn: any = () => {
		const chain = {
			at() {
				return chain;
			},
			asWarning() {
				return chain;
			},
			asError() {
				return chain;
			},
			asSuggestion() {
				return chain;
			},
			withFix() {
				return chain;
			},
			withRefactor() {
				return chain;
			},
		};
		return chain;
	};
	const { program, file } = buildProgram(code, kind);
	tsslintRule({ file, report: reportFn, program } as any);
	return captured;
}

// === Test 1: ecmaFeatures.jsx must be true on .tsx ===
{
	const ctx = captureContext(`const x = <div/>;`, ts.ScriptKind.TSX);
	expect(
		'parserOptions.ecmaFeatures.jsx is true on .tsx',
		ctx.parserOptions?.ecmaFeatures?.jsx,
		v => v === true,
		'true',
	);
	expect(
		'languageOptions.parserOptions.ecmaFeatures.jsx is true on .tsx',
		ctx.languageOptions?.parserOptions?.ecmaFeatures?.jsx,
		v => v === true,
		'true',
	);
}

// === Test 2: ecmaFeatures.jsx must be falsy on .ts (non-JSX) ===
{
	const ctx = captureContext(`const x = 1;`, ts.ScriptKind.TS);
	expect(
		'parserOptions.ecmaFeatures.jsx is falsy on .ts',
		ctx.parserOptions?.ecmaFeatures?.jsx,
		v => !v,
		'falsy',
	);
}

// === Test 3: ecmaFeatures.impliedStrict is true for ESM module files ===
//   Per ECMAScript spec modules are strict-by-default. ESLint configs
//   that gate strict-mode-only checks read this field.
{
	const ctx = captureContext(`export const x = 1;`, ts.ScriptKind.TS);
	expect(
		'parserOptions.ecmaFeatures.impliedStrict is true on module file',
		ctx.parserOptions?.ecmaFeatures?.impliedStrict,
		v => v === true,
		'true',
	);
}

// === Test 4: ecmaFeatures.globalReturn for script-mode files ===
//   ESLint's `script` source type allows top-level `return` (CJS-style
//   "module function" wrapper); rules use this to permit/forbid global
//   `return`. Files with no module syntax under a `module: CommonJS`
//   tsconfig are 'script' in our classification.
{
	const ctx = captureContext(`var a = 1; console.log(a);`, ts.ScriptKind.TS);
	// We classify this as 'script' (no externalModuleIndicator,
	// no commonJsModuleIndicator). globalReturn should follow.
	expect(
		'parserOptions.ecmaFeatures.globalReturn is true on script file',
		ctx.parserOptions?.ecmaFeatures?.globalReturn,
		v => v === true,
		'true',
	);
}

// === Test 5: ecmaFeatures.globalReturn must be falsy on module files ===
{
	const ctx = captureContext(`export {};`, ts.ScriptKind.TS);
	expect(
		'parserOptions.ecmaFeatures.globalReturn is falsy on module file',
		ctx.parserOptions?.ecmaFeatures?.globalReturn,
		v => !v,
		'falsy',
	);
}

// === Test 6: parity between top-level and languageOptions paths ===
//   Rules read either `context.parserOptions` (legacy) or
//   `context.languageOptions.parserOptions` (modern flat-config). Both
//   surfaces must agree to avoid intra-rule disagreement.
{
	const ctx = captureContext(`const x = <div/>;`, ts.ScriptKind.TSX);
	const top = ctx.parserOptions?.ecmaFeatures;
	const lang = ctx.languageOptions?.parserOptions?.ecmaFeatures;
	expect(
		'parserOptions.ecmaFeatures and languageOptions.parserOptions.ecmaFeatures agree (.tsx)',
		JSON.stringify(top) === JSON.stringify(lang),
		v => v === true,
		'true (objects deep-equal)',
	);
}

// --- Summary ---
process.stdout.write('\n');
if (failures.length) {
	console.error(`\n${failures.length} failure(s):`);
	for (const f of failures) console.error('  - ' + f);
	process.exit(1);
}
console.log('All passed.');
