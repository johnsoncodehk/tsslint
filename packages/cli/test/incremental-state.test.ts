// Round-trip tests for the layer 2 cross-session state. Verifies that
// capturing a BP's state via TS internal `emitBuildInfo` produces a
// text the next session can feed back through
// `createBuilderProgramUsingIncrementalBuildInfo` to get an oldBP that
// correctly diffs the current program.
//
// Run via:
//   node packages/cli/test/incremental-state.test.js

import * as ts from 'typescript';

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

const realLib = ts.getDefaultLibFilePath({ target: ts.ScriptTarget.Latest });
const libContent = ts.sys.readFile(realLib) ?? '';
const libName = realLib.split(/[\\/]/).pop()!;

function buildProgram(files: Record<string, string>): ts.Program {
	const host: ts.CompilerHost = {
		getSourceFile(name) {
			if (name in files) {
				const text = files[name];
				const sf = ts.createSourceFile(name, text, ts.ScriptTarget.Latest, true);
				// BP requires a `version` field on each SourceFile. Production
				// LS sets this from `host.getScriptVersion`; here we derive
				// from content length so edited files get a different version
				// (otherwise BP's diff sees no change and skips propagation).
				(sf as unknown as { version: string }).version = String(text.length) + ':' + text.charCodeAt(0);
				return sf;
			}
			if (name === realLib) {
				const sf = ts.createSourceFile(realLib, libContent, ts.ScriptTarget.Latest, true);
				(sf as unknown as { version: string }).version = String(libContent.length);
				return sf;
			}
			return undefined;
		},
		getDefaultLibFileName: () => realLib,
		writeFile: () => {},
		getCurrentDirectory: () => '/',
		getDirectories: () => [],
		fileExists: n => n in files || n === realLib,
		readFile: n => files[n] ?? (n === realLib ? libContent : undefined),
		getCanonicalFileName: n => n,
		useCaseSensitiveFileNames: () => true,
		getNewLine: () => '\n',
	};
	return ts.createProgram({
		rootNames: Object.keys(files),
		options: {
			target: ts.ScriptTarget.Latest,
			noEmit: true,
			incremental: true,
			tsBuildInfoFile: inc.SYNTHETIC_BUILD_INFO_PATH,
			lib: [libName],
		},
		host,
	});
}

function affectedFileNames(builder: ts.SemanticDiagnosticsBuilderProgram): Set<string> {
	const set = new Set<string>();
	while (true) {
		const r = builder.getSemanticDiagnosticsOfNextAffectedFile();
		if (!r) break;
		if ('fileName' in r.affected) set.add(r.affected.fileName);
		else for (const sf of r.affected.getSourceFiles()) set.add(sf.fileName);
	}
	return set;
}

const hostShim = {
	useCaseSensitiveFileNames: () => true,
	getCurrentDirectory: () => '/',
};

// ── Test 1: captureIncrementalState produces text on a fresh BP ─────────
{
	const program = buildProgram({ '/a.ts': 'export const x: number = 1;' });
	const builder = ts.createSemanticDiagnosticsBuilderProgram(
		program,
		{ createHash: ts.sys.createHash },
	);
	affectedFileNames(builder); // drain
	const state = inc.captureIncrementalState(builder);
	check('state captured', !!state);
	check('state version is v3', state?.version === inc.INCREMENTAL_STATE_VERSION);
	check('tsBuildInfoText is non-empty', !!state && state.tsBuildInfoText.length > 0);
}

// ── Test 2: reconstructOldBuilder + diff round-trip — identical program ─
{
	const program1 = buildProgram({
		'/a.ts': 'export const x: number = 1;',
		'/b.ts': "import { x } from './a'; export const y = x + 1;",
	});
	const builder1 = ts.createSemanticDiagnosticsBuilderProgram(
		program1,
		{ createHash: ts.sys.createHash },
	);
	affectedFileNames(builder1);
	const captured = inc.captureIncrementalState(builder1)!;

	const program2 = buildProgram({
		'/a.ts': 'export const x: number = 1;',
		'/b.ts': "import { x } from './a'; export const y = x + 1;",
	});
	const oldBP = inc.reconstructOldBuilder(ts, captured, hostShim);
	check('reconstruct produced an oldBP', !!oldBP);
	const builder2 = ts.createSemanticDiagnosticsBuilderProgram(
		program2,
		{ createHash: ts.sys.createHash },
		oldBP as ts.SemanticDiagnosticsBuilderProgram,
	);
	const affected = affectedFileNames(builder2);
	check(
		'identical program → no user files affected',
		!affected.has('/a.ts') && !affected.has('/b.ts'),
		`got affected: ${[...affected].join(', ')}`,
	);
}

