export * from './lib/build';
export * from './lib/watch';

import type {
	Config,
	ProjectContext,
	Reporter,
	Rule,
	RuleContext,
	Rules,
	FormattingProcess,
	FormattingContext,
} from '@tsslint/types';
import type * as ts from 'typescript';

import ErrorStackParser = require('error-stack-parser');
import path = require('path');
import minimatch = require('minimatch');

export type FileLintCache = [
	mtime: number,
	lintResult: Record<
		/* ruleId */ string,
		[hasFix: boolean, diagnostics: ts.DiagnosticWithLocation[]]
	>,
	minimatchResult: Record<string, boolean>,
	formated: boolean,
];

export type Linter = ReturnType<typeof createLinter>;

export function createLinter(
	ctx: ProjectContext,
	rootDir: string,
	config: Config | Config[],
	mode: 'cli' | 'typescript-plugin',
	syntaxOnlyLanguageService?: ts.LanguageService & {
		getNonBoundSourceFile?(fileName: string): ts.SourceFile;
	}
) {
	const ts = ctx.typescript;
	const fileRules = new Map<string, Record<string, Rule>>();
	const fileFmtProcesses = new Map<string, FormattingProcess[]>();
	const fileConfigs = new Map<string, typeof configs>();
	const lintResults = new Map<
		/* fileName */ string,
		[
			sourceFile: ts.SourceFile,
			diagnostic2Fixes: Map<ts.DiagnosticWithLocation, {
				title: string;
				getEdits: () => ts.FileTextChanges[];
			}[]>,
			{
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
			formatting: config.formatting,
			plugins: (config.plugins ?? []).map(plugin => plugin(ctx)),
		}));
	const normalizedPath = new Map<string, string>();
	const rule2Mode = new Map<string, /* typeAwareMode */ boolean>();
	const getNonBoundSourceFile = syntaxOnlyLanguageService?.getNonBoundSourceFile;

	let shouldEnableTypeAware = false;

	return {
		format(sourceFile: ts.SourceFile, minimatchCache?: FileLintCache[2]): ts.TextChange[] {
			const preprocess = getFileFmtProcesses(sourceFile.fileName, minimatchCache);
			const changes: ts.TextChange[] = [];
			const tmpChanges: ts.TextChange[] = [];
			const fmtCtx: FormattingContext = {
				typescript: ts,
				sourceFile,
				insert(pos, text) {
					tmpChanges.push({ span: { start: pos, length: 0 }, newText: text });
				},
				remove(start, end) {
					tmpChanges.push({ span: { start, length: end - start }, newText: '' });
				},
				replace(start, end, text) {
					tmpChanges.push({ span: { start, length: end - start }, newText: text });
				},
			};
			for (const process of preprocess) {
				process(fmtCtx);
				if (tmpChanges.every(a => {
					const aStart = a.span.start;
					const aEnd = aStart + a.span.length;
					for (const b of changes) {
						const bStart = b.span.start;
						const bEnd = bStart + b.span.length;
						if (
							(bStart >= aEnd && bStart > aStart)
							|| (bEnd <= aStart && bEnd < aEnd)
						) {
							continue;
						}
						return false;
					}
					return true;
				})) {
					changes.push(...tmpChanges);
				}
				tmpChanges.length = 0;
			}
			return changes;
		},
		lint(fileName: string, cache?: FileLintCache): ts.DiagnosticWithLocation[] {
			let currentRuleId: string;
			let shouldRetry = false;

			const rules = getFileRules(fileName, cache?.[2]);
			const typeAwareMode = !getNonBoundSourceFile
				|| shouldEnableTypeAware && !Object.keys(rules).some(ruleId => !rule2Mode.has(ruleId));
			const rulesContext: RuleContext = typeAwareMode
				? {
					...ctx,
					sourceFile: ctx.languageService.getProgram()!.getSourceFile(fileName)!,
					reportError,
					reportWarning,
					reportSuggestion,
				}
				: {
					...ctx,
					languageService: syntaxOnlyLanguageService!,
					sourceFile: getNonBoundSourceFile(fileName),
					reportError,
					reportWarning,
					reportSuggestion,
				};
			const token = ctx.languageServiceHost.getCancellationToken?.();
			const configs = getFileConfigs(fileName, cache?.[2]);

			lintResults.set(fileName, [rulesContext.sourceFile, new Map(), []]);

			const lintResult = lintResults.get(fileName)!;

			for (const [ruleId, rule] of Object.entries(rules)) {
				if (token?.isCancellationRequested()) {
					break;
				}

				currentRuleId = ruleId;

				const ruleCache = cache?.[1][currentRuleId];
				if (ruleCache) {
					let lintResult = lintResults.get(fileName);
					if (!lintResult) {
						lintResults.set(fileName, lintResult = [rulesContext.sourceFile, new Map(), []]);
					}
					for (const cacheDiagnostic of ruleCache[1]) {
						lintResult[1].set({
							...cacheDiagnostic,
							file: rulesContext.sourceFile,
							relatedInformation: cacheDiagnostic.relatedInformation?.map(info => ({
								...info,
								file: info.file ? (syntaxOnlyLanguageService as any).getNonBoundSourceFile(info.file.fileName) : undefined,
							})),
						}, []);
					}
					if (!typeAwareMode) {
						rule2Mode.set(currentRuleId, false);
					}
					continue;
				}

				try {
					rule(rulesContext);
					if (!typeAwareMode) {
						rule2Mode.set(currentRuleId, false);
					}
				} catch (err) {
					if (!typeAwareMode) {
						// console.log(`Rule "${currentRuleId}" is type aware.`);
						rule2Mode.set(currentRuleId, true);
						shouldRetry = true;
					} else if (err instanceof Error) {
						report(ts.DiagnosticCategory.Error, err.stack ?? err.message, 0, 0, 0, err);
					} else {
						report(ts.DiagnosticCategory.Error, String(err), 0, 0, false);
					}
				}

				if (cache && !rule2Mode.get(currentRuleId)) {
					cache[1][currentRuleId] ??= [false, []];

					for (const [_, fixes] of lintResult[1]) {
						if (fixes.length) {
							cache[1][currentRuleId][0] = true;
							break;
						}
					}
				}
			}

			if (shouldRetry) {
				// Retry
				shouldEnableTypeAware = true;
				return this.lint(fileName, cache);
			}

			let diagnostics = [...lintResult[1].keys()];

			try {
				for (const { plugins } of configs) {
					for (const { resolveDiagnostics } of plugins) {
						if (resolveDiagnostics) {
							diagnostics = resolveDiagnostics(rulesContext.sourceFile, diagnostics);
						}
					}
				}
			} catch (error) {
				if (!typeAwareMode) {
					// Retry
					shouldEnableTypeAware = true;
					return this.lint(fileName, cache);
				}
				throw error;
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

			function reportError(message: string, start: number, end: number, stackOffset?: false | number) {
				return report(ts.DiagnosticCategory.Error, message, start, end, stackOffset);
			}

			function reportWarning(message: string, start: number, end: number, stackOffset?: false | number) {
				return report(ts.DiagnosticCategory.Warning, message, start, end, stackOffset);
			}

			function reportSuggestion(message: string, start: number, end: number, stackOffset?: false | number) {
				return report(ts.DiagnosticCategory.Suggestion, message, start, end, stackOffset);
			}

			function report(category: ts.DiagnosticCategory, message: string, start: number, end: number, stackOffset: false | number = 2, err?: Error): Reporter {
				const error: ts.DiagnosticWithLocation = {
					category,
					code: currentRuleId as any,
					messageText: message,
					file: rulesContext.sourceFile,
					start,
					length: end - start,
					source: 'tsslint',
					relatedInformation: [],
				};

				if (cache && !rule2Mode.get(currentRuleId)) {
					cache[1][currentRuleId] ??= [false, []];
					cache[1][currentRuleId][1].push({
						...error,
						file: undefined as any,
						relatedInformation: error.relatedInformation?.map(info => ({
							...info,
							file: info.file ? { fileName: info.file.fileName } as any : undefined,
						})),
					});
				}

				if (mode === 'typescript-plugin' && typeof stackOffset === 'number') {
					err ??= new Error();
					const relatedInfo = createRelatedInformation(ts, err, stackOffset);
					if (relatedInfo) {
						error.relatedInformation!.push(relatedInfo);
					}
				}

				let lintResult = lintResults.get(fileName);
				if (!lintResult) {
					lintResults.set(fileName, lintResult = [rulesContext.sourceFile, new Map(), []]);
				}
				const diagnostic2Fixes = lintResult[1];
				const refactors = lintResult[2];
				diagnostic2Fixes.set(error, []);
				const fixes = diagnostic2Fixes.get(error)!;

				return {
					withDeprecated() {
						error.reportsDeprecated = true;
						return this;
					},
					withUnnecessary() {
						error.reportsUnnecessary = true;
						return this;
					},
					withFix(title, getEdits) {
						fixes.push(({ title, getEdits }));
						return this;
					},
					withRefactor(title, getEdits) {
						refactors.push(({
							diagnostic: error,
							title,
							getEdits,
						}));
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
			minimatchCache?: FileLintCache[2]
		) {
			const lintResult = lintResults.get(fileName);
			if (!lintResult) {
				return [];
			}

			const sourceFile = lintResult[0];
			const configs = getFileConfigs(fileName, minimatchCache);
			const result: ts.CodeFixAction[] = [];

			for (const [diagnostic, actions] of lintResult[1]) {
				if (diagnostics?.length && !diagnostics.includes(diagnostic)) {
					continue;
				}
				const diagStart = diagnostic.start;
				const diagEnd = diagStart + diagnostic.length;
				if (
					(diagStart >= start && diagStart <= end) ||
					(diagEnd >= start && diagEnd <= end) ||
					(start >= diagStart && start <= diagEnd) ||
					(end >= diagStart && end <= diagEnd)
				) {
					let codeFixes: ts.CodeFixAction[] = [];
					for (const action of actions) {
						codeFixes.push({
							fixName: `tsslint:${diagnostic.code}`,
							description: action.title,
							changes: action.getEdits(),
							fixId: 'tsslint',
							fixAllDescription: 'Fix all TSSLint errors'
						});
					}
					for (const { plugins } of configs) {
						for (const { resolveCodeFixes } of plugins) {
							if (resolveCodeFixes) {
								codeFixes = resolveCodeFixes(sourceFile, diagnostic, codeFixes);
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
					(diagStart >= start && diagStart <= end) ||
					(diagEnd >= start && diagEnd <= end) ||
					(start >= diagStart && start <= diagEnd) ||
					(end >= diagStart && end <= diagEnd)
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
		getRules: getFileRules,
		getConfigs: getFileConfigs,
	};

	function getFileFmtProcesses(fileName: string, minimatchCache: undefined | FileLintCache[2]) {
		if (!fileFmtProcesses.has(fileName)) {
			const allPreprocess: FormattingProcess[] = [];
			const configs = getFileConfigs(fileName, minimatchCache);
			for (const { formatting } of configs) {
				if (formatting) {
					allPreprocess.push(...formatting);
				}
			}
			fileFmtProcesses.set(fileName, allPreprocess);
		}
		return fileFmtProcesses.get(fileName)!;
	}

	function getFileRules(fileName: string, minimatchCache: undefined | FileLintCache[2]) {
		let rules = fileRules.get(fileName);
		if (!rules) {
			rules = {};
			const configs = getFileConfigs(fileName, minimatchCache);
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

	function collectRules(record: Record<string, Rule>, rules: Rules, paths: string[]) {
		for (const [path, rule] of Object.entries(rules)) {
			if (typeof rule === 'object') {
				collectRules(record, rule, [...paths, path]);
				continue;
			}
			record[[...paths, path].join('/')] = rule;
		}
	}

	function getFileConfigs(fileName: string, minimatchCache: undefined | FileLintCache[2]) {
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
		return result;
	}
}

const fsFiles = new Map<string, [exist: boolean, mtime: number, ts.SourceFile]>();

export function createRelatedInformation(ts: typeof import('typescript'), err: Error, stackOffset: number): ts.DiagnosticRelatedInformation | undefined {
	const stacks = ErrorStackParser.parse(err);
	if (stacks.length <= stackOffset) {
		return;
	}
	const stack = stacks[stackOffset];
	if (stack.fileName && stack.lineNumber !== undefined && stack.columnNumber !== undefined) {
		let fileName = stack.fileName.replace(/\\/g, '/');
		if (fileName.startsWith('file://')) {
			fileName = fileName.substring('file://'.length);
		}
		if (fileName.includes('http-url:')) {
			fileName = fileName.split('http-url:')[1];
		}
		const mtime = ts.sys.getModifiedTime?.(fileName)?.getTime() ?? 0;
		const lastMtime = fsFiles.get(fileName)?.[1];
		if (mtime !== lastMtime) {
			const text = ts.sys.readFile(fileName);
			fsFiles.set(
				fileName,
				[
					text !== undefined,
					mtime,
					ts.createSourceFile(fileName, text ?? '', ts.ScriptTarget.Latest, true)
				]
			);
		}
		const [exist, _mtime, relatedFile] = fsFiles.get(fileName)!;
		let pos = 0;
		if (exist) {
			try {
				pos = relatedFile.getPositionOfLineAndCharacter(stack.lineNumber - 1, stack.columnNumber - 1) ?? 0;
			} catch { }
		}
		return {
			category: ts.DiagnosticCategory.Message,
			code: 0,
			file: relatedFile,
			start: pos,
			length: 0,
			messageText: 'at ' + (stack.functionName ?? '<anonymous>'),
		};
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
		getChangeRange(oldSnapshot) {
			if (oldSnapshot === baseSnapshot) {
				// TODO
			}
			return undefined;
		},
	};
}
