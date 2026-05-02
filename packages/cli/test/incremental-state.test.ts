// Tests for the layer 2 cross-session diff. Given a stored
// `IncrementalState` from a prior session and a current Program, the
// `computeAffectedFiles` function should return the set of files whose
// type-relevant inputs (own content, transitive deps incl. ambient
// `.d.ts`) have changed.
//
// Run via:
//   node packages/cli/test/incremental-state.test.js

import * as ts from 'typescript';
import type { IncrementalState } from '../lib/incremental-state.js';

const inc = require('../lib/incremental-state.js') as typeof import('../lib/incremental-state.js');

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

// Trivial deterministic hash for tests — we just need stable+collision-free
// for the strings we throw at it.
function fakeHash(s: string): string {
	let h = 0;
	for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
	return String(h);
}

// Build a minimal Program from in-memory file map. Lib not needed for
// these tests — we only exercise getSourceFiles / sf.fileName / sf.text.
function buildProgram(files: Record<string, string>): ts.Program {
	const realLibPath = ts.getDefaultLibFilePath({ target: ts.ScriptTarget.Latest });
	const realLibContent = ts.sys.readFile(realLibPath) ?? '';
	const realLib = ts.createSourceFile(realLibPath, realLibContent, ts.ScriptTarget.Latest, true);
	const sourceFiles = new Map<string, ts.SourceFile>();
	for (const [name, text] of Object.entries(files)) {
		sourceFiles.set(name, ts.createSourceFile(name, text, ts.ScriptTarget.Latest, true));
	}
	const host: ts.CompilerHost = {
		getSourceFile: n => sourceFiles.get(n) ?? (n === realLibPath ? realLib : undefined),
		getDefaultLibFileName: () => realLibPath,
		writeFile: () => {},
		getCurrentDirectory: () => '/',
		getDirectories: () => [],
		fileExists: n => sourceFiles.has(n) || n === realLibPath,
		readFile: n => files[n] ?? (n === realLibPath ? realLibContent : undefined),
		getCanonicalFileName: n => n,
		useCaseSensitiveFileNames: () => true,
		getNewLine: () => '\n',
	};
	return ts.createProgram({
		rootNames: [...sourceFiles.keys()],
		options: { target: ts.ScriptTarget.Latest, noEmit: true, lib: [realLibPath.split(/[\\/]/).pop()!] },
		host,
	});
}

// ── Test 1: no prior state → all source files are affected ──────────────
{
	const program = buildProgram({ '/a.ts': 'const x = 1;', '/b.ts': 'const y = 2;' });
	const affected = inc.computeAffectedFiles(undefined, program, fakeHash);
	check('a.ts affected (no prev state)', affected.has('/a.ts'));
	check('b.ts affected (no prev state)', affected.has('/b.ts'));
}

// ── Test 2: state version mismatch → all affected ───────────────────────
{
	const program = buildProgram({ '/a.ts': 'const x = 1;' });
	const stale: IncrementalState = {
		version: 'v0',
		files: { '/a.ts': { contentHash: fakeHash('const x = 1;'), deps: ['/a.ts'] } },
	} as any;
	const affected = inc.computeAffectedFiles(stale, program, fakeHash);
	check('schema bump → all affected', affected.has('/a.ts'));
}

// ── Test 3: identical state → no user files affected ────────────────────
//
// lib.*.d.ts files would also be in `program.getSourceFiles()`. For the
// "everything matches" check we mirror that into prev too.
{
	const program = buildProgram({ '/a.ts': 'const x = 1;', '/b.ts': 'const y = 2;' });
	const prev: IncrementalState = {
		version: inc.INCREMENTAL_STATE_VERSION,
		files: Object.fromEntries(
			program.getSourceFiles().map(sf => [sf.fileName, {
				contentHash: fakeHash(sf.text),
				deps: [sf.fileName],
			}]),
		),
	};
	const affected = inc.computeAffectedFiles(prev, program, fakeHash);
	check('a.ts NOT affected (hash matches)', !affected.has('/a.ts'));
	check('b.ts NOT affected (hash matches)', !affected.has('/b.ts'));
	check('no user file affected', !affected.has('/a.ts') && !affected.has('/b.ts'));
}

// ── Test 4: file content changed → only that file in affected ───────────
//
// b.ts has /a.ts in its deps. a.ts unchanged. b.ts content changed.
// Only b.ts is affected.
{
	const program = buildProgram({
		'/a.ts': 'const x = 1;',
		'/b.ts': 'const y = 99;',
	});
	const prev: IncrementalState = {
		version: inc.INCREMENTAL_STATE_VERSION,
		files: {
			'/a.ts': { contentHash: fakeHash('const x = 1;'), deps: ['/a.ts'] },
			'/b.ts': { contentHash: fakeHash('const y = 2;'), deps: ['/a.ts', '/b.ts'] },
		},
	};
	const affected = inc.computeAffectedFiles(prev, program, fakeHash);
	check('b.ts affected (own content changed)', affected.has('/b.ts'));
	check('a.ts NOT affected (unchanged)', !affected.has('/a.ts'));
}

