// Compares TsScopeManager against @typescript-eslint/scope-manager on focused
// fixtures. Run via: node --experimental-strip-types --no-warnings packages/compat-eslint/test/scope-compat.test.ts
//
// Output format: one block per fixture, listing differences in scope shape.
// A clean fixture prints "OK". Exit code is non-zero if any fixture diffs.

import * as ts from 'typescript';
import type { TsScope } from '../lib/ts-scope-manager.js';
const { TsScopeManager } = require('../lib/ts-scope-manager.js') as typeof import('../lib/ts-scope-manager.js');

const { astConverter } = require('@typescript-eslint/typescript-estree/use-at-your-own-risk');
const { analyze } = require('@typescript-eslint/scope-manager');
const { visitorKeys } = require('@typescript-eslint/visitor-keys');

const PARSE_SETTINGS = {
	allowInvalidAST: false,
	comment: true,
	errorOnUnknownASTType: false,
	loc: true,
	range: true,
	suppressDeprecatedPropertyWarnings: true,
	tokens: true,
};

interface Fixture {
	name: string;
	code: string;
	sourceType?: 'module' | 'script';
}

const fixtures: Fixture[] = [
	{
		name: 'simple-var-let-const',
		code: `
			var a = 1;
			let b = 2;
			const c = 3;
			console.log(a, b, c);
		`,
	},
	{
		name: 'block-scope-let',
		code: `
			if (true) {
				let inner = 1;
				console.log(inner);
			}
		`,
	},
	{
		name: 'block-scope-var-hoist',
		code: `
			function f() {
				if (true) {
					var x = 1; // hoisted to function scope
				}
				return x;
			}
		`,
	},
	{
		name: 'function-decl-and-params',
		code: `
			function add(a: number, b: number) {
				return a + b;
			}
			add(1, 2);
		`,
	},
	{
		name: 'arrow-function',
		code: `
			const sq = (n: number) => n * n;
			sq(4);
		`,
	},
	{
		name: 'function-expression-name',
		code: `
			const fn = function named() {
				return named;
			};
		`,
	},
	{
		name: 'class-with-methods',
		code: `
			class Box<T> {
				value: T;
				constructor(v: T) { this.value = v; }
				get() { return this.value; }
			}
			new Box(1).get();
		`,
	},
	{
		name: 'for-loop',
		code: `
			for (let i = 0; i < 10; i++) {
				const x = i * 2;
				console.log(x);
			}
		`,
	},
	{
		name: 'for-of',
		code: `
			for (const item of [1, 2, 3]) {
				console.log(item);
			}
		`,
	},
	{
		name: 'try-catch',
		code: `
			try { throw new Error('x'); } catch (e) { console.log(e); }
		`,
	},
	{
		name: 'destructuring',
		code: `
			const { a, b: renamed } = { a: 1, b: 2 };
			const [first, ...rest] = [1, 2, 3];
			console.log(a, renamed, first, rest);
		`,
	},
	{
		name: 'shadowing',
		code: `
			const x = 1;
			function f() {
				const x = 2;
				return x;
			}
		`,
	},
	{
		name: 'enum',
		code: `
			enum Color { Red, Green, Blue }
			const c = Color.Red;
			console.log(c);
		`,
	},
	{
		name: 'namespace',
		code: `
			namespace N {
				export const value = 1;
			}
			console.log(N.value);
		`,
	},
	{
		name: 'type-alias-and-interface',
		code: `
			type ID = string;
			interface User { id: ID; name: string; }
			const u: User = { id: 'x', name: 'y' };
			console.log(u);
		`,
	},
	{
		name: 'import-binding',
		code: `
			import { foo, bar as renamed } from 'somewhere';
			import * as ns from 'other';
			console.log(foo, renamed, ns);
		`,
		sourceType: 'module',
	},
	{
		name: 'unused-var',
		code: `
			let used = 1;
			let unused = 2;
			console.log(used);
		`,
	},
	{
		name: 'reassign-let',
		code: `
			let counter = 0;
			counter += 1;
			counter++;
			console.log(counter);
		`,
	},
];

