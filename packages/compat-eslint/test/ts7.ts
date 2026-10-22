// Shared TypeScript 7 parsing for tests. One API process per test run;
// everything created here stays alive until the process exits.
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { SourceFile } from 'typescript/ast';
import { API, type Checker, type Program } from 'typescript/sync';

let api: API | undefined;
const tempDirs: string[] = [];

function getApi(): API {
	if (!api) {
		api = new API({ cwd: process.cwd() });
		process.once('exit', () => {
			// The child may already be gone when exiting via process.exit().
			try {
				api?.close();
			}
			catch {}
			for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
		});
	}
	return api;
}

export function parse(fileName: string, code: string): SourceFile {
	return getApi().createSourceFile(fileName, code).sourceFile;
}

export function parseTs(code: string): SourceFile {
	return parse('/test.ts', code);
}

export function parseTsx(code: string): SourceFile {
	return parse('/test.tsx', code);
}

export interface TestProject {
	program: Program;
	checker: Checker;
	file: SourceFile;
}

// A real on-disk project holding a single file, so rules get the same
// program/checker pair the CLI hands them.
export function createProject(
	fileName: string,
	code: string,
	compilerOptions: Record<string, unknown> = {},
): TestProject {
	const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tsslint-test-')));
	tempDirs.push(dir);
	const filePath = path.join(dir, fileName);
	fs.writeFileSync(filePath, code);
	const tsconfig = path.join(dir, 'tsconfig.json');
	fs.writeFileSync(
		tsconfig,
		JSON.stringify({
			compilerOptions: { target: 'esnext', lib: ['esnext'], noEmit: true, ...compilerOptions },
			files: [fileName],
		}),
	);
	const snapshot = getApi().createSnapshot({ openProjects: [tsconfig] });
	const project = snapshot.getConfiguredProject(tsconfig)!;
	return { program: project.program, checker: project.checker, file: project.program.getSourceFile(filePath)! };
}

// A project over existing files on disk (absolute paths).
export function createProjectForFiles(
	files: string[],
	compilerOptions: Record<string, unknown> = {},
): { program: Program; checker: Checker } {
	const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tsslint-test-')));
	tempDirs.push(dir);
	const tsconfig = path.join(dir, 'tsconfig.json');
	fs.writeFileSync(tsconfig, JSON.stringify({ compilerOptions: { noEmit: true, ...compilerOptions }, files }));
	const snapshot = getApi().createSnapshot({ openProjects: [tsconfig] });
	const project = snapshot.getConfiguredProject(tsconfig)!;
	return { program: project.program, checker: project.checker };
}
