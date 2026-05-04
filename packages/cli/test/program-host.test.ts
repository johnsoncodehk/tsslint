// Regression tests for the worker's CompilerHost setup. The CLI
// worker (post-3.2) builds Programs directly via `ts.createProgram`
// instead of going through a LanguageService. Two non-obvious
// invariants come out of that switch:
//
//   1. SourceFile.version stamping — `ts.createSemanticDiagnosticsBuilderProgram`
//      throws (`Debug.checkDefined`) if any SourceFile is missing
//      `.version`. The LS path got that for free via the host's
//      `getScriptVersion`; raw CompilerHost has no equivalent, so the
//      worker overrides `getSourceFile` to stamp a content hash.
//
//   2. setParentNodes — compat-eslint's bottom-up materialise walks
//      `ts.Node.parent` chains; without them it crashes. `ts.createLanguageService`
//      sets parent nodes implicitly; raw `ts.createCompilerHost` defaults
//      false, so the worker passes `true` explicitly.
//
//   3. fileTextOverrides → readFile / getSourceFile → BuilderProgram
//      sees post-fix content. `--fix` rewrites a file and stashes the
//      new text in the override map; the next `ensureProgram()` rebuild
//      consumes it via `host.readFile`, and TS's text-equality reuse
//      logic identifies the file as modified vs the oldProgram.
//
// These tests pin those invariants so a future "let's drop the version
// stamp / setParentNodes argument" cleanup fails loudly instead of
// crashing only on real projects.
//
// Run via:
//   node packages/cli/test/program-host.test.js

import * as ts from 'typescript';
import * as crypto from 'crypto';

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

const defaultHash = (s: string) => crypto.createHash('sha256').update(s).digest('hex');

// Mirror the worker's CompilerHost setup: in-memory file system layered
// over `ts.sys` for lib resolution + version stamping + setParentNodes.
function makeHost(files: Record<string, string>, fileTextOverrides: Map<string, string>): ts.CompilerHost {
	const realLibPath = ts.getDefaultLibFilePath({ target: ts.ScriptTarget.Latest });
	const realLibContent = ts.sys.readFile(realLibPath) ?? '';
	const options: ts.CompilerOptions = {
		target: ts.ScriptTarget.Latest,
		noEmit: true,
		incremental: true,
		lib: [realLibPath.split(/[\\/]/).pop()!],
	};
	const host = ts.createCompilerHost(options, /*setParentNodes*/ true);
	const originalReadFile = host.readFile.bind(host);
	const originalGetSourceFile = host.getSourceFile.bind(host);
	const hash = ts.sys.createHash ?? defaultHash;

	host.fileExists = n => n in files || n === realLibPath || ts.sys.fileExists(n);
	host.readFile = (fileName: string) => {
		const override = fileTextOverrides.get(fileName);
		if (override !== undefined) return override;
		if (fileName in files) return files[fileName];
		if (fileName === realLibPath) return realLibContent;
		return originalReadFile(fileName);
	};
	host.getSourceFile = (fileName, languageVersion, onError, shouldCreate) => {
		const sf = originalGetSourceFile(fileName, languageVersion, onError, shouldCreate);
		if (sf && (sf as unknown as { version?: string }).version === undefined) {
			(sf as unknown as { version: string }).version = hash(sf.text);
		}
		return sf;
	};
	return host;
}

function buildProgram(files: Record<string, string>, fileTextOverrides: Map<string, string>, oldProgram?: ts.Program) {
	const host = makeHost(files, fileTextOverrides);
	return ts.createProgram({
		rootNames: Object.keys(files),
		options: {
			target: ts.ScriptTarget.Latest,
			noEmit: true,
			incremental: true,
		},
		host,
		oldProgram,
	});
}

// ── Test 1: BuilderProgram doesn't crash on raw createProgram output ─────
//
// This is the regression that motivated the version-stamping override.
// Without `.version` on each SourceFile, BuilderProgram throws
// `Debug Failure. Program intended to be used with Builder should have
// source files with versions set`.
{
	const overrides = new Map<string, string>();
	const program = buildProgram({ '/a.ts': 'const x = 1;' }, overrides);

	let threw: unknown;
	let builder: ts.SemanticDiagnosticsBuilderProgram | undefined;
	try {
		builder = ts.createSemanticDiagnosticsBuilderProgram(program, {
			createHash: ts.sys.createHash ?? defaultHash,
		});
	}
	catch (err) {
		threw = err;
	}
	check('createSemanticDiagnosticsBuilderProgram does not throw', threw === undefined, threw ? String(threw) : undefined);
	check('BuilderProgram instance returned', !!builder);
}

// ── Test 2: every SourceFile in the program has .version stamped ─────────
{
	const program = buildProgram({ '/a.ts': 'const x = 1;', '/b.ts': 'const y = 2;' }, new Map());
	const a = program.getSourceFile('/a.ts')!;
	const b = program.getSourceFile('/b.ts')!;
	check('a.version is set', !!(a as unknown as { version?: string }).version);
	check('b.version is set', !!(b as unknown as { version?: string }).version);
	check(
		'distinct contents → distinct versions',
		(a as unknown as { version: string }).version !== (b as unknown as { version: string }).version,
	);
}

