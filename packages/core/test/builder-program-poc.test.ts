// POC for layer 2 of the cache rebuild — verify that
// `ts.createSemanticDiagnosticsBuilderProgram` can wrap the program
// owned by `ts.createLanguageService` without double-building, and
// that affected-file iteration correctly identifies which files'
// type-relevant inputs have changed since the previous pass.
//
// This is the integration risk flagged in CACHE.md item 7. Validate
// in isolation before wiring through the CLI.
//
// Run via:
//   node packages/core/test/builder-program-poc.test.js

import * as ts from 'typescript';

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

// In-memory file system the LanguageServiceHost reads from. Tests
// mutate `files`/`versions` to simulate file edits.
const files: Record<string, string> = {};
const versions: Record<string, number> = {};
function write(name: string, text: string) {
	files[name] = text;
	versions[name] = (versions[name] ?? 0) + 1;
}

const realLibPath = ts.getDefaultLibFilePath({ target: ts.ScriptTarget.Latest });
const realLibContent = ts.sys.readFile(realLibPath) ?? '';
let projectVersion = 0;

const host: ts.LanguageServiceHost = {
	getCompilationSettings: () => ({
		target: ts.ScriptTarget.Latest,
		noEmit: true,
		lib: [realLibPath.split(/[\\/]/).pop()!],
	}),
	getScriptFileNames: () => Object.keys(files),
	getScriptVersion: n => String(versions[n] ?? 0),
	getScriptSnapshot: n => {
		if (n in files) return ts.ScriptSnapshot.fromString(files[n]);
		if (n === realLibPath) return ts.ScriptSnapshot.fromString(realLibContent);
		return undefined;
	},
	getCurrentDirectory: () => '/',
	getDefaultLibFileName: () => realLibPath,
	fileExists: n => n in files || n === realLibPath,
	readFile: n => (n in files ? files[n] : (n === realLibPath ? realLibContent : undefined)),
	getProjectVersion: () => String(projectVersion),
};

const languageService = ts.createLanguageService(host);

// Iterate `getSemanticDiagnosticsOfNextAffectedFile` until exhausted,
// returning the set of file names BuilderProgram considered affected.
function affectedFileNames(builder: ts.SemanticDiagnosticsBuilderProgram): Set<string> {
	const seen = new Set<string>();
	while (true) {
		const result = builder.getSemanticDiagnosticsOfNextAffectedFile();
		if (!result) break;
		const a = result.affected;
		if ('fileName' in a) seen.add(a.fileName);
		else {
			// `affected` was the whole Program (rare — happens when no
			// file-granular diff is possible, e.g. compilerOptions changed).
			seen.add('<program>');
		}
	}
	return seen;
}

// ── Test 1: builder.getProgram() === languageService.getProgram() ────────
//
// The whole point of layer 2 is to share one Program across LS and
// BP — if BP rebuilt from scratch we'd pay the parse/bind cost twice.
{
	write('/a.ts', 'export const x: number = 1;');
	write('/b.ts', "import { x } from './a'; export const y = x + 1;");
	projectVersion++;

	const program = languageService.getProgram()!;
	const builder = ts.createSemanticDiagnosticsBuilderProgram(
		program,
		{ createHash: ts.sys.createHash },
	);
	check(
		'builder shares program with LS',
		builder.getProgram() === program,
		'expected identity, got divergent Programs',
	);
}

// ── Test 2: cold first run flags every file as affected ──────────────────
{
	write('/a.ts', 'export const x: number = 1;');
	write('/b.ts', "import { x } from './a'; export const y = x + 1;");
	projectVersion++;

	const program = languageService.getProgram()!;
	const builder = ts.createSemanticDiagnosticsBuilderProgram(
		program,
		{ createHash: ts.sys.createHash },
	);
	const affected = affectedFileNames(builder);
	check(
		'cold run: a.ts is affected',
		affected.has('/a.ts'),
		`got: ${[...affected].join(', ')}`,
	);
	check(
		'cold run: b.ts is affected',
		affected.has('/b.ts'),
		`got: ${[...affected].join(', ')}`,
	);
}

// ── Test 3: edit a.ts → both a.ts and b.ts are affected ──────────────────
//
// The whole reason layer 2 exists: a change in a.ts should invalidate
// b.ts's type-aware rule cache because b.ts imports a's types.
{
	write('/a.ts', 'export const x: number = 1;');
	write('/b.ts', "import { x } from './a'; export const y = x + 1;");
	projectVersion++;
	const oldProgram = languageService.getProgram()!;
	const oldBuilder = ts.createSemanticDiagnosticsBuilderProgram(
		oldProgram,
		{ createHash: ts.sys.createHash },
	);
	// Walk to drain — establishes the baseline state.
	affectedFileNames(oldBuilder);

	// Edit a.ts: change exported type.
	write('/a.ts', 'export const x: string = "1";');
	projectVersion++;
	const newProgram = languageService.getProgram()!;
	check(
		'edit produced a new Program',
		newProgram !== oldProgram,
		'LS did not bump program after projectVersion change',
	);

	const newBuilder = ts.createSemanticDiagnosticsBuilderProgram(
		newProgram,
		{ createHash: ts.sys.createHash },
		oldBuilder,
	);
	const affected = affectedFileNames(newBuilder);
	check(
		'edited a.ts is in affected set',
		affected.has('/a.ts'),
		`got: ${[...affected].join(', ')}`,
	);
	check(
		'b.ts (importer of a.ts) is in affected set',
		affected.has('/b.ts'),
		`got: ${[...affected].join(', ')}`,
	);
}

