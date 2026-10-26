// A real on-disk TypeScript 7 project for core tests. One API process
// per test run; temp dirs are removed when the process exits.
import type { LinterContext, LintTarget } from '@tsslint/types';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as ts from 'typescript/ast';
import { API } from 'typescript/sync';

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

export function createProject(files: Record<string, string>) {
	const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tsslint-cli-test-')));
	tempDirs.push(dir);
	for (const [name, text] of Object.entries(files)) {
		fs.writeFileSync(path.join(dir, name), text);
	}
	const tsconfig = path.join(dir, 'tsconfig.json');
	fs.writeFileSync(
		tsconfig,
		JSON.stringify({
			compilerOptions: { target: 'esnext', lib: ['esnext'], noEmit: true },
			files: Object.keys(files),
		}),
	);
	const snapshot = getApi().createSnapshot({ openProjects: [tsconfig] });
	const { program, checker } = snapshot.getConfiguredProject(tsconfig)!;
	const ctx: LinterContext = { typescript: ts };
	return {
		ctx,
		rootDir: dir,
		target(name: string): LintTarget {
			return { program, checker, file: program.getSourceFile(path.join(dir, name))! };
		},
	};
}
