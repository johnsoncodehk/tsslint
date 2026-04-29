import type { Config, LinterContext, Reporter, Rule, RuleContext, Rules } from '@tsslint/types';
import type * as ts from 'typescript';

import path = require('path');
import minimatch = require('minimatch');

export type FileLintCache = [
	mtime: number,
	lintResult: Record<
		/* ruleId */ string,
		[hasFix: boolean, diagnostics: ts.DiagnosticWithLocation[]]
	>,
	minimatchResult: Record<string, boolean>,
];

export type Linter = ReturnType<typeof createLinter>;

export function createLinter(
	ctx: LinterContext,
	rootDir: string,
	config: Config | Config[],
	getRelatedInformations: (err: Error, stackIndex: number) => ts.DiagnosticRelatedInformation[],
) {
	const ts = ctx.typescript;
	const fileRules = new Map<string, Record<string, Rule>>();
	const fileConfigs = new Map<string, typeof configs>();
	const lintResults = new Map<
		/* fileName */ string,
		[
			file: ts.SourceFile,
			diagnostic2Fixes: Map<ts.DiagnosticWithLocation, {
				title: string;
				getEdits: () => ts.FileTextChanges[];
			}[]>,
			refactors: {
				title: string;
				diagnostic: ts.DiagnosticWithLocation;
				getEdits: () => ts.FileTextChanges[];
			}[],
		]
	>();
	const configs = (Array.isArray(config) ? config : [config])
		.map(config => ({
			include: config.include,
			exclude: config.exclude,
			rules: config.rules ?? {},
			plugins: (config.plugins ?? []).map(plugin => plugin(ctx)),
		}));
	const normalizedPath = new Map<string, string>();
	// Rules that touched `rulesContext.program` are type-aware: their
	// diagnostics depend on cross-file type information that the per-file
	// mtime cache can't track. We never write their results to cache, and
	// we ignore any pre-existing cached entry for them so a session that
	// classifies a rule as type-aware doesn't keep serving stale data
	// from a previous session that didn't.
	const typeAwareRules = new Set</* ruleId */ string>();

	return {
		lint(fileName: string, cache?: FileLintCache): ts.DiagnosticWithLocation[] {
			let currentRuleId: string;

			const rules = getRulesForFile(fileName, cache?.[2]);
			const token = ctx.languageServiceHost.getCancellationToken?.();
			const configs = getConfigsForFile(fileName, cache?.[2]);

			const program = ctx.languageService.getProgram()!;
			const file = program.getSourceFile(fileName)!;
			let touchedProgram = false;
			const rulesContext: RuleContext = {
				typescript: ctx.typescript,
				file,
				get program() {
					touchedProgram = true;
					return program;
				},
				report,
			};

			lintResults.set(fileName, [rulesContext.file, new Map(), []]);

			const lintResult = lintResults.get(fileName)!;

			for (const [ruleId, rule] of Object.entries(rules)) {
				if (token?.isCancellationRequested()) {
					break;
				}

				currentRuleId = ruleId;

				const ruleCache = cache?.[1][currentRuleId];
				if (ruleCache && !typeAwareRules.has(currentRuleId)) {
					let lintResult = lintResults.get(fileName);
					if (!lintResult) {
						lintResults.set(fileName, lintResult = [rulesContext.file, new Map(), []]);
					}
					for (const cacheDiagnostic of ruleCache[1]) {
						lintResult[1].set({
							...cacheDiagnostic,
							file: rulesContext.file,
							relatedInformation: cacheDiagnostic.relatedInformation?.map(info => ({
								...info,
								file: info.file ? program.getSourceFile(info.file.fileName) : undefined,
							})),
						}, []);
					}
					continue;
				}

				touchedProgram = false;
				try {
					rule(rulesContext);
				}
				catch (err) {
					if (err instanceof Error) {
						report(err.stack ?? err.message, 0, 0).at(err, 0);
					}
					else {
						report(String(err), 0, 0).at(new Error(), Number.MAX_VALUE);
					}
				}
				if (touchedProgram) {
					typeAwareRules.add(currentRuleId);
				}

				if (cache) {
					if (typeAwareRules.has(currentRuleId)) {
						// Rule is type-aware: discard any cache entry (this
						// session may have written one through `report()`
						// before the program access; a previous session may
						// have left a stale one too).
						delete cache[1][currentRuleId];
					}
					else {
						cache[1][currentRuleId] ??= [false, []];

						for (const [_, fixes] of lintResult[1]) {
							if (fixes.length) {
								cache[1][currentRuleId][0] = true;
								break;
							}
						}
					}
				}
			}

			let diagnostics = [...lintResult[1].keys()];

			for (const { plugins } of configs) {
				for (const { resolveDiagnostics } of plugins) {
					if (resolveDiagnostics) {
						diagnostics = resolveDiagnostics(rulesContext.file, diagnostics);
					}
				}
			}

			// Remove fixes and refactors that removed by resolveDiagnostics
			const diagnosticSet = new Set(diagnostics);
			for (const diagnostic of [...lintResult[1].keys()]) {
				if (!diagnosticSet.has(diagnostic)) {
					lintResult[1].delete(diagnostic);
				}
			}
			lintResult[2] = lintResult[2].filter(refactor => diagnosticSet.has(refactor.diagnostic));

			return diagnostics;

			function report(message: string, start: number, end: number): Reporter {
				const error: ts.DiagnosticWithLocation = {
					category: ts.DiagnosticCategory.Message,
					code: currentRuleId as any,
					messageText: message,
					file: rulesContext.file,
					start,
					length: end - start,
					source: 'tsslint',
					get relatedInformation() {
						return relatedInformation ??= getRelatedInformations(location[0], location[1]);
					},
					set relatedInformation(value) {
						relatedInformation = value;
					},
				};
				let location: [Error, number] = [new Error(), 1];
				let relatedInformation: ts.DiagnosticRelatedInformation[] | undefined;
				let cachedObj: ts.DiagnosticWithLocation | undefined;

				if (cache) {
					cachedObj = {
						...error,
						file: undefined as any,
						relatedInformation: error.relatedInformation?.map(info => ({
							...info,
							file: info.file ? { fileName: info.file.fileName } as any : undefined,
						})),
					};
					cache[1][currentRuleId] ??= [false, []];
					cache[1][currentRuleId][1].push(cachedObj);
				}

				let lintResult = lintResults.get(fileName);
				if (!lintResult) {
					lintResults.set(fileName, lintResult = [rulesContext.file, new Map(), []]);
				}
				const diagnostic2Fixes = lintResult[1];
				const refactors = lintResult[2];
				diagnostic2Fixes.set(error, []);
				const fixes = diagnostic2Fixes.get(error)!;

				return {
					at(err, stack) {
						location = [err, stack];
						return this;
					},
					asWarning() {
						error.category = ts.DiagnosticCategory.Warning;
						return this;
					},
					asError() {
						error.category = ts.DiagnosticCategory.Error;
						return this;
					},
					asSuggestion() {
						error.category = ts.DiagnosticCategory.Suggestion;
						return this;
					},
					withDeprecated() {
						error.reportsDeprecated = true;
						return this;
					},
					withUnnecessary() {
						error.reportsUnnecessary = true;
						return this;
					},
					withFix(title, getEdits) {
						fixes.push({ title, getEdits });
						return this;
					},
					withRefactor(title, getEdits) {
						refactors.push({
							diagnostic: error,
							title,
							getEdits,
						});
						return this;
					},
					withoutCache() {
						if (cachedObj) {
							const ruleCache = cache?.[1][currentRuleId];
							if (ruleCache) {
								const index = ruleCache[1].indexOf(cachedObj);
								if (index >= 0) {
									ruleCache[1].splice(index, 1);
								}
							}
						}
						return this;
					},
				};
			}
		},
		hasCodeFixes(fileName: string) {
			const lintResult = lintResults.get(fileName);
			if (!lintResult) {
				return false;
			}
			for (const [_, fixes] of lintResult[1]) {
				if (fixes.length) {
					return true;
				}
			}
			return false;
		},
		getCodeFixes(
			fileName: string,
			start: number,
			end: number,
			diagnostics?: ts.Diagnostic[],
			minimatchCache?: FileLintCache[2],
		) {
			const lintResult = lintResults.get(fileName);
			if (!lintResult) {
				return [];
			}

			const file = lintResult[0];
			const configs = getConfigsForFile(fileName, minimatchCache);
			const result: ts.CodeFixAction[] = [];

			for (const [diagnostic, actions] of lintResult[1]) {
				if (diagnostics?.length && !diagnostics.includes(diagnostic)) {
					continue;
				}
				const diagStart = diagnostic.start;
				const diagEnd = diagStart + diagnostic.length;
				if (
					(diagStart >= start && diagStart <= end)
					|| (diagEnd >= start && diagEnd <= end)
					|| (start >= diagStart && start <= diagEnd)
					|| (end >= diagStart && end <= diagEnd)
				) {
					let codeFixes: ts.CodeFixAction[] = [];
					for (const action of actions) {
						codeFixes.push({
							fixName: `tsslint:${diagnostic.code}`,
							description: action.title,
							changes: action.getEdits(),
							fixId: 'tsslint',
							fixAllDescription: 'Fix all TSSLint errors',
						});
					}
					for (const { plugins } of configs) {
						for (const { resolveCodeFixes } of plugins) {
							if (resolveCodeFixes) {
								codeFixes = resolveCodeFixes(file, diagnostic, codeFixes);
							}
						}
					}
					result.push(...codeFixes);
				}
			}

			return result;
		},
		getRefactors(fileName: string, start: number, end: number) {
			const lintResult = lintResults.get(fileName);
			if (!lintResult) {
				return [];
			}

			const result: ts.RefactorActionInfo[] = [];

			for (let i = 0; i < lintResult[2].length; i++) {
				const refactor = lintResult[2][i];
				const diagStart = refactor.diagnostic.start;
				const diagEnd = diagStart + refactor.diagnostic.length;
				if (
					(diagStart >= start && diagStart <= end)
					|| (diagEnd >= start && diagEnd <= end)
					|| (start >= diagStart && start <= diagEnd)
					|| (end >= diagStart && end <= diagEnd)
				) {
					result.push({
						name: `tsslint:${i}`,
						description: refactor.title,
						kind: 'quickfix',
					});
				}
			}

			return result;
		},
		getRefactorEdits(fileName: string, actionName: string) {
			if (actionName.startsWith('tsslint:')) {
				const lintResult = lintResults.get(fileName);
				if (!lintResult) {
					return [];
				}
				const index = actionName.slice('tsslint:'.length);
				const refactor = lintResult[2][Number(index)];
				if (refactor) {
					return refactor.getEdits();
				}
			}
		},
		getRules: getRulesForFile,
		getConfigs: getConfigsForFile,
	};

	function getRulesForFile(fileName: string, minimatchCache: undefined | FileLintCache[2]) {
		let rules = fileRules.get(fileName);
		if (!rules) {
			rules = {};
			const configs = getConfigsForFile(fileName, minimatchCache);
			for (const config of configs) {
				collectRules(rules, config.rules, []);
			}
			for (const { plugins } of configs) {
				for (const { resolveRules } of plugins) {
					if (resolveRules) {
						rules = resolveRules(fileName, rules);
					}
				}
			}
			fileRules.set(fileName, rules);
		}
		return rules;
	}

	function getConfigsForFile(fileName: string, minimatchCache: undefined | FileLintCache[2]) {
		let result = fileConfigs.get(fileName);
		if (!result) {
			result = configs.filter(({ include, exclude }) => {
				if (exclude?.some(_minimatch)) {
					return false;
				}
				if (include && !include.some(_minimatch)) {
					return false;
				}
				return true;
			});
			fileConfigs.set(fileName, result);
		}
		return result;

		function _minimatch(pattern: string) {
			if (minimatchCache) {
				if (pattern in minimatchCache) {
					return minimatchCache[pattern];
				}
			}
			let normalized = normalizedPath.get(pattern);
			if (!normalized) {
				normalized = ts.server.toNormalizedPath(path.resolve(rootDir, pattern));
				normalizedPath.set(pattern, normalized);
			}
			const res = minimatch.minimatch(fileName, normalized, { dot: true });
			if (minimatchCache) {
				minimatchCache[pattern] = res;
			}
			return res;
		}
	}

	function collectRules(record: Record<string, Rule>, rules: Rules, paths: string[]) {
		for (const [path, rule] of Object.entries(rules)) {
			if (typeof rule === 'object') {
				collectRules(record, rule, [...paths, path]);
				continue;
			}
			record[[...paths, path].join('/')] = rule;
		}
	}
}

