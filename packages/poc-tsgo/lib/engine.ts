// Shared PoC engine: one syntactic no-console rule on fixtures/error-rule.
import path = require('path');
import tsReal = require('./real-ts.js');

export const repoRoot = path.resolve(__dirname, '../../..');
export const fixtureTsconfig = path.join(repoRoot, 'fixtures/error-rule/tsconfig.json');
export const fixtureFile = path.join(repoRoot, 'fixtures/error-rule/fixture.ts');
/** CLI fixture with the same rule via tsslint.config.ts */
export const cliProject = path.join(repoRoot, 'fixtures/define-rule/tsconfig.json');

export type Hit = { message: string; start: number; end: number };

export type Reporter = {
	at(err: Error, stackIndex: number): Reporter;
	asWarning(): Reporter;
	asError(): Reporter;
	asSuggestion(): Reporter;
	withDeprecated(): Reporter;
	withUnnecessary(): Reporter;
	withFix(title: string, getChanges: () => unknown[]): Reporter;
	withRefactor(title: string, getChanges: () => unknown[]): Reporter;
	withoutCache(): Reporter;
};

export type RuleContext = {
	typescript: typeof import('typescript');
	program: import('typescript').Program;
	file: import('typescript').SourceFile;
	report(message: string, start: number, end: number): Reporter;
};

export type Rule = (ctx: RuleContext) => void;

export const noConsoleRule: Rule = ({ typescript: ts, file, report }) => {
	ts.forEachChild(file, function visit(node) {
		if (
			ts.isCallExpression(node)
			&& ts.isPropertyAccessExpression(node.expression)
			&& ts.isIdentifier(node.expression.expression)
			&& node.expression.expression.text === 'console'
		) {
			report(
				`Calls to 'console' are not allowed.`,
				node.getStart(file),
				node.getEnd(),
			);
		}
		ts.forEachChild(node, visit);
	});
};

function makeReport(hits: Hit[]): (message: string, start: number, end: number) => Reporter {
	return (message, start, end) => {
		hits.push({ message, start, end });
		const chain: Reporter = {
			at: () => chain,
			asWarning: () => chain,
			asError: () => chain,
			asSuggestion: () => chain,
			withDeprecated: () => chain,
			withUnnecessary: () => chain,
			withFix: () => chain,
			withRefactor: () => chain,
			withoutCache: () => chain,
		};
		return chain;
	};
}

export function runRule(
	ts: typeof import('typescript'),
	program: import('typescript').Program,
	fileName: string,
): Hit[] {
	const file = program.getSourceFile(fileName);
	if (!file) throw new Error(`missing SF: ${fileName}`);
	const hits: Hit[] = [];
	const ctx: RuleContext = {
		typescript: ts,
		program,
		file,
		report: makeReport(hits),
	};
	noConsoleRule(ctx);
	return hits;
}

export function buildStradaProgram(tsconfig: string): import('typescript').Program {
	const config = tsReal.readConfigFile(tsconfig, tsReal.sys.readFile);
	if (config.error) {
		throw new Error(tsReal.formatDiagnostic(config.error, {
			getCurrentDirectory: tsReal.sys.getCurrentDirectory,
			getCanonicalFileName: f => f,
			getNewLine: () => tsReal.sys.newLine,
		}));
	}
	const parsed = tsReal.parseJsonConfigFileContent(
		config.config,
		tsReal.sys,
		path.dirname(tsconfig),
		undefined,
		tsconfig,
	);
	return tsReal.createProgram({
		rootNames: parsed.fileNames,
		options: parsed.options,
	});
}

export function runStrada(): Hit[] {
	const program = buildStradaProgram(fixtureTsconfig);
	return runRule(tsReal, program, fixtureFile);
}

import { hasNativePreview } from './tsgo-load.js';

export { hasNativePreview };

export function runTsgo(): Hit[] {
	if (!hasNativePreview()) {
		throw new Error('@typescript/native-preview not installed');
	}
	const { createTsgoBackend } = require('./tsgo-backend.js') as typeof import('./tsgo-backend.js');
	const { installFacade } = require('./tsgo-typescript-facade.js') as typeof import('./tsgo-typescript-facade.js');
	const tsFacade = installFacade();
	const backend = createTsgoBackend(fixtureTsconfig);
	try {
		backend.prepareFile(fixtureFile);
		return runRule(tsFacade, backend.getProgram(), fixtureFile);
	}
	finally {
		backend.releaseFile(fixtureFile);
		backend.close();
	}
}

export function hitsMatch(a: Hit[], b: Hit[]): boolean {
	return a.length === b.length
		&& a.every((s, i) => {
			const t = b[i];
			return s.message === t.message && s.start === t.start && s.end === t.end;
		});
}
