import type config = require('@tsslint/config');
import core = require('@tsslint/core');
import url = require('url');
import path = require('path');
import fs = require('fs');
import * as ts from 'typescript/ast';
import { API, type Project, type Snapshot } from 'typescript/sync';
import cacheFlow = require('./cache-flow.js');
import contentMapper = require('./content-mapper.js');
import type { LintTarget } from '@tsslint/types';
import type { CacheData } from './cache.js';
import { getConfigModulesKey, trackImports } from './config-modules.js';
import { hashFile, invalidate } from './invalidation.js';

// One TS7 API process and one snapshot holding every project of the run.
// Projects share parsed files inside the snapshot; `--fix` replaces the
// snapshot after each write.
let api: API | undefined;
let snapshot: Snapshot | undefined;

let tsconfig: string;
let linter: core.Linter;
let cache: CacheData;
// Text hashes of program files, read at most once per run.
const fileHashes = new Map<string, string>();

export function getApi(): API {
	// Content mappers run external processes declared by the project's
	// tsconfig; the project's own tsslint.config.ts is equally trusted.
	return api ??= new API({ cwd: process.cwd(), runExternalCode: true });
}

export function openProjects(tsconfigs: string[]) {
	snapshot = getApi().createSnapshot({ openProjects: tsconfigs });
}

export function getProjectFileNames(tsconfig: string): readonly string[] {
	return getProject(tsconfig).parsedCommandLine.fileNames;
}

export function close() {
	snapshot?.dispose();
	api?.close();
}

function getProject(configFileName = tsconfig): Project {
	const project = snapshot!.getConfiguredProject(configFileName);
	if (!project) {
		throw new Error(`Project not loaded: ${configFileName}`);
	}
	return project;
}

function getTarget(fileName: string): LintTarget | undefined {
	const { program, checker } = getProject();
	const file = program.getSourceFile(fileName);
	return file && { program, checker, file };
}

export function getSourceFile(fileName: string) {
	return getProject().program.getSourceFile(fileName);
}

export async function setup(
	configFile: string,
	_tsconfig: string,
	cacheData: CacheData,
): Promise<true | string> {
	let config: config.Config | config.Config[];
	trackImports();
	try {
		config = (await import(url.pathToFileURL(configFile).toString())).default;
	}
	catch (err) {
		if (err instanceof Error) {
			return err.stack ?? err.message;
		}
		return String(err);
	}

	tsconfig = _tsconfig;
	linter = core.createLinter(
		{ typescript: ts },
		path.dirname(configFile),
		config,
	);
	cache = cacheData;
	invalidate(getApi(), getProject(), cache, getConfigModulesKey(configFile), fileHashes);
	return true;
}

function hashFiles(fileNames: readonly string[]) {
	const result: Record<string, string> = {};
	for (let fileName of fileNames) {
		if (!cache.graph[fileName]) {
			// A name the rule passed to the API, or a file outside the graph
			// (`node_modules`, lib files), which the global key covers.
			const file = getProject().program.getSourceFile(fileName);
			if (!file || !cache.graph[file.fileName]) {
				continue;
			}
			fileName = file.fileName;
		}
		result[fileName] = hashFile(fileName, fileHashes);
	}
	return result;
}

export function lint(fileName: string, fix: boolean) {
	let target = getTarget(fileName);
	if (!target) {
		return [];
	}

	if (fix) {
		// Iterate to a fixed point so chained autofixes complete in one
		// CLI run. Example: `var x = 1` (never reassigned) needs no-var
		// to rewrite to `let x = 1` before prefer-const can fire and
		// rewrite to `const x = 1` — without iteration, the user has to
		// run `--fix` repeatedly. ESLint caps at 10 passes; match that.
		const MAX_FIX_PASSES = 10;
		for (let pass = 0;; pass++) {
			const diagnostics = cacheFlow.lintWithCache(linter, target, cache.files, { fix: true, hashFiles });
			const file = target.file;
			// A mapper can copy original code more than once (e.g. Vue's
			// navigation-only copies), so one edit can arrive once per copy.
			const seenEdits = new Set<string>();
			const fixes = linter
				.getCodeFixes(fileName, 0, Number.MAX_VALUE, diagnostics)
				.filter(fix => fix.fixId === 'tsslint')
				.flatMap(fix => {
					const edits = contentMapper.toOriginalTextEdits(file, fix.edits);
					if (!edits) {
						return [];
					}
					const key = JSON.stringify(edits);
					if (seenEdits.has(key)) {
						return [];
					}
					seenEdits.add(key);
					return [{ ...fix, edits }];
				});
			const edits = core.combineCodeFixes(fixes);
			if (!edits.length) {
				return diagnostics;
			}
			if (pass === MAX_FIX_PASSES) {
				// Two rules' fixes conflict (each pass undoes the other) or a
				// single rule oscillates. Surface it; staying silent leaves the
				// user thinking --fix succeeded when partial fixes remain.
				// Mirrors ESLint's "Maximum autofix passes exceeded" warning.
				console.warn(
					`[tsslint] --fix did not converge on ${fileName} after ${MAX_FIX_PASSES} passes; remaining fixable diagnostics may indicate a rule conflict.`,
				);
				return diagnostics;
			}
			fs.writeFileSync(
				fileName,
				core.applyTextEdits(contentMapper.getOriginalText(target.file), edits),
			);
			delete cache.files[fileName];
			fileHashes.delete(fileName);
			// Next run sees the file as changed and compares its signature
			// against the one from before the fix, so importers linted
			// earlier in this run are re-checked.
			if (cache.graph[fileName]) {
				cache.graph[fileName].mtime = -1;
			}
			const prev = snapshot!;
			// Listing the project again rebuilds it; otherwise it stays dirty
			// and keeps serving the old program.
			snapshot = prev.update({ fileNotifications: { changed: [fileName] }, openProjects: [tsconfig] });
			prev.dispose();
			target = getTarget(fileName)!;
		}
	}

	return cacheFlow.lintWithCache(linter, target, cache.files, { hashFiles });
}

export function hasCodeFixes(fileName: string) {
	return linter.hasCodeFixes(fileName);
}

export function hasRules(fileName: string) {
	return Object.keys(linter.getRules(fileName)).length > 0;
}