// ── Test 4: identical re-run after baseline → nothing affected ───────────
{
	write('/a.ts', 'export const x: number = 1;');
	write('/b.ts', "import { x } from './a'; export const y = x + 1;");
	projectVersion++;
	const oldProgram = languageService.getProgram()!;
	const oldBuilder = ts.createSemanticDiagnosticsBuilderProgram(
		oldProgram,
		{ createHash: ts.sys.createHash },
	);
	affectedFileNames(oldBuilder);

	// No edits.
	const newProgram = languageService.getProgram()!;
	const newBuilder = ts.createSemanticDiagnosticsBuilderProgram(
		newProgram,
		{ createHash: ts.sys.createHash },
		oldBuilder,
	);
	const affected = affectedFileNames(newBuilder);
	check(
		'unchanged second pass: no files affected',
		affected.size === 0,
		`got ${affected.size} affected: ${[...affected].join(', ')}`,
	);
}

// ── Test 5: edit unrelated file does NOT affect imports ──────────────────
//
// b.ts imports a.ts, c.ts is independent. Changing c.ts must not put
// b.ts in the affected set.
{
	write('/a.ts', 'export const x: number = 1;');
	write('/b.ts', "import { x } from './a'; export const y = x + 1;");
	write('/c.ts', 'export const z = 42;');
	projectVersion++;
	const oldBuilder = ts.createSemanticDiagnosticsBuilderProgram(
		languageService.getProgram()!,
		{ createHash: ts.sys.createHash },
	);
	affectedFileNames(oldBuilder);

	// Edit c.ts only.
	write('/c.ts', 'export const z = 100;');
	projectVersion++;
	const newBuilder = ts.createSemanticDiagnosticsBuilderProgram(
		languageService.getProgram()!,
		{ createHash: ts.sys.createHash },
		oldBuilder,
	);
	const affected = affectedFileNames(newBuilder);
	check(
		'c.ts edit affects c.ts',
		affected.has('/c.ts'),
		`got: ${[...affected].join(', ')}`,
	);
	check(
		'c.ts edit does NOT affect b.ts (no import dep)',
		!affected.has('/b.ts'),
		`got: ${[...affected].join(', ')}`,
	);
	check(
		'c.ts edit does NOT affect a.ts',
		!affected.has('/a.ts'),
		`got: ${[...affected].join(', ')}`,
	);
}

// ── Test 6: edit globals.d.ts → all files using globals are affected ─────
//
// The motivating soundness case: ambient declarations don't show up
// in any file's `imports`, but BuilderProgram's reference graph
// tracks them transitively. Editing the global declaration must
// propagate to every consumer.
{
	files['/globals.d.ts'] = 'declare const FOO: number;';
	versions['/globals.d.ts'] = (versions['/globals.d.ts'] ?? 0) + 1;
	write('/use1.ts', 'export const a = FOO + 1;');
	write('/use2.ts', 'export const b = FOO * 2;');
	write('/no_globals.ts', 'export const c = 42;');
	projectVersion++;
	const oldBuilder = ts.createSemanticDiagnosticsBuilderProgram(
		languageService.getProgram()!,
		{ createHash: ts.sys.createHash },
	);
	affectedFileNames(oldBuilder);

	// Change globals.d.ts: type changes from number to string.
	files['/globals.d.ts'] = 'declare const FOO: string;';
	versions['/globals.d.ts']++;
	projectVersion++;
	const newBuilder = ts.createSemanticDiagnosticsBuilderProgram(
		languageService.getProgram()!,
		{ createHash: ts.sys.createHash },
		oldBuilder,
	);
	const affected = affectedFileNames(newBuilder);
	check(
		'globals.d.ts edit: globals.d.ts is affected',
		affected.has('/globals.d.ts'),
		`got: ${[...affected].join(', ')}`,
	);
	check(
		'globals.d.ts edit: use1.ts is affected (consumer of FOO)',
		affected.has('/use1.ts'),
		`got: ${[...affected].join(', ')} — this is the soundness case the per-file mtime cache misses`,
	);
	check(
		'globals.d.ts edit: use2.ts is affected (consumer of FOO)',
		affected.has('/use2.ts'),
		`got: ${[...affected].join(', ')}`,
	);
}

// ── Done ────────────────────────────────────────────────────────────────
process.stdout.write('\n');
if (failures.length) {
	console.error(`\n${failures.length} failure(s):`);
	for (const f of failures) console.error('  - ' + f);
	process.exit(1);
}
console.log('OK');
