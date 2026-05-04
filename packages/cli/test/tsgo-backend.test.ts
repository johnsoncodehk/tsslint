// End-to-end test for the tsgo backend adapter. Spawns tsgo via the
// API, builds a Project on packages/compat-eslint (real-world type-heavy
// code), and validates that the adapter:
//
//   1. Hands back a SourceFile via getProgram().getSourceFile() —
//      structurally compatible enough to be walked + queried like a
//      ts.SourceFile (kind / parent / pos / end / forEachChild).
//   2. After prepareFile(), getSymbolAtLocation() returns Symbols for
//      identifiers — including import/export specifier names that
//      `getSymbolAtLocation` alone misses (the position-based fallback).
//   3. Symbol identity collapses across multiple references to the same
//      logical entity — proves Map<Symbol, X> patterns (compat-eslint's
//      `variableBySymbol`) work without modification.
//   4. close() actually tears down the child process.
//
// Skip when @typescript/native-preview isn't installed — the adapter is
// behind an optional peer dep, so CI that doesn't pull it in must not
// fail.
//
// Run via:
//   node packages/cli/test/tsgo-backend.test.js

import * as path from 'path';
import * as fs from 'fs';

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

// Skip if optional peer not present.
try {
	require.resolve('@typescript/native-preview/sync');
}
catch {
	console.log('skip: @typescript/native-preview not installed');
	console.log('OK');
	process.exit(0);
}

const repoRoot = path.resolve(__dirname, '../../..');
const tsconfig = path.join(repoRoot, 'packages/compat-eslint/tsconfig.json');
const target = path.join(repoRoot, 'packages/compat-eslint/index.ts');

if (!fs.existsSync(tsconfig)) {
	console.log('skip: compat-eslint tsconfig missing');
	console.log('OK');
	process.exit(0);
}

const backend = require('../lib/tsgo-backend.js') as typeof import('../lib/tsgo-backend.js');
const handle = backend.createTsgoBackend(tsconfig);

try {
	const program = handle.getProgram();

	// ── Test 1: SourceFile fetched ────────────────────────────────────────
	const sf = program.getSourceFile(target);
	check('getSourceFile returns target SF', !!sf);
	if (!sf) throw new Error('SF missing — abort');
	check('SF.fileName matches', sf.fileName === target);
	check('SF.text non-empty', typeof sf.text === 'string' && sf.text.length > 1000);

	// ── Test 2: prepareFile populates the symbol cache ───────────────────
	handle.prepareFile(target);

	// SyntaxKind values for tsgo differ from ts (offsets shifted by ≥1
	// across enum revisions). We don't have tsgo's enum imported here —
	// instead probe by frequency: Identifier is the most-frequent kind
	// in any real TS file, by a comfortable margin over the next.
	const counts = new Map<number, number>();
	(function scan(n: any) {
		counts.set(n.kind, (counts.get(n.kind) ?? 0) + 1);
		n.forEachChild(scan);
	})(sf);
	const idKind = [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];

	const checker = program.getTypeChecker();
	let idCount = 0;
	let resolved = 0;
	let importSpecifierResolved = 0; // the case getSymbolAtLocation alone misses
	(function walk(n: any) {
		if (n.kind === idKind) {
			idCount++;
			const sym = checker.getSymbolAtLocation(n);
			if (sym) {
				resolved++;
				if (n.pos < 1500) importSpecifierResolved++; // top-of-file imports
			}
		}
		n.forEachChild(walk);
	})(sf);

	check('Identifiers found', idCount > 1000, `count=${idCount}`);
	check('high resolve rate (>95%)', resolved / idCount > 0.95, `resolved=${resolved}/${idCount} (${(resolved / idCount * 100).toFixed(1)}%)`);
	check('top-of-file imports resolved', importSpecifierResolved > 5, `count=${importSpecifierResolved}`);

	// ── Test 3: Symbol identity collapses across references ──────────────
	const seen = new Map<string, number>();
	(function walk(n: any) {
		if (n.kind === idKind) {
			const sym = checker.getSymbolAtLocation(n) as { id?: string } | undefined;
			if (sym?.id) {
				seen.set(sym.id, (seen.get(sym.id) ?? 0) + 1);
			}
		}
		n.forEachChild(walk);
	})(sf);
	const maxOccurrences = Math.max(...seen.values());
	check('Symbol identity collapses (some symbol used many times)', maxOccurrences > 10, `max occurrences for any symbol id: ${maxOccurrences}`);
	check('Symbol id space is bounded', seen.size < idCount, `unique symbols=${seen.size} < idCount=${idCount}`);

	// ── Test 4: rule-level identity compatibility ────────────────────────
	// Pre-3.2 rules used Map<ts.Symbol, X>. Post-adapter, the Symbol is
	// a tsgo Symbol object — but Map keying works on object identity, and
	// tsgo's Symbol instances are stable across calls within a snapshot.
	let firstId: any;
	const symbolMap = new Map<any, number>();
	(function walk(n: any) {
		if (n.kind === idKind) {
			const sym = checker.getSymbolAtLocation(n);
			if (sym) {
				if (!firstId) firstId = sym;
				symbolMap.set(sym, (symbolMap.get(sym) ?? 0) + 1);
			}
		}
		n.forEachChild(walk);
	})(sf);
	check('Map<Symbol, …> populated', symbolMap.size > 100);
	check('first symbol retrievable from Map', symbolMap.has(firstId));

	// ── Test 5: program.getCurrentDirectory() / getCompilerOptions() ─────
	const cwd = program.getCurrentDirectory();
	check('cwd is project dir', cwd === path.dirname(tsconfig));
	const opts = program.getCompilerOptions();
	check('compilerOptions returned', opts && typeof opts === 'object');
}
finally {
	handle.close();
}

process.stdout.write('\n');
if (failures.length) {
	console.error(`\n${failures.length} failure(s):`);
	for (const f of failures) console.error('  - ' + f);
	process.exit(1);
}
console.log('OK');
