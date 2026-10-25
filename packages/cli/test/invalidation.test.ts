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

process.stdout.write('\n');
if (failures.length) {
	console.error(`\n${failures.length} failure(s):`);
	for (const f of failures) console.error('  - ' + f);
	process.exit(1);
}
console.log('OK');
