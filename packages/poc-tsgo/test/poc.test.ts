// Smoke tests for the tsgo shim PoC. Skips when @typescript/native-preview
// is not installed.
//
//   node packages/poc-tsgo/test/poc.test.js

import path = require('path');

const failures: string[] = [];
function check(name: string, cond: boolean, detail?: string) {
	if (cond) process.stdout.write('.');
	else {
		failures.push(name + (detail ? ` — ${detail}` : ''));
		process.stdout.write('F');
	}
}

const { hasNativePreview } = require('../lib/tsgo-load.js') as typeof import('../lib/tsgo-load.js');
if (!hasNativePreview()) {
	console.log('\nskip: @typescript/native-preview not installed');
	process.exit(0);
}

const repoRoot = path.resolve(__dirname, '../../..');
const tsconfig = path.join(repoRoot, 'fixtures/error-rule/tsconfig.json');
const target = path.join(repoRoot, 'fixtures/error-rule/fixture.ts');

require('../lib/real-ts.js');
const tsReal = require('../lib/real-ts.js') as typeof import('typescript');
const { createTsgoBackend } = require('../lib/tsgo-backend.js') as typeof import('../lib/tsgo-backend.js');
const { installFacade } = require('../lib/tsgo-typescript-facade.js') as typeof import('../lib/tsgo-typescript-facade.js');

const tsFacade = installFacade();

check('facade installed', (tsFacade as { __tsgoFacade__?: boolean }).__tsgoFacade__ === true);

const backend = createTsgoBackend(tsconfig);
try {
	const program = backend.getProgram();
	const sf = program.getSourceFile(target);
	check('getSourceFile', !!sf);
	if (!sf) throw new Error('abort');

	backend.prepareFile(target);
	const checker = program.getTypeChecker();

	// Walk identifiers — JS-side symbol resolver should resolve `console`.
	let idKind = 0;
	let idMax = 0;
	const counts = new Map<number, number>();
	(function scan(n: { kind: number; forEachChild: (cb: (c: typeof n) => void) => void }) {
		counts.set(n.kind, (counts.get(n.kind) ?? 0) + 1);
		n.forEachChild(scan);
	})(sf as any);
	for (const [k, c] of counts) {
		if (c > idMax) { idMax = c; idKind = k; }
	}

	let resolved = 0;
	let consoleResolved = false;
	(function walk(n: any) {
		if (n.kind === idKind && n.getText?.() === 'console') {
			const sym = checker.getSymbolAtLocation(n);
			if (sym) {
				resolved++;
				consoleResolved = true;
			}
		}
		if (n.kind === idKind) {
			const sym = checker.getSymbolAtLocation(n);
			if (sym) resolved++;
		}
		n.forEachChild(walk);
	})(sf);

	check('console identifier resolves', consoleResolved);
	check('isCallExpression on facade', typeof tsFacade.isCallExpression === 'function');
	check('SyntaxKind.Identifier differs from Strada', tsFacade.SyntaxKind.Identifier !== tsReal.SyntaxKind.Identifier);
	check('ts.isIdentifier works on tsgo node', (() => {
		let found = false;
		(function w(n: any) {
			if (n.kind === idKind && n.getText?.() === 'console') found = tsFacade.isIdentifier(n);
			else n.forEachChild(w);
		})(sf);
		return found;
	})());

	backend.releaseFile(target);
}
finally {
	backend.close();
}

console.log(failures.length ? `\n${failures.length} FAILED\n- ${failures.join('\n- ')}` : '\nOK');
process.exit(failures.length ? 1 : 0);
