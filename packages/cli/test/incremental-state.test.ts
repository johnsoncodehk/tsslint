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

// stderr capture helper for warning-path tests below.
function captureStderr<T>(fn: () => T): { result: T; stderr: string } {
	const orig = process.stderr.write.bind(process.stderr);
	let buf = '';
	(process.stderr.write as any) = (chunk: any) => {
		buf += String(chunk);
		return true;
	};
	try {
		const result = fn();
		return { result, stderr: buf };
	}
	finally {
		(process.stderr.write as any) = orig;
	}
}

// ── Test 1: captureIncrementalState produces text on a fresh BP ─────────
{
	const program = buildProgram({ '/a.ts': 'export const x: number = 1;' });
	const builder = ts.createSemanticDiagnosticsBuilderProgram(
		program,
		{ createHash: ts.sys.createHash },
	);
	affectedFileNames(builder); // drain
	const state = inc.captureIncrementalState(ts.version, builder);
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
	const captured = inc.captureIncrementalState(ts.version, builder1)!;

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
	const captured = inc.captureIncrementalState(ts.version, builder1)!;

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
	const oldBP = inc.reconstructOldBuilder(ts, stale, hostShim);
	check('version mismatch → undefined oldBP', oldBP === undefined);
}

// ── Test 6: corrupted tsBuildInfoText → cold start ──────────────────────
{
	const corrupted = { version: inc.INCREMENTAL_STATE_VERSION, tsBuildInfoText: '{garbage' };
	const oldBP = inc.reconstructOldBuilder(ts, corrupted, hostShim);
	check('corrupted text → undefined oldBP', oldBP === undefined);
}

// ── Test 7: TS missing internal load APIs → cold start + warn ──────────
// Future TS could rename `getBuildInfo` /
// `createBuilderProgramUsingIncrementalBuildInfo`. We must not throw,
// AND we must surface a stderr warning so users know type-aware cache
// is silently disabled.
{
	const tsStub = new Proxy(ts, {
		get(target, prop) {
			if (prop === 'getBuildInfo' || prop === 'createBuilderProgramUsingIncrementalBuildInfo') {
				return undefined;
			}
			return (target as any)[prop];
		},
	});
	const valid = { version: inc.INCREMENTAL_STATE_VERSION, tsBuildInfoText: 'irrelevant' };
	const { result, stderr } = captureStderr(() => {
		try {
			return inc.reconstructOldBuilder(tsStub, valid, hostShim);
		}
		catch {
			return 'THREW' as const;
		}
	});
	check('missing load APIs → no throw', result !== 'THREW');
	check('missing load APIs → undefined result', result === undefined);
	check('missing load APIs → warning printed', /warn/.test(stderr));
	check('missing load APIs → warning names the missing API', /getBuildInfo/.test(stderr));
	check('missing load APIs → warning names TS version', stderr.includes(ts.version));
}

// ── Test 8: BuilderProgram missing emitBuildInfo → undefined + warn ────
// The save path must degrade gracefully if a future TS removes or
// renames `BuilderProgram.emitBuildInfo`. Otherwise the CLI throws
// after lint completes, losing all results. Must also warn the user.
{
	const fakeBuilder = {} as ts.BuilderProgram;
	const { result, stderr } = captureStderr(() => {
		try {
			return inc.captureIncrementalState(ts.version, fakeBuilder);
		}
		catch {
			return 'THREW' as const;
		}
	});
	check('missing emitBuildInfo → no throw', result !== 'THREW');
	check('missing emitBuildInfo → undefined state', result === undefined);
	check('missing emitBuildInfo → warning printed', /warn/.test(stderr));
	check('missing emitBuildInfo → warning names emitBuildInfo', /emitBuildInfo/.test(stderr));
}