// ── Test 3: round-trip catches edits to imported file ───────────────────
{
	const program1 = buildProgram({
		'/a.ts': 'export const x: number = 1;',
		'/b.ts': "import { x } from './a'; export const y = x + 1;",
	});
	const builder1 = ts.createSemanticDiagnosticsBuilderProgram(
		program1,
		{ createHash: ts.sys.createHash },
	);
	affectedFileNames(builder1);
	const captured = inc.captureIncrementalState(builder1)!;

	// /a.ts changes its public type — should propagate to /b.ts.
	const program2 = buildProgram({
		'/a.ts': 'export const x: string = "1";',
		'/b.ts': "import { x } from './a'; export const y = x + 1;",
	});
	const oldBP = inc.reconstructOldBuilder(ts, captured, hostShim);
	const builder2 = ts.createSemanticDiagnosticsBuilderProgram(
		program2,
		{ createHash: ts.sys.createHash },
		oldBP as ts.SemanticDiagnosticsBuilderProgram,
	);
	const affected = affectedFileNames(builder2);
	check('a.ts affected', affected.has('/a.ts'));
	check('b.ts affected (importer of a.ts)', affected.has('/b.ts'));
}

// ── Test 4: undefined prev → cold start (oldBP undefined) ───────────────
{
	const oldBP = inc.reconstructOldBuilder(ts, undefined, hostShim);
	check('undefined prev → undefined oldBP', oldBP === undefined);
}

// ── Test 5: schema version mismatch → cold start ────────────────────────
{
	const stale = { version: 'v0', tsBuildInfoText: '' };
	const oldBP = inc.reconstructOldBuilder(ts, stale as any, hostShim);
	check('version mismatch → undefined oldBP', oldBP === undefined);
}

// ── Test 6: corrupted tsBuildInfoText → cold start ──────────────────────
{
	const corrupted = { version: inc.INCREMENTAL_STATE_VERSION, tsBuildInfoText: '{garbage' };
	const oldBP = inc.reconstructOldBuilder(ts, corrupted, hostShim);
	check('corrupted text → undefined oldBP', oldBP === undefined);
}

// ── Test 7: TS missing internal load APIs → cold start ──────────────────
// Future TS could rename `getBuildInfo` /
// `createBuilderProgramUsingIncrementalBuildInfo`. We must not throw.
{
	const tsStub = new Proxy(ts, {
		get(target, prop) {
			if (prop === 'getBuildInfo' || prop === 'createBuilderProgramUsingIncrementalBuildInfo') {
				return undefined;
			}
			return (target as any)[prop];
		},
	}) as typeof ts;
	const valid = { version: inc.INCREMENTAL_STATE_VERSION, tsBuildInfoText: 'irrelevant' };
	let threw = false;
	let result: ts.BuilderProgram | undefined;
	try {
		result = inc.reconstructOldBuilder(tsStub, valid, hostShim);
	}
	catch {
		threw = true;
	}
	check('missing load APIs → no throw', !threw);
	check('missing load APIs → undefined result', result === undefined);
}

// ── Test 8: BuilderProgram missing emitBuildInfo → undefined, no throw ──
// The save path must degrade gracefully if a future TS removes or
// renames `BuilderProgram.emitBuildInfo`. Otherwise the CLI throws
// after lint completes, losing all results.
{
	const fakeBuilder = {} as ts.BuilderProgram;
	let threw = false;
	let result: ReturnType<typeof inc.captureIncrementalState>;
	try {
		result = inc.captureIncrementalState(fakeBuilder);
	}
	catch {
		threw = true;
	}
	check('missing emitBuildInfo → no throw', !threw);
	check('missing emitBuildInfo → undefined state', result === undefined);
}

// ── Test 9: emitBuildInfo throws → undefined, no throw out ──────────────
{
	const throwingBuilder = {
		emitBuildInfo() { throw new Error('simulated TS internal failure'); },
	} as unknown as ts.BuilderProgram;
	let threw = false;
	let result: ReturnType<typeof inc.captureIncrementalState>;
	try {
		result = inc.captureIncrementalState(throwingBuilder);
	}
	catch {
		threw = true;
	}
	check('throwing emitBuildInfo → no throw', !threw);
	check('throwing emitBuildInfo → undefined state', result === undefined);
}

// ── Done ────────────────────────────────────────────────────────────────
process.stdout.write('\n');
if (failures.length) {
	console.error(`\n${failures.length} failure(s):`);
	for (const f of failures) console.error('  - ' + f);
	process.exit(1);
}
console.log('OK');
