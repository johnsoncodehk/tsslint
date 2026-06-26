// PoC: syntactic rule parity — Strada baseline vs tsgo shim.
//
//   node packages/poc-tsgo/run-poc.js              # both + parity
//   node packages/poc-tsgo/run-poc.js --strada-only
//   node packages/poc-tsgo/run-poc.js --tsgo-only
//   node packages/poc-tsgo/run-poc.js --bench 5     # median ms per leg

import path = require('path');
import fs = require('fs');
import tsReal = require('typescript');
import {
	fixtureFile,
	fixtureTsconfig,
	hitsMatch,
	runStrada,
	runTsgo,
	hasNativePreview,
	type Hit,
} from './lib/engine.js';

require('./lib/real-ts.js');

type Mode = 'both' | 'strada' | 'tsgo';

function parseArgs(): { mode: Mode; benchRuns: number } {
	let mode: Mode = 'both';
	let benchRuns = 0;
	for (const arg of process.argv.slice(2)) {
		if (arg === '--strada-only') mode = 'strada';
		else if (arg === '--tsgo-only') mode = 'tsgo';
		else if (arg === '--bench') benchRuns = 5;
		else if (arg.startsWith('--bench=')) benchRuns = Math.max(1, Number(arg.slice('--bench='.length)) || 5);
		else if (arg === '-h' || arg === '--help') {
			console.log(`Usage: run-poc.js [--strada-only | --tsgo-only] [--bench[=N]]`);
			process.exit(0);
		}
	}
	return { mode, benchRuns };
}

function median(nums: number[]): number {
	const s = [...nums].sort((a, b) => a - b);
	return s[Math.floor(s.length / 2)];
}

function timeRuns(runs: number, fn: () => void): { med: number; all: number[] } {
	const all: number[] = [];
	for (let i = 0; i < runs; i++) {
		const t0 = performance.now();
		fn();
		all.push(performance.now() - t0);
	}
	return { med: median(all), all };
}

function formatHits(hits: Hit[]): string[] {
	const text = fs.readFileSync(fixtureFile, 'utf8');
	const sf = tsReal.createSourceFile(fixtureFile, text, tsReal.ScriptTarget.Latest, true);
	return hits.map(h => {
		const { line, character } = tsReal.getLineAndCharacterOfPosition(sf, h.start);
		const slice = text.slice(h.start, h.end).replace(/\n/g, '\\n');
		return `L${line + 1}:${character + 1} [${h.start},${h.end}] ${JSON.stringify(slice)} — ${h.message}`;
	});
}

function main() {
	const { mode, benchRuns } = parseArgs();
	const repoRoot = path.resolve(__dirname, '../..');

	if (benchRuns > 0) {
		console.log(`PoC bench (${benchRuns} runs, median ms)\n`);
		if (mode !== 'tsgo') {
			const s = timeRuns(benchRuns, () => runStrada());
			console.log(`  Strada: ${s.med.toFixed(0)}ms  [${s.all.map(t => t.toFixed(0)).join(', ')}]`);
		}
		if (mode !== 'strada') {
			if (!hasNativePreview()) {
				console.log('  tsgo:   skip (no @typescript/native-preview)');
				process.exit(0);
			}
			const g = timeRuns(benchRuns, () => runTsgo());
			console.log(`  tsgo:   ${g.med.toFixed(0)}ms  [${g.all.map(t => t.toFixed(0)).join(', ')}]`);
		}
		return;
	}

	console.log('TSSLint tsgo shim PoC\n');
	console.log(`Fixture: ${path.relative(repoRoot, fixtureFile)}`);
	console.log(`Config:  ${path.relative(repoRoot, fixtureTsconfig)}\n`);

	let stradaHits: Hit[] | undefined;
	let tsgoHits: Hit[] | undefined;

	if (mode !== 'tsgo') {
		stradaHits = runStrada();
		console.log('── Strada (ts.Program baseline) ──');
		for (const line of formatHits(stradaHits)) console.log('  ' + line);
		console.log(`  → ${stradaHits.length} diagnostic(s)\n`);
	}

	if (mode !== 'strada') {
		if (!hasNativePreview()) {
			console.log('── tsgo ──');
			console.log('  skip: npm install -D @typescript/native-preview (see @tsslint/poc-tsgo)');
			process.exit(mode === 'tsgo' ? 0 : 0);
		}
		const t0 = performance.now();
		tsgoHits = runTsgo();
		const ms = (performance.now() - t0).toFixed(0);
		console.log('── tsgo (shim) ──');
		for (const line of formatHits(tsgoHits)) console.log('  ' + line);
		console.log(`  → ${tsgoHits.length} diagnostic(s)  (${ms}ms)\n`);
	}

	if (stradaHits && tsgoHits) {
		if (hitsMatch(stradaHits, tsgoHits)) {
			console.log('✓ Parity: Strada baseline and tsgo shim match');
		}
		else {
			console.log('✗ Parity mismatch');
			console.log('  Strada:', JSON.stringify(stradaHits));
			console.log('  tsgo:  ', JSON.stringify(tsgoHits));
			process.exit(1);
		}
	}
}

main();
