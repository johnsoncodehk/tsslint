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
import type { FileCache, SerializedDiagnostic, SerializedRelatedInfo } from './cache.js';

export function lintWithCache(
	linter: Linter,
	fileName: string,
	fileCache: FileCache,
	fileMtime: number,
	program: ts.Program,
): ts.DiagnosticWithLocation[] {
	// File mtime is the layer-1 invalidation key. Anything that touched
	// the file's text drops every cached rule entry — those rules will
	// re-run because they vanish from the skip set.
	if (fileCache.mtime !== fileMtime) {
		fileCache.mtime = fileMtime;
		fileCache.rules = {};
	}

	// Cache hit only when:
	//   - this file has a cache entry for the rule
	//   - the rule has not been classified type-aware (in any past or
	//     current session)
	// Type-aware rules' entries get cleaned up below regardless of
	// whether they're stale from before this fix shipped.
	const typeAware = linter.getTypeAwareRules();
	const skipRules = new Set<string>();
	for (const ruleId of Object.keys(fileCache.rules)) {
		if (!typeAware.has(ruleId)) {
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
	// cache. Type-aware rules: delete any entry, never write. Syntactic:
	// write the freshly-computed entry.
	const allRuleIds = Object.keys(linter.getRules(fileName));
	for (const ruleId of allRuleIds) {
		if (skipRules.has(ruleId)) continue;
		if (typeAware.has(ruleId)) {
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
		})) as SerializedRelatedInfo[] | undefined,
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
