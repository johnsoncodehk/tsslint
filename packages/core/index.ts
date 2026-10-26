import type {
	CodeFixAction,
	Config,
	Diagnostic,
	LinterContext,
	LintTarget,
	RefactorAction,
	Reporter,
	Rule,
	RuleContext,
	Rules,
} from '@tsslint/types';
import type { MappedDiagnosticDirective } from 'typescript/ast';
import { DiagnosticCategory, type TextEdit } from 'typescript/sync';

import { collectTouchedFiles, trackChecker, trackProgram } from './lib/tracking';

import path = require('path');
import minimatch = require('minimatch');

export type Linter = ReturnType<typeof createLinter>;

export function createLinter(
	ctx: LinterContext,
	rootDir: string,
	config: Config | Config[],
) {
	const fileRules = new Map<string, Record<string, Rule>>();
	const fileConfigs = new Map<string, typeof configs>();
	const lintResults = new Map<
		/* fileName */ string,
		[
			target: LintTarget,
			diagnostic2Fixes: Map<Diagnostic, {
				title: string;
				getEdits: () => readonly TextEdit[];
			}[]>,
			refactors: {
				title: string;
				diagnostic: Diagnostic;
				getEdits: () => readonly TextEdit[];
			}[],
		]
	>();
	// Other program files the rules and plugins read while linting each file.
	const touchedFilesByFile = new Map<string, string[]>();
	const configs = (Array.isArray(config) ? config : [config])
		.map(config => ({
			include: config.include,
			exclude: config.exclude,
			rules: config.rules ?? {},
			plugins: (config.plugins ?? []).map(plugin => plugin(ctx)),
		}));
	const normalizedPath = new Map<string, string>();

	return {
		lint(target: LintTarget): Diagnostic[] {
			let currentRuleId: string;
			const { program, checker, file } = target;
			const fileName = file.fileName;

			const rules = getRulesForFile(fileName);
			const configs = getConfigsForFile(fileName);

			const trackedTarget: LintTarget = {
				file,
				program: trackProgram(program),
				checker: trackChecker(checker, program),
			};
			const rulesContext: RuleContext = {
				typescript: ctx.typescript,
				...trackedTarget,
				report,
			};

			lintResults.set(fileName, [target, new Map(), []]);

			const lintResult = lintResults.get(fileName)!;

			let diagnostics: Diagnostic[] = [];
			const touchedFiles = collectTouchedFiles(() => {
				for (const [ruleId, rule] of Object.entries(rules)) {
					currentRuleId = ruleId;
					try {
						rule(rulesContext);
					}
					catch (err) {
						// A crash has no position, so it carries no `fileName`.
						addDiagnostic({
							category: DiagnosticCategory.Message,
							code: 0,
							ruleId: currentRuleId,
							text: err instanceof Error ? err.stack ?? err.message : String(err),
							pos: 0,
							end: 0,
						});
					}
				}

				diagnostics = [...lintResult[1].keys()];

				const directives = file.diagnosticDirectives;
				if (directives?.length) {
					diagnostics = diagnostics.filter(diagnostic =>
						diagnostic.fileName === undefined || !isInDirective(directives, diagnostic.pos)
					);
				}

				for (const { plugins } of configs) {
					for (const { resolveDiagnostics } of plugins) {
						if (resolveDiagnostics) {
							diagnostics = resolveDiagnostics(trackedTarget, diagnostics);
						}
					}
				}
			});
			touchedFiles.delete(fileName);
			touchedFilesByFile.set(fileName, [...touchedFiles]);

			// Remove fixes and refactors that removed by resolveDiagnostics
			const diagnosticSet = new Set(diagnostics);
			for (const diagnostic of [...lintResult[1].keys()]) {
				if (!diagnosticSet.has(diagnostic)) {
					lintResult[1].delete(diagnostic);
				}
			}
			lintResult[2] = lintResult[2].filter(refactor => diagnosticSet.has(refactor.diagnostic));

			return diagnostics;

			function addDiagnostic(diagnostic: Diagnostic) {
				let lintResult = lintResults.get(fileName);
				if (!lintResult) {
					lintResults.set(fileName, lintResult = [target, new Map(), []]);
				}
				const fixes: { title: string; getEdits: () => readonly TextEdit[] }[] = [];
				lintResult[1].set(diagnostic, fixes);
				return { fixes, refactors: lintResult[2] };
			}

			function report(message: string, start: number, end: number): Reporter {
				const error: Diagnostic = {
					category: DiagnosticCategory.Message,
					code: 0,
					ruleId: currentRuleId,
					text: message,
					fileName: file.fileName,
					pos: start,
					end,
				};
				const { fixes, refactors } = addDiagnostic(error);

				return {
					at() {
						return this;
					},
					asWarning() {
						error.category = DiagnosticCategory.Warning;
						return this;
					},
					asError() {
						error.category = DiagnosticCategory.Error;
						return this;
					},
					asSuggestion() {
						error.category = DiagnosticCategory.Suggestion;
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
			diagnostics?: Diagnostic[],
		) {
			const lintResult = lintResults.get(fileName);
			if (!lintResult) {
				return [];
			}

			const target = lintResult[0];
			const configs = getConfigsForFile(fileName);
			const result: CodeFixAction[] = [];

			for (const [diagnostic, actions] of lintResult[1]) {
				if (diagnostics?.length && !diagnostics.includes(diagnostic)) {
					continue;
				}
				const diagStart = diagnostic.pos;
				const diagEnd = diagnostic.end;
				if (
					(diagStart >= start && diagStart <= end)
					|| (diagEnd >= start && diagEnd <= end)
					|| (start >= diagStart && start <= diagEnd)
					|| (end >= diagStart && end <= diagEnd)
				) {
					let codeFixes: CodeFixAction[] = [];
					for (const action of actions) {
						codeFixes.push({
							fixName: `tsslint:${diagnostic.ruleId}`,
							description: action.title,
							edits: action.getEdits(),
							fixId: 'tsslint',
							fixAllDescription: 'Fix all TSSLint errors',
						});
					}
					for (const { plugins } of configs) {
						for (const { resolveCodeFixes } of plugins) {
							if (resolveCodeFixes) {
								codeFixes = resolveCodeFixes(target, diagnostic, codeFixes);
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

			const result: RefactorAction[] = [];

			for (let i = 0; i < lintResult[2].length; i++) {
				const refactor = lintResult[2][i];
				const diagStart = refactor.diagnostic.pos;
				const diagEnd = refactor.diagnostic.end;
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
		/**
		 * Other files the last `lint` of `fileName` read beyond their
		 * declarations: their nodes, source files, diagnostics or emit. Names
		 * passed to the API by the rule are returned as given.
		 */
		getTouchedFiles(fileName: string): readonly string[] {
			return touchedFilesByFile.get(fileName) ?? [];
		},
	};

	function getRulesForFile(fileName: string) {
		let rules = fileRules.get(fileName);
		if (!rules) {
			rules = {};
			const configs = getConfigsForFile(fileName);
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

	function getConfigsForFile(fileName: string) {
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
			let normalized = normalizedPath.get(pattern);
			if (!normalized) {
				normalized = path.resolve(rootDir, pattern).replace(/\\/g, '/');
				normalizedPath.set(pattern, normalized);
			}
			return minimatch.minimatch(fileName, normalized, { dot: true });
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

// A content mapper's Ignore and Expect directives both suppress rule
// reports that start inside their virtual range. An unused Expect is
// reported by TypeScript itself, so there is nothing to add here.
function isInDirective(directives: readonly MappedDiagnosticDirective[], start: number) {
	return directives.some(({ virtualRange }) => start >= virtualRange.pos && start < virtualRange.end);
}

export function combineCodeFixes(fixes: CodeFixAction[]) {
	// Match ESLint's `compareMessagesByFixRange` order so overlap resolution
	// agrees with applyFixes: sort ASC by start, tie-break ASC by end. The
	// earliest-starting fix wins; later overlapping fixes are dropped. (e.g.
	// for `'foo' as 'foo'` where no-unnecessary-type-assertion spans the
	// whole assertion and prefer-as-const just the inner literal, ESLint
	// keeps the wider no-unnecessary fix and prefer-as-const is silently
	// skipped — see eslint/lib/linter/source-code-fixer.js:124.)
	const editLists = fixes
		.map(fix => fix.edits)
		.filter(edits => edits.length)
		.sort((a, b) => a[0].pos - b[0].pos || a[0].end - b[0].end);

	let lastEditEndAt = -1;
	let finalEdits: TextEdit[] = [];

	for (const editList of editLists) {
		const edits = [...editList].sort((a, b) => a.pos - b.pos);
		if (edits[0].pos >= lastEditEndAt) {
			lastEditEndAt = edits[edits.length - 1].end;
			finalEdits = finalEdits.concat(edits);
		}
	}

	return finalEdits;
}

export function applyTextEdits(text: string, edits: readonly TextEdit[]): string {
	const sorted = [...edits].sort((a, b) => b.pos - a.pos);
	for (const edit of sorted) {
		text = text.slice(0, edit.pos) + edit.newText + text.slice(edit.end);
	}
	return text;
}
