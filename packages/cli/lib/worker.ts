import type config = require('@tsslint/config');
import core = require('@tsslint/core');
import url = require('url');
import path = require('path');
import fs = require('fs');
import * as ts from 'typescript/ast';
import { API, type Project, type Snapshot } from 'typescript/sync';
import cacheFlow = require('./cache-flow.js');
import contentMapper = require('./content-mapper.js');
import type { FileTextChanges } from '@tsslint/types';
import type { FileCache } from './cache.js';
import { getProgramFingerprint } from './fingerprint.js';

// One TS7 API process and one snapshot holding every project of the run.
// Projects share parsed files inside the snapshot; `--fix` replaces the
// snapshot after each write.
let api: API | undefined;
let snapshot: Snapshot | undefined;

let tsconfig: string;
let linter: core.Linter;
let programFingerprint: string | undefined;
let wroteFiles = false;
// Layer 2: the program is identical to the one that produced the cache,
// so cached type-aware entries are still valid.
let typeAwareUnaffected = false;

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

function getTarget(fileName: string): core.LintTarget | undefined {
	const { program, checker } = getProject();
	const file = program.getSourceFile(fileName);
	return file && { program, checker, file };
}

export async function setup(
	configFile: string,
	_tsconfig: string,
	initialTypeAwareRules: readonly string[],
	prevProgramFingerprint: string | undefined,
): Promise<true | string> {
	let config: config.Config | config.Config[];
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
		{ typescript: ts, getProgram: () => getProject().program },
		path.dirname(configFile),
		config,
		initialTypeAwareRules,
	);
	programFingerprint = getProgramFingerprint(getProject().program);
	typeAwareUnaffected = programFingerprint === prevProgramFingerprint;
	wroteFiles = false;
	return true;
}

// The fingerprint to persist with this project's cache. After `--fix`
// wrote files, type-aware results cached earlier in the run may predate
// those writes, so none of them can be trusted next session.
export function getFingerprint() {
	return wroteFiles ? undefined : programFingerprint;
}

export function lint(fileName: string, fix: boolean, fileCache: FileCache, fileMtime: number) {
	let target = getTarget(fileName);
	if (!target) {
		return [];
	}

	if (fix) {
		// Drop cache entries for rules that registered a fix in any prior
		// session — we need to actually run those rules now to rebuild the
		// `getEdits` callbacks (closures don't survive the JSON cache).
		// Rules with no fixes can stay cached.
		for (const ruleId of Object.keys(fileCache.rules)) {
			if (fileCache.rules[ruleId].hasFix) {
				delete fileCache.rules[ruleId];
			}
		}
		// Iterate to a fixed point so chained autofixes complete in one
		// CLI run. Example: `var x = 1` (never reassigned) needs no-var
		// to rewrite to `let x = 1` before prefer-const can fire and
		// rewrite to `const x = 1` — without iteration, the user has to
		// run `--fix` repeatedly. ESLint caps at 10 passes; match that.
		const MAX_FIX_PASSES = 10;
		for (let pass = 0;; pass++) {
			// Fixes mutate files mid-session, so the setup-time layer 2
			// signal no longer holds for any file.
			const diagnostics = cacheFlow.lintWithCache(linter, target, fileCache, fileMtime, { incremental: true });
			const file = target.file;
			// A mapper can copy original code more than once (e.g. Vue's
			// navigation-only copies), so one edit can arrive once per copy.
			const seenEdits = new Set<string>();
			const fixes = linter
				.getCodeFixes(fileName, 0, Number.MAX_VALUE, diagnostics)
				.filter(fix => fix.fixId === 'tsslint')
				.flatMap(fix => {
					const changes: FileTextChanges[] = [];
					for (const change of fix.changes) {
						if (change.fileName !== fileName) {
							continue;
						}
						const textChanges = contentMapper.toOriginalTextChanges(file, change.textChanges);
						if (!textChanges) {
							return [];
						}
						changes.push({ ...change, textChanges });
					}
					const key = JSON.stringify(changes.map(change => change.textChanges));
					if (seenEdits.has(key)) {
						return [];
					}
					seenEdits.add(key);
					return [{ ...fix, changes }];
				});
			const textChanges = core.combineCodeFixes(fileName, fixes);
			if (!textChanges.length) {
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
				core.applyTextChanges(contentMapper.getOriginalText(target.file), textChanges),
			);
			wroteFiles = true;
			fileMtime = fs.statSync(fileName).mtimeMs;
			// The mtime may not move within its resolution.
			fileCache.rules = {};
			const prev = snapshot!;
			// Listing the project again rebuilds it; otherwise it stays dirty
			// and keeps serving the old program.
			snapshot = prev.update({ fileNotifications: { changed: [fileName] }, openProjects: [tsconfig] });
			prev.dispose();
			target = getTarget(fileName)!;
		}
	}

	return cacheFlow.lintWithCache(linter, target, fileCache, fileMtime, {
		incremental: true,
		typeAwareUnaffected,
	});
}

export function hasCodeFixes(fileName: string) {
	return linter.hasCodeFixes(fileName);
}

export function hasRules(fileName: string) {
	return Object.keys(linter.getRules(fileName)).length > 0;
}

export function getTypeAwareRules() {
	return [...linter.getTypeAwareRules()];
}
