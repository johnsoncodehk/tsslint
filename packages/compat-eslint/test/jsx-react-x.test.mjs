// End-to-end parity test: compat-eslint vs ESLint Linter
// running `eslint-plugin-react-x/no-leaked-conditional-rendering`
// over a TSX fixture that exercises the type-aware leak detection.
//
// Why a separate .mjs file: eslint-plugin-react-x is ESM-only with a
// strict `exports` field, so it can't be `require()`'d from the
// compiled .test.js files. Run via:
//   node packages/compat-eslint/test/jsx-react-x.test.mjs

import { default as plugin } from 'eslint-plugin-react-x';
import { Linter } from 'eslint';
import * as ts from 'typescript';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const compat = require('../index.js');
const tsParser = require('@typescript-eslint/parser');

const ruleId = 'no-leaked-conditional-rendering';
const rules = plugin.rules || plugin.default?.rules || {};
const rule = rules[ruleId];
if (!rule) {
	console.error(`rule "${ruleId}" not found in eslint-plugin-react-x`);
	process.exit(1);
}

const fileName = process.cwd() + '/test.tsx';
const code = `\
function A({ count }: { count: number }) {
	return <div>{count && <span>x</span>}</div>;
}
function B({ name }: { name: string }) {
	return <div>{name && <span>x</span>}</div>;
}
function C({ flag }: { flag: boolean }) {
	return <div>{flag && <span>x</span>}</div>;
}
function D({ items }: { items: string[] }) {
	return <div>{items.length && <span>x</span>}</div>;
}
function E({ on }: { on: 0 | 1 }) {
	return <div>{on && <span>x</span>}</div>;
}
function F({ s }: { s: string | undefined }) {
	return <div>{s && <span>x</span>}</div>;
}
function G({ obj }: { obj: { x: number } | null }) {
	return <div>{obj && <span>x</span>}</div>;
}
function H({ arr }: { arr: number[] }) {
	return <div>{arr.length > 0 && <span>x</span>}</div>;
}
function I({ x }: { x: bigint }) {
	return <div>{x && <span>x</span>}</div>;
}
function J() {
	const v = NaN;
	return <div>{v && <span>x</span>}</div>;
}
`;

// --- ts.Program ---
const sf = ts.createSourceFile(fileName, code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const realLibPath = ts.getDefaultLibFilePath({ target: ts.ScriptTarget.Latest });
const realLibName = realLibPath.split(/[\\/]/).pop();
const realLibContent = ts.sys.readFile(realLibPath) ?? '';
const realLib = ts.createSourceFile(realLibPath, realLibContent, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
const host = {
	getSourceFile: n => (n === fileName ? sf : n === realLibPath ? realLib : undefined),
	getDefaultLibFileName: () => realLibName,
	getDefaultLibLocation: () => realLibPath.replace('/' + realLibName, ''),
	writeFile: () => {},
	getCurrentDirectory: () => '/',
	getDirectories: () => [],
	fileExists: n => n === fileName || n === realLibPath,
	readFile: n => (n === fileName ? code : n === realLibPath ? realLibContent : undefined),
	getCanonicalFileName: n => n,
	useCaseSensitiveFileNames: () => true,
	getNewLine: () => '\n',
};
const program = ts.createProgram({
	rootNames: [fileName],
	options: {
		target: ts.ScriptTarget.Latest,
		lib: [realLibName],
		jsx: ts.JsxEmit.Preserve,
		noEmit: true,
		strict: true,
	},
	host,
});

// --- compat-eslint side ---
const tsslintRule = compat.convertRule(rule, [], { id: ruleId });
const compatReports = [];
let compatError = null;
const noopReporter = {
	at() { return this; },
	asWarning() { return this; },
	asError() { return this; },
	asSuggestion() { return this; },
	withDeprecated() { return this; },
	withUnnecessary() { return this; },
	withFix() { return this; },
	withRefactor() { return this; },
	withoutCache() { return this; },
};
try {
	tsslintRule({
		typescript: ts,
		program,
		file: sf,
		report(message, start, end) {
			const startLC = sf.getLineAndCharacterOfPosition(start);
			const endLC = sf.getLineAndCharacterOfPosition(end);
			compatReports.push({
				key: `${startLC.line + 1}:${startLC.character + 1}-${endLC.line + 1}:${endLC.character + 1}`,
				message,
			});
			return noopReporter;
		},
	});
}
catch (e) {
	compatError = e;
}

// --- ESLint Linter side ---
const linter = new Linter({ configType: 'flat' });
const eslintMessages = linter.verify(code, [{
	files: ['**/*.tsx'],
	languageOptions: {
		parser: tsParser,
		parserOptions: {
			ecmaVersion: 2022,
			sourceType: 'module',
			ecmaFeatures: { jsx: true },
			programs: [program],
			project: false,
			filePath: fileName,
		},
	},
	plugins: { 'react-x': plugin },
	rules: { ['react-x/' + ruleId]: 'error' },
}], fileName);

// surface non-rule diagnostics (parse / config errors)
for (const m of eslintMessages) {
	if (m.ruleId !== 'react-x/' + ruleId) {
		console.log('  [linter-msg]', m.severity, m.ruleId ?? '(parse)', '|', String(m.message).slice(0, 160));
	}
}
const eslintReports = eslintMessages
	.filter(m => m.ruleId === 'react-x/' + ruleId)
	.map(m => ({
		key: `${m.line}:${m.column}-${m.endLine ?? m.line}:${m.endColumn ?? m.column}`,
		message: m.message,
	}));

// --- Diff ---
const compatKeys = new Set(compatReports.map(r => r.key));
const eslintKeys = new Set(eslintReports.map(r => r.key));
const onlyCompat = [...compatKeys].filter(k => !eslintKeys.has(k));
const onlyEslint = [...eslintKeys].filter(k => !compatKeys.has(k));

if (compatError) {
	console.log('compat-eslint: THREW ' + (compatError.name || 'Error'));
	console.log('  message:', String(compatError.message).split('\n')[0]);
}
else {
	console.log(`compat-eslint: ${compatReports.length} report(s)`);
	for (const r of compatReports.sort((a, b) => a.key.localeCompare(b.key))) {
		console.log('  [compat]', r.key, '|', r.message.slice(0, 100));
	}
}
console.log(`ESLint Linter: ${eslintReports.length} report(s)`);
for (const r of eslintReports.sort((a, b) => a.key.localeCompare(b.key))) {
	console.log('  [eslint]', r.key, '|', r.message.slice(0, 100));
}

if (compatError) {
	console.log('\nFAIL: compat-eslint cannot run this rule (JSX coverage gap)');
	process.exit(2);
}
if (onlyCompat.length === 0 && onlyEslint.length === 0) {
	console.log('\nPARITY ✓');
	process.exit(0);
}
else {
	console.log('\nMISMATCH');
	if (onlyCompat.length) console.log('  only in compat:', onlyCompat);
	if (onlyEslint.length) console.log('  only in eslint:', onlyEslint);
	process.exit(1);
}