// ── Test 9: emitBuildInfo throws → undefined + warn, no throw out ──────
{
	const throwingBuilder = {
		emitBuildInfo() {
			throw new Error('simulated TS internal failure');
		},
	} as unknown as ts.BuilderProgram;
	const { result, stderr } = captureStderr(() => {
		try {
			return inc.captureIncrementalState(ts.version, throwingBuilder);
		}
		catch {
			return 'THREW' as const;
		}
	});
	check('throwing emitBuildInfo → no throw', result !== 'THREW');
	check('throwing emitBuildInfo → undefined state', result === undefined);
	check('throwing emitBuildInfo → warning printed', /warn/.test(stderr));
	check(
		'throwing emitBuildInfo → warning includes underlying error',
		/simulated TS internal failure/.test(stderr),
	);
}

// ── Test 10: corrupted buildInfo on load throws inside getBuildInfo →
// warn, return undefined. Distinct from Test 6 — TS itself may throw on
// some corrupt inputs (vs returning undefined for others).
{
	const throwingTs = new Proxy(ts, {
		get(target, prop) {
			if (prop === 'getBuildInfo') {
				return () => {
					throw new Error('synthetic parse failure');
				};
			}
			return (target as any)[prop];
		},
	});
	const valid = { version: inc.INCREMENTAL_STATE_VERSION, tsBuildInfoText: 'whatever' };
	const { result, stderr } = captureStderr(() => {
		try {
			return inc.reconstructOldBuilder(throwingTs, valid, hostShim);
		}
		catch {
			return 'THREW' as const;
		}
	});
	check('throwing getBuildInfo → no throw', result !== 'THREW');
	check('throwing getBuildInfo → undefined result', result === undefined);
	check('throwing getBuildInfo → warning printed', /warn/.test(stderr));
	check(
		'throwing getBuildInfo → warning includes underlying error',
		/synthetic parse failure/.test(stderr),
	);
}

// ── Test 11: silent paths stay silent ──────────────────────────────────
// Cold start (no prev) and version mismatch are normal, not an error
// — must NOT print a warning.
{
	const { stderr: s1 } = captureStderr(() => inc.reconstructOldBuilder(ts, undefined, hostShim));
	check('undefined prev → no warning', s1 === '');
	const stale = { version: 'v0', tsBuildInfoText: '' };
	const { stderr: s2 } = captureStderr(() => inc.reconstructOldBuilder(ts, stale as any, hostShim));
	check('version mismatch → no warning', s2 === '');
}

// ── Test 12: oversized buildinfo → undefined + warn ────────────────────
// Hard cap on `tsBuildInfoText` size protects against pathological
// monorepos where the captured state grows past V8's max-string limit
// or makes JSON.stringify of the surrounding cache feel sticky. Cap
// fires → warn + skip persistence (next run starts cold for layer 2).
{
	// Fabricate a builder that emits a 65MB buildinfo blob. We only
	// exercise the size-guard path; the actual TS-emitted text is
	// always small in practice (Dify 5867 files = ~3.6MB).
	const huge = 'x'.repeat(65 * 1024 * 1024);
	const oversizedBuilder = {
		emitBuildInfo(write: (path: string, content: string) => void) {
			write('whatever', huge);
		},
	} as unknown as ts.BuilderProgram;
	const { result, stderr } = captureStderr(() => {
		try {
			return inc.captureIncrementalState(ts.version, oversizedBuilder);
		}
		catch {
			return 'THREW' as const;
		}
	});
	check('oversized buildinfo → no throw', result !== 'THREW');
	check('oversized buildinfo → undefined state', result === undefined);
	check('oversized buildinfo → warning printed', /warn/.test(stderr));
	check('oversized buildinfo → warning mentions cap', /cap/.test(stderr));
}

// ── Done ────────────────────────────────────────────────────────────────
process.stdout.write('\n');
if (failures.length) {
	console.error(`\n${failures.length} failure(s):`);
	for (const f of failures) console.error('  - ' + f);
	process.exit(1);
}
console.log('OK');