export function combineCodeFixes(fileName: string, fixes: ts.CodeFixAction[]) {
	const changes = fixes
		.map(fix => fix.changes)
		.flat()
		.filter(change => change.fileName === fileName && change.textChanges.length)
		.sort((a, b) => b.textChanges[0].span.start - a.textChanges[0].span.start);

	let lastChangeAt = Number.MAX_VALUE;
	let finalTextChanges: ts.TextChange[] = [];

	for (const change of changes) {
		const textChanges = [...change.textChanges].sort((a, b) => a.span.start - b.span.start);
		const firstChange = textChanges[0];
		const lastChange = textChanges[textChanges.length - 1];
		if (lastChangeAt >= lastChange.span.start + lastChange.span.length) {
			lastChangeAt = firstChange.span.start;
			finalTextChanges = finalTextChanges.concat(textChanges);
		}
	}

	return finalTextChanges;
}

export function applyTextChanges(baseSnapshot: ts.IScriptSnapshot, textChanges: ts.TextChange[]): ts.IScriptSnapshot {
	textChanges = [...textChanges].sort((a, b) => b.span.start - a.span.start);
	let text = baseSnapshot.getText(0, baseSnapshot.getLength());
	for (const change of textChanges) {
		text = text.slice(0, change.span.start) + change.newText + text.slice(change.span.start + change.span.length);
	}
	return {
		getText(start, end) {
			return text.substring(start, end);
		},
		getLength() {
			return text.length;
		},
		getChangeRange() {
			return undefined;
		},
	};
}
