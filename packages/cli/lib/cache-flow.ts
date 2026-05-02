// Cache-aware wrapper around `linter.lint`. Decides which rules to skip
// based on the file's cached entries + the linter's type-aware
// classification, calls into core with `skipRules`, and merges the
// freshly-computed diagnostics with the rehydrated cached ones.
//
// Core knows nothing about the cache shape or lifecycle. It just runs
// rules and returns diagnostics. Everything in this module is the
// CLI's responsibility — serialization, mtime invalidation, sticky
// type-aware cleanup.

import type * as ts from 'typescript';
import type { Linter } from '@tsslint/core';
import type { FileCache, SerializedDiagnostic } from './cache.js';

export function lintWithCache(
	linter: Linter,
	fileName: string,
	fileCache: FileCache,
	fileMtime: number,
	program: ts.Program,
	options?: {
		// Layer 2 signal from the caller: BuilderProgram (or equivalent
		// affected-file tracker) says this file's type-relevant inputs —
		// own text, transitive imports, ambient declarations, lib —
		// haven't moved since the cached entries were written.
		//
		// When true: type-aware rules behave like syntactic ones for
		// caching purposes — cached entries can be reused, and fresh runs
		// write back. When false / undefined: type-aware rules are always
		// re-run and their cache entries deleted. The default is the
		// safe one because mtime alone can't catch ambient-declaration
		// edits that change a file's effective types without touching
		// its text.
		typeAwareUnaffected?: boolean;
	},
): ts.DiagnosticWithLocation[] {
	// File mtime is the layer-1 invalidation key. Anything that touched
	// the file's text drops every cached rule entry — those rules will
	// re-run because they vanish from the skip set.
	if (fileCache.mtime !== fileMtime) {
		fileCache.mtime = fileMtime;
		fileCache.rules = {};
	}

	const typeAwareCanCache = options?.typeAwareUnaffected === true;
	const typeAware = linter.getTypeAwareRules();

	// Cache hit only when this file has a cache entry for the rule AND
	// either:
	//   - the rule is not classified type-aware, or
	//   - the rule is type-aware but the caller signalled the file is
	//     unaffected this session (layer 2)
	const skipRules = new Set<string>();
	for (const ruleId of Object.keys(fileCache.rules)) {
		if (typeAware.has(ruleId)) {
			if (typeAwareCanCache) {
				skipRules.add(ruleId);
			}
			// else: re-run; the post-rule write path will overwrite the
			// stale entry or delete it depending on classification.
		}
		else {
			skipRules.add(ruleId);
		}
	}

	const fresh = linter.lint(fileName, { skipRules });

	// Group fresh diagnostics by rule. `report()` in core sets
	// `diagnostic.code = ruleId`, so the attribution is intrinsic.
	const byRule = new Map<string, ts.DiagnosticWithLocation[]>();
	for (const diag of fresh) {
		const ruleId = String(diag.code);
		let bucket = byRule.get(ruleId);
		if (!bucket) byRule.set(ruleId, bucket = []);
		bucket.push(diag);
	}

	// For every rule that actually ran (i.e. not skipped), update the
	// cache. Type-aware rules without the unaffected signal: delete any
	// entry, never write. Otherwise (syntactic, or type-aware with
	// signal): write the freshly-computed entry.
	const allRuleIds = Object.keys(linter.getRules(fileName));
	for (const ruleId of allRuleIds) {
		if (skipRules.has(ruleId)) continue;
		if (typeAware.has(ruleId) && !typeAwareCanCache) {
			delete fileCache.rules[ruleId];
			continue;
		}
		const diags = byRule.get(ruleId) ?? [];
		let hasFix = false;
		for (const diag of diags) {
			if (linter.hasFixForDiagnostic(fileName, diag)) {
				hasFix = true;
				break;
			}
		}
		fileCache.rules[ruleId] = {
			hasFix,
			diagnostics: diags.map(serializeDiagnostic),
		};
	}

	// Restore cached diagnostics for the rules we skipped. Rehydrate
	// `file` from the current Program — the cached form drops live
	// SourceFile refs at write time.
	const restored: ts.DiagnosticWithLocation[] = [];
	for (const ruleId of skipRules) {
		const entry = fileCache.rules[ruleId];
		if (!entry) continue;
		for (const sd of entry.diagnostics) {
			restored.push(deserializeDiagnostic(sd, fileName, program));
		}
	}

	return [...restored, ...fresh];
}

function serializeDiagnostic(d: ts.DiagnosticWithLocation): SerializedDiagnostic {
	const { file, relatedInformation, ...rest } = d;
	void file;
	return {
		...rest,
		relatedInformation: relatedInformation?.map(info => ({
			...info,
			file: info.file ? { fileName: info.file.fileName } : undefined,
		})),
	};
}

function deserializeDiagnostic(
	sd: SerializedDiagnostic,
	fileName: string,
	program: ts.Program,
): ts.DiagnosticWithLocation {
	return {
		...sd,
		file: program.getSourceFile(fileName)!,
		relatedInformation: sd.relatedInformation?.map(info => ({
			...info,
			file: info.file ? program.getSourceFile(info.file.fileName) : undefined,
		})),
	};
}
