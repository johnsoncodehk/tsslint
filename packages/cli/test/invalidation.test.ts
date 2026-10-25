// Invalidation tests against a stubbed TypeScript API, for program states
// that are hard to reproduce with a real project.
//
// Run via:
//   node packages/cli/test/invalidation.test.js

import fs = require('fs');
import os = require('os');
import path = require('path');
import { emptyCache } from '../lib/cache.js';
import { invalidate } from '../lib/invalidation.js';

const failures: string[] = [];
function check(name: string, cond: boolean, detail?: string) {
	if (cond) {
		process.stdout.write('.');
	}
	else {
		failures.push(name + (detail ? ' — ' + detail : ''));
		process.stdout.write('F');
	}
}

interface StubFile {
	text: string;
	imports: string[];
	declaration: string;
}

// `resolve` maps a module specifier to the file name the resolver returns;
// `getSourceFile` accepts every spelling in `aliases` like the program does.
function createStub(
	files: Map<string, StubFile>,
	resolve: (specifier: string) => string,
	aliases: Map<string, string>,
) {
	const call = <T extends unknown[], R>(fn: (...args: T) => R) =>
		Object.assign(fn, { gen: (...args: T) => ({ run: () => fn(...args) }) });
	const getSourceFile = call((fileName: string) => {
		const name = aliases.get(fileName) ?? fileName;
		const file = files.get(name);
		return file && {
			fileName: name,
			text: file.text,
			imports: file.imports.map(text => ({ text })),
			typeReferenceDirectives: [],
			referencedFiles: [],
			externalModuleIndicator: {},
			statements: [],
			moduleAugmentations: [],
			ambientModuleNames: [],
			isDeclarationFile: false,
		};
	});
	const program = {
		getCompilerOptions: () => ({}),
		getConfigFileNames: () => [],
		getSourceFileNames: () => [...files.keys()],
		getSourceFile,
		getResolvedModuleFromModuleSpecifier: call((specifier: { text: string }) => ({
			resolvedFileName: resolve(specifier.text),
		})),
		getResolvedTypeReferenceDirectiveFromTypeReferenceDirective: call(() => undefined),
		getDeclarationEmit: (fileNames: string[]) => ({
			outputFiles: new Map(fileNames.map(fileName => [
				fileName.replace(/\.ts$/, '.d.ts'),
				{ text: files.get(fileName)!.declaration, sourceFileName: fileName },
			])),
		}),
	};
	const api = {
		batch: (...requests: { run(): unknown }[]) => requests.map(request => request.run()),
	};
	return { api: api as any, project: { program } as any };
}

function bumpMtime(fileName: string) {
	const time = new Date(fs.statSync(fileName).mtimeMs + 2000);
	fs.utimesSync(fileName, time, time);
}

// ── Test 1: a resolved module spelled differently than the program file ─
//
// With project references through symlinked directories, the resolver can
// return a path (e.g. `/tmp/...`) for a file the program lists under
// another spelling (`/private/tmp/...`); the program's lookup accepts both.
// The importer must still depend on the file.
{
	const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tsslint-inv-alias-')));
	try {
		const a = path.join(dir, 'a.ts');
		const b = path.join(dir, 'b.ts');
		const aAlias = path.join(dir + '-alias', 'a.ts');
		fs.writeFileSync(a, 'export const x = 1;\n');
		fs.writeFileSync(b, `import { x } from 'a';\n`);
		const files = new Map<string, StubFile>([
			[a, { text: fs.readFileSync(a, 'utf8'), imports: [], declaration: 'export declare const x = 1;\n' }],
			[b, { text: fs.readFileSync(b, 'utf8'), imports: ['a'], declaration: 'export {};\n' }],
		]);
		const { api, project } = createStub(files, () => aAlias, new Map([[aAlias, a]]));

		const cache = emptyCache();
		invalidate(api, project, cache, '', new Map());
		check(
			'importer depends on the program spelling',
			cache.graph[b]?.deps.includes(a) === true,
			JSON.stringify(cache.graph[b]),
		);

		cache.files[a] = { hasFix: false, diagnostics: [], touched: {} };
		cache.files[b] = { hasFix: false, diagnostics: [], touched: {} };
		fs.writeFileSync(a, 'export const x = 2;\n');
		bumpMtime(a);
		files.get(a)!.declaration = 'export declare const x = 2;\n';
		invalidate(api, project, cache, '', new Map());
		check('signature change re-lints the importer', !cache.files[b]);
		check('signature change re-lints the file', !cache.files[a]);
	}
	finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
}