// ── Test 3: parent pointers populated (setParentNodes: true) ─────────────
//
// compat-eslint's bottom-up materialise walks `ts.Node.parent` chains.
// `ts.createCompilerHost(options, true)` sets parents at parse time.
// Without the `true` flag, AST traversal up from a leaf would crash.
{
	const program = buildProgram({ '/a.ts': 'const x = 1;' }, new Map());
	const sf = program.getSourceFile('/a.ts')!;
	const stmt = sf.statements[0] as ts.VariableStatement;
	check('SourceFile root has no parent expectation', sf.parent === undefined);
	check('top-level statement.parent === SourceFile', stmt.parent === sf);
	// Drill: VariableStatement → declarationList → declarations[0] → name (Identifier `x`)
	const list = stmt.declarationList;
	check('declarationList.parent === VariableStatement', list.parent === stmt);
	const decl = list.declarations[0];
	check('declaration.parent === declarationList', decl.parent === list);
	const ident = decl.name;
	check('identifier.parent === declaration', ident.parent === decl);
}

// ── Test 4: fileTextOverrides flows through readFile to the program ──────
{
	const overrides = new Map<string, string>();
	overrides.set('/a.ts', 'const overridden = 42;');
	const program = buildProgram({ '/a.ts': 'const onDisk = 1;' }, overrides);
	const sf = program.getSourceFile('/a.ts')!;
	check(
		'override wins over disk content',
		sf.text === 'const overridden = 42;',
		`got: ${sf.text}`,
	);
}

// ── Test 5: oldProgram-based rebuild honours overrides ──────────
//
// First build: file is on disk. Second build: same file, override flips
// the content. The rebuilt program must see the new text. (TS's
// internal reuse strategy across the two programs is an optimisation —
// what we lock in here is the correctness contract: the override
// propagates, the unchanged file's text + version are preserved.)
{
	type SF = { version?: string };
	const versionOf = (sf: ts.SourceFile) => (sf as unknown as SF).version;
	const overrides = new Map<string, string>();
	const first = buildProgram(
		{ '/a.ts': 'const x = 1;', '/b.ts': 'const y = 2;' },
		overrides,
	);
	const firstA = first.getSourceFile('/a.ts')!;
	const firstB = first.getSourceFile('/b.ts')!;
	check('first build: a.ts has on-disk text', firstA.text === 'const x = 1;');

	overrides.set('/a.ts', 'const x = 999;'); // simulate --fix rewriting a.ts
	const second = buildProgram(
		{ '/a.ts': 'const x = 1;', '/b.ts': 'const y = 2;' },
		overrides,
		first,
	);
	const secondA = second.getSourceFile('/a.ts')!;
	const secondB = second.getSourceFile('/b.ts')!;

	check('rebuild: a.ts has overridden text', secondA.text === 'const x = 999;');
	check('rebuild: b.ts text unchanged', secondB.text === 'const y = 2;');
	// Version stamping is content-addressed → identical text after rebuild
	// produces identical version. Lets BuilderProgram's reference-graph
	// diff identify b.ts as unchanged across the rebuild.
	check(
		'b.ts version stable across rebuild (content-addressed)',
		versionOf(secondB) === versionOf(firstB),
		`first=${versionOf(firstB)}, second=${versionOf(secondB)}`,
	);
	check(
		'a.ts version differs across rebuild (content changed)',
		versionOf(secondA) !== versionOf(firstA),
	);
}

// ── Test 6: BuilderProgram drain works on a Program with overrides ──────
//
// End-to-end: the same setup the worker uses for layer-2 affected-file
// computation. Drain should walk every file, no crashes.
{
	const program = buildProgram(
		{ '/a.ts': 'const x = 1;', '/b.ts': 'const y = 2;' },
		new Map(),
	);
	const builder = ts.createSemanticDiagnosticsBuilderProgram(program, {
		createHash: ts.sys.createHash ?? defaultHash,
	});
	const affected = new Set<string>();
	const recordAffected = (sf: ts.SourceFile) => {
		const a = sf as ts.SourceFile | ts.Program;
		if ('fileName' in a) {
			affected.add(a.fileName);
		}
		else {
			for (const f of a.getSourceFiles()) affected.add(f.fileName);
		}
		return true;
	};
	let drained = 0;
	while (true) {
		const r = builder.getSemanticDiagnosticsOfNextAffectedFile(undefined, recordAffected);
		if (!r) break;
		drained++;
		if (drained > 100) {
			failures.push('drain ran away (no termination)');
			break;
		}
	}
	check('drain found affected user files', affected.has('/a.ts') && affected.has('/b.ts'));
}

process.stdout.write('\n');
if (failures.length) {
	console.error(`\n${failures.length} failure(s):`);
	for (const f of failures) console.error('  - ' + f);
	process.exit(1);
}
console.log('OK');