// ── Test 5: dep file changed → all consumers affected ───────────────────
//
// The killer case for layer 2: editing globals.d.ts (or any ambient file)
// must propagate to every file that listed it as a dep. That's what
// per-file mtime caching can't catch.
{
	const program = buildProgram({
		'/globals.d.ts': 'declare const FOO: string;',  // changed from `: number;`
		'/use1.ts': 'const a = FOO;',
		'/use2.ts': 'const b = FOO;',
		'/standalone.ts': 'const c = 42;',
	});
	const prev: IncrementalState = {
		version: inc.INCREMENTAL_STATE_VERSION,
		files: {
			'/globals.d.ts': { contentHash: fakeHash('declare const FOO: number;'), deps: ['/globals.d.ts'] },
			'/use1.ts': { contentHash: fakeHash('const a = FOO;'), deps: ['/globals.d.ts', '/use1.ts'] },
			'/use2.ts': { contentHash: fakeHash('const b = FOO;'), deps: ['/globals.d.ts', '/use2.ts'] },
			'/standalone.ts': { contentHash: fakeHash('const c = 42;'), deps: ['/standalone.ts'] },
		},
	};
	const affected = inc.computeAffectedFiles(prev, program, fakeHash);
	check('globals.d.ts affected (own change)', affected.has('/globals.d.ts'));
	check('use1.ts affected (dep changed)', affected.has('/use1.ts'));
	check('use2.ts affected (dep changed)', affected.has('/use2.ts'));
	check(
		'standalone.ts NOT affected (no globals.d.ts in deps)',
		!affected.has('/standalone.ts'),
	);
}

// ── Test 6: new file (in current, not prev) → affected ──────────────────
{
	const program = buildProgram({
		'/old.ts': 'const o = 1;',
		'/new.ts': 'const n = 2;',
	});
	const prev: IncrementalState = {
		version: inc.INCREMENTAL_STATE_VERSION,
		files: {
			'/old.ts': { contentHash: fakeHash('const o = 1;'), deps: ['/old.ts'] },
		},
	};
	const affected = inc.computeAffectedFiles(prev, program, fakeHash);
	check('new.ts affected (newly added)', affected.has('/new.ts'));
	check('old.ts NOT affected (unchanged)', !affected.has('/old.ts'));
}

// ── Test 7: removed file → its consumers are affected ───────────────────
//
// /removed.ts is gone. /still-here.ts had it in deps. The consumer
// must re-check because its type info may have changed (import error,
// missing export, etc.).
{
	const program = buildProgram({
		'/still-here.ts': 'const z = 3;',
	});
	const prev: IncrementalState = {
		version: inc.INCREMENTAL_STATE_VERSION,
		files: {
			'/removed.ts': { contentHash: fakeHash('export const r = 1;'), deps: ['/removed.ts'] },
			'/still-here.ts': { contentHash: fakeHash('const z = 3;'), deps: ['/removed.ts', '/still-here.ts'] },
		},
	};
	const affected = inc.computeAffectedFiles(prev, program, fakeHash);
	check(
		'still-here.ts affected (dep removed)',
		affected.has('/still-here.ts'),
		'consumer must re-check when a transitive dep disappears',
	);
}

// ── Test 8: hash collision in deps doesn't false-positive ───────────────
//
// File A has dep file C. C is unchanged. A's content unchanged. Even
// though something else (D) changed, A is unaffected.
{
	const program = buildProgram({
		'/a.ts': 'const x = 1;',
		'/c.ts': 'const c = 1;',
		'/d.ts': 'const d = 99;',  // changed
	});
	const prev: IncrementalState = {
		version: inc.INCREMENTAL_STATE_VERSION,
		files: {
			'/a.ts': { contentHash: fakeHash('const x = 1;'), deps: ['/c.ts', '/a.ts'] },
			'/c.ts': { contentHash: fakeHash('const c = 1;'), deps: ['/c.ts'] },
			'/d.ts': { contentHash: fakeHash('const d = 1;'), deps: ['/d.ts'] },
		},
	};
	const affected = inc.computeAffectedFiles(prev, program, fakeHash);
	check('a.ts NOT affected (deps unchanged, own unchanged)', !affected.has('/a.ts'));
	check('d.ts affected (own content changed)', affected.has('/d.ts'));
	check('c.ts NOT affected', !affected.has('/c.ts'));
}

// ── Done ────────────────────────────────────────────────────────────────
process.stdout.write('\n');
if (failures.length) {
	console.error(`\n${failures.length} failure(s):`);
	for (const f of failures) console.error('  - ' + f);
	process.exit(1);
}
console.log('OK');