function makeProgram(code: string): { program: ts.Program; sourceFile: ts.SourceFile; } {
	const fileName = '/test.ts';
	const sourceFile = ts.createSourceFile(fileName, code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
	const realLibPath = ts.getDefaultLibFilePath({ target: ts.ScriptTarget.Latest });
	const realLibName = realLibPath.split(/[\\/]/).pop()!;
	const realLibContent = ts.sys.readFile(realLibPath) ?? '';
	const realLib = ts.createSourceFile(realLibPath, realLibContent, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
	const host: ts.CompilerHost = {
		getSourceFile(n) {
			if (n === fileName) return sourceFile;
			if (n === realLibPath) return realLib;
			return undefined;
		},
		getDefaultLibFileName: () => realLibName,
		getDefaultLibLocation: () => realLibPath.replace('/' + realLibName, ''),
		writeFile: () => {},
		getCurrentDirectory: () => '/',
		getDirectories: () => [],
		fileExists: (n) => n === fileName || n === realLibPath,
		readFile: (n) => n === fileName ? code : (n === realLibPath ? realLibContent : undefined),
		getCanonicalFileName: (n) => n,
		useCaseSensitiveFileNames: () => true,
		getNewLine: () => '\n',
	};
	const program = ts.createProgram({
		rootNames: [fileName],
		options: { target: ts.ScriptTarget.Latest, module: ts.ModuleKind.ESNext, allowJs: false, noLib: false },
		host,
	});
	return { program, sourceFile: program.getSourceFile(fileName)! };
}

function names(arr: { name: string; }[]): string {
	return arr.map(v => v.name).sort().join(',');
}

function runFixture(fx: Fixture): string[] {
	const { program, sourceFile } = makeProgram(fx.code);
	const { estree, astMaps } = astConverter(sourceFile, PARSE_SETTINGS, true);
	const sourceType = fx.sourceType ?? 'module';
	estree.sourceType = sourceType;
	// `lib: []` keeps upstream's globalScope from being populated with all the
	// TS lib intrinsics — those don't exist in our `node.locals` view, so
	// comparing them just spams noise.
	const upstream = analyze(estree, { sourceType, childVisitorKeys: visitorKeys, lib: [] });
	const ours = new TsScopeManager(sourceFile, program, estree, astMaps, sourceType);
	const diffs: string[] = [];

	// Walk both scope trees in parallel. They should be isomorphic (same shape,
	// same type-and-block at each position). We compare scope-by-scope and
	// recurse into children pairwise.
	let idx = 0;
	const visit = (uScope: any, oScope: TsScope | null) => {
		const i = idx++;
		const blockTag = uScope.block ? `${uScope.block.type}:${uScope.block.range[0]}-${uScope.block.range[1]}` : 'no-block';
		const tag = `[scope#${i} ${uScope.type} @${blockTag}]`;
		if (!oScope) {
			diffs.push(`${tag} ours has no matching scope (tree out of sync)`);
			return;
		}
		if (oScope.type !== uScope.type) {
			diffs.push(`${tag} type: upstream=${uScope.type} ours=${oScope.type}`);
		}
		const skipVars = uScope.type === 'global' || uScope.type === 'module';
		if (!skipVars) {
			const uVarNames = names(uScope.variables);
			const oVarNames = names(oScope.variables);
			if (uVarNames !== oVarNames) {
				diffs.push(`${tag} variables: upstream=[${uVarNames}] ours=[${oVarNames}]`);
			}
		}
		for (const uVar of uScope.variables) {
			const oVar = oScope.variables.find((v: any) => v.name === uVar.name);
			if (!oVar) continue;
			const uRefCount = uVar.references.length;
			const oRefCount = oVar.references.length;
			if (oRefCount < uRefCount) {
				diffs.push(
					`${tag} var '${uVar.name}' references: upstream=${uRefCount} ours=${oRefCount} (missing)`,
				);
			}
			if (uVar.writeable !== undefined && uVar.writeable !== oVar.writeable) {
				diffs.push(
					`${tag} var '${uVar.name}' writeable: upstream=${uVar.writeable} ours=${oVar.writeable}`,
				);
			}
		}
		const uChildren = uScope.childScopes ?? [];
		const oChildren = oScope.childScopes ?? [];
		if (uChildren.length !== oChildren.length) {
			diffs.push(`${tag} childScopes count: upstream=${uChildren.length} ours=${oChildren.length}`);
		}
		const n = Math.min(uChildren.length, oChildren.length);
		for (let j = 0; j < n; j++) visit(uChildren[j], oChildren[j]);
	};
	if (upstream.globalScope) visit(upstream.globalScope, ours.globalScope);

	return diffs;
}

let totalDiffs = 0;
let totalPassed = 0;
for (const fx of fixtures) {
	console.log(`\n--- ${fx.name} ---`);
	try {
		const diffs = runFixture(fx);
		if (diffs.length === 0) {
			console.log('  OK');
			totalPassed++;
		}
		else {
			totalDiffs += diffs.length;
			for (const d of diffs) console.log('  DIFF: ' + d);
		}
	}
	catch (err) {
		totalDiffs++;
		console.log('  ERROR: ' + (err instanceof Error ? err.message : String(err)));
	}
}

console.log(`\n=== ${totalPassed}/${fixtures.length} fixtures clean, ${totalDiffs} diffs ===`);
process.exit(totalDiffs > 0 ? 1 : 0);