// ── Test 2: an import attribute is not a module specifier ──────────────
//
// `'import'` in `with { 'resolution-mode': 'import' }` must not start a
// side-effect import that spans to the next quote, which would leave an
// unknown specifier and count the signature as changed.
{
	const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tsslint-inv-attr-')));
	try {
		const b = path.join(dir, 'b.ts');
		const c = path.join(dir, 'c.ts');
		fs.writeFileSync(b, 'export const v = 1;\n');
		fs.writeFileSync(c, `import { v } from './b';\n`);
		const declaration = `import type * as A from 'a' with { 'resolution-mode': 'import' };\n`
			+ `import type { X } from 'x';\n`
			+ `export declare const v: A.T | X;\n`;
		const files = new Map<string, StubFile>([
			[b, { text: fs.readFileSync(b, 'utf8'), imports: ['a', 'x'], declaration }],
			[c, { text: fs.readFileSync(c, 'utf8'), imports: ['./b'], declaration: 'export {};\n' }],
		]);
		const resolve = (specifier: string) => specifier === './b' ? b : `/node_modules/${specifier}/index.d.ts`;
		const { api, project } = createStub(files, resolve, new Map());

		const cache = emptyCache();
		invalidate(api, project, cache, '', new Map());
		cache.files[b] = { hasFix: false, diagnostics: [], touched: {} };
		cache.files[c] = { hasFix: false, diagnostics: [], touched: {} };
		fs.writeFileSync(b, 'export const v = 2;\n');
		bumpMtime(b);
		invalidate(api, project, cache, '', new Map());
		check('body edit re-lints the file', !cache.files[b]);
		check('unchanged declaration with an import attribute keeps the importer', !!cache.files[c]);
	}
	finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
}

// b.ts's declaration names a.ts only through `reference`; when a.ts's
// signature changes, b.ts's declaration text stays the same, but c.ts,
// which imports b.ts, must be re-linted.
function checkReference(name: string, reference: string, declaration: string) {
	const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tsslint-inv-ref-')));
	try {
		const a = path.join(dir, 'a.ts');
		const b = path.join(dir, 'b.ts');
		const c = path.join(dir, 'c.ts');
		fs.writeFileSync(a, 'export const x = 1;\n');
		fs.writeFileSync(b, 'export {};\n');
		fs.writeFileSync(c, `import { v } from './b';\n`);
		const files = new Map<string, StubFile>([
			[a, { text: '', imports: [], declaration: 'export declare const x = 1;\n' }],
			[b, { text: '', imports: [reference], declaration }],
			[c, { text: '', imports: ['./b'], declaration: 'export {};\n' }],
		]);
		const { api, project } = createStub(files, specifier => specifier === './b' ? b : a, new Map());

		const cache = emptyCache();
		invalidate(api, project, cache, '', new Map());
		for (const fileName of [a, b, c]) {
			cache.files[fileName] = { hasFix: false, diagnostics: [], touched: {} };
		}
		fs.writeFileSync(a, 'export const x = 2;\n');
		bumpMtime(a);
		files.get(a)!.declaration = 'export declare const x = 2;\n';
		invalidate(api, project, cache, '', new Map());
		check(name, !cache.files[c]);
	}
	finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
}

// ── Test 3: an import type with attributes ─────────────────────────────
checkReference(
	'`import("./a", { with })` is a reference',
	'./a',
	`export declare const v: typeof import("./a", { with: { "resolution-mode": "import" } }).x;\n`,
);

// ── Test 4: a type reference with `resolution-mode` first ──────────────
checkReference(
	'`<reference resolution-mode types>` is a reference',
	'./a',
	`/// <reference resolution-mode="import" types="./a" />\nexport declare const v: number;\n`,
);

process.stdout.write('\n');
if (failures.length) {
	console.error(`\n${failures.length} failure(s):`);
	for (const f of failures) console.error('  - ' + f);
	process.exit(1);
}
console.log('OK');
