export * from './lib/build';
export * from './lib/watch';

import type { Config, ProjectContext, Reporter, RuleContext, Rules } from '@tsslint/types';
import type * as ts from 'typescript';

import ErrorStackParser = require('error-stack-parser');
import path = require('path');
import minimatch = require('minimatch');

export type FileLintCache = [
	mtime: number,
	ruleResult: Record<string, [fixesNum: number, diagnostics: ts.DiagnosticWithLocation[]]>,
	minimatchResult: Record<string, boolean>,
];

export type Linter = ReturnType<typeof createLinter>;

const typeAwareModeChange = new Error('enable type-aware mode');

export function createLinter(
	ctx: ProjectContext,
	config: Config | Config[],
	mode: 'cli' | 'typescript-plugin'
) {
	let languageServiceUsage = 0;

	const ts = ctx.typescript;
	const languageService = new Proxy(ctx.languageService, {
		get(target, key, receiver) {
			if (!languageServiceUsage) {
				languageServiceUsage++;
				throw typeAwareModeChange;
			}
			languageServiceUsage++;
			return Reflect.get(target, key, receiver);
		},
	});
	const fileRules = new Map<string, Rules>();
	const fileConfigs = new Map<string, typeof configs>();
	const fileFixes = new Map<
		string /* fileName */,
		Map<ts.DiagnosticWithLocation, {
			title: string;
			getEdits: () => ts.FileTextChanges[];
		}[]>
	>();
	const fileRefactors = new Map<
		string /* fileName */,
		{
			title: string;
			diagnostic: ts.DiagnosticWithLocation;
			getEdits: () => ts.FileTextChanges[];
		}[]
	>();
	const snapshot2SourceFile = new WeakMap<ts.IScriptSnapshot, ts.SourceFile>();
	const basePath = path.dirname(ctx.configFile);
	const configs = (Array.isArray(config) ? config : [config])
		.map(config => ({
			include: config.include ?? [],
			exclude: config.exclude ?? [],
			rules: config.rules ?? {},
			plugins: (config.plugins ?? []).map(plugin => plugin(ctx)),
		}));
	const normalizedPath = new Map<string, string>();

	return {
		lint(fileName: string, cache?: FileLintCache): ts.DiagnosticWithLocation[] {
			let diagnostics: ts.DiagnosticWithLocation[] = [];
			let currentRuleId: string;
			let currentIssues = 0;
			let currentFixes = 0;
			let currentRefactors = 0;
			let currentRuleLanguageServiceUsage = 0;
			let sourceFile: ts.SourceFile | undefined;

			const rules = getFileRules(fileName, cache?.[2]);
			const rulesContext: RuleContext = {
				...ctx,
				languageService,
				get sourceFile() {
					return sourceFile ??= getSourceFile(fileName);
				},
				reportError,
				reportWarning,
				reportSuggestion,
			};
			const token = ctx.languageServiceHost.getCancellationToken?.();
			const fixes = getFileFixes(fileName);
			const refactors = getFileRefactors(fileName);
			const configs = getFileConfigs(fileName, cache?.[2]);

			fixes.clear();
			refactors.length = 0;

			if (!runRules(rules)) {
				return this.lint(fileName, cache);
			}

			for (const { plugins } of configs) {
				for (const { resolveDiagnostics } of plugins) {
					if (resolveDiagnostics) {
						diagnostics = resolveDiagnostics(rulesContext.sourceFile, diagnostics);
					}
				}
			}

			// Remove fixes and refactors that removed by resolveDiagnostics
			const diagnosticSet = new Set(diagnostics);
			for (const diagnostic of [...fixes.keys()]) {
				if (!diagnosticSet.has(diagnostic)) {
					fixes.delete(diagnostic);
				}
			}
			fileRefactors.set(fileName, refactors.filter(refactor => diagnosticSet.has(refactor.diagnostic)));

			return diagnostics;

			function runRules(rules: Rules, paths: string[] = []) {
				for (const [path, rule] of Object.entries(rules)) {
					if (token?.isCancellationRequested()) {
						break;
					}
					if (typeof rule === 'object') {
						if (!runRules(rule, [...paths, path])) {
							return false;
						}
						continue;
					}

					currentRuleLanguageServiceUsage = languageServiceUsage;
					currentRuleId = [...paths, path].join('/');
					currentIssues = 0;
					currentFixes = 0;
					currentRefactors = 0;

					if (cache) {
						const ruleCache = cache[1][currentRuleId];
						if (ruleCache) {
							diagnostics.push(
								...ruleCache[1].map(data => ({
									...data,
									file: rulesContext.sourceFile,
									relatedInformation: data.relatedInformation?.map(info => ({
										...info,
										file: info.file ? getSourceFile(info.file.fileName) : undefined,
									})),
								}))
							);
							continue;
						}
					}

					try {
						rule(rulesContext);
					} catch (err) {
						if (err === typeAwareModeChange) {
							// logger?.log.message(`Type-aware mode enabled by ${currentRuleId} rule.`);
							return false;
						} else if (err instanceof Error) {
							report(ts.DiagnosticCategory.Error, err.stack ?? err.message, 0, 0, 0, err);
						} else {
							report(ts.DiagnosticCategory.Error, String(err), 0, 0, false);
						}
					}

					if (cache) {
						if (currentRuleLanguageServiceUsage === languageServiceUsage) {
							cache[1][currentRuleId] ??= [0, []];
							cache[1][currentRuleId][0] = currentIssues;
						}
					}
				}
				return true;
			};

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
				const cacheable = currentRuleLanguageServiceUsage === languageServiceUsage;

				if (cache && cacheable) {
					cache[1][currentRuleId] ??= [0, []];
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

				fixes.set(error, []);
				diagnostics.push(error);
				currentIssues++;

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
						currentFixes++;
						fixes.get(error)!.push(({ title, getEdits }));
						return this;
					},
					withRefactor(title, getEdits) {
						currentRefactors++;
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

			const fixesMap = getFileFixes(fileName);

			for (const [_diagnostic, actions] of fixesMap) {
				if (actions.length) {
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

			const configs = getFileConfigs(fileName, minimatchCache);
			const fixesMap = getFileFixes(fileName);
			const result: ts.CodeFixAction[] = [];

			for (const [diagnostic, actions] of fixesMap) {
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
								codeFixes = resolveCodeFixes(getSourceFile(fileName), diagnostic, codeFixes);
							}
						}
					}
					result.push(...codeFixes);
				}
			}

			return result;
		},
		getRefactors(fileName: string, start: number, end: number) {

			const refactors = getFileRefactors(fileName);
			const result: ts.RefactorActionInfo[] = [];

			for (let i = 0; i < refactors.length; i++) {
				const refactor = refactors[i];
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
				const index = actionName.slice('tsslint:'.length);
				const actions = getFileRefactors(fileName);
				const refactor = actions[Number(index)];
				if (refactor) {
					return refactor.getEdits();
				}
			}
		},
		getRules: getFileRules,
		getConfigs: getFileConfigs,
	};

	function getSourceFile(fileName: string): ts.SourceFile {
		if (languageServiceUsage) {
			const sourceFile = ctx.languageService.getProgram()!.getSourceFile(fileName);
			if (sourceFile) {
				return sourceFile;
			}
		}
		else {
			const snapshot = ctx.languageServiceHost.getScriptSnapshot(fileName);
			if (snapshot) {
				if (!snapshot2SourceFile.has(snapshot)) {
					const sourceFile = ts.createSourceFile(fileName, snapshot.getText(0, snapshot.getLength()), ts.ScriptTarget.ESNext, true);
					snapshot2SourceFile.set(snapshot, sourceFile);
					return sourceFile;
				}
				return snapshot2SourceFile.get(snapshot)!;
			}
		}
		throw new Error('No source file');
	}

	function getFileRules(fileName: string, minimatchCache: undefined | FileLintCache[2]) {
		let result = fileRules.get(fileName);
		if (!result) {
			result = {};
			const configs = getFileConfigs(fileName, minimatchCache);
			for (const { rules } of configs) {
				result = {
					...result,
					...rules,
				};
			}
			for (const { plugins } of configs) {
				for (const { resolveRules } of plugins) {
					if (resolveRules) {
						result = resolveRules(fileName, result);
					}
				}
			}
			fileRules.set(fileName, result);
		}
		return result;
	}

	function getFileConfigs(fileName: string, minimatchCache: undefined | FileLintCache[2]) {
		let result = fileConfigs.get(fileName);
		if (!result) {
			result = configs.filter(({ include, exclude }) => {
				if (exclude.some(_minimatch)) {
					return false;
				}
				if (include.length && !include.some(_minimatch)) {
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
					normalized = ts.server.toNormalizedPath(path.resolve(basePath, pattern));
					normalizedPath.set(pattern, normalized);
				}
				const res = minimatch.minimatch(fileName, normalized);
				if (minimatchCache) {
					minimatchCache[pattern] = res;
				}
				return res;
			}
		}
		return result;
	}

	function getFileFixes(fileName: string) {
		if (!fileFixes.has(fileName)) {
			fileFixes.set(fileName, new Map());
		}
		return fileFixes.get(fileName)!;
	}

	function getFileRefactors(fileName: string) {
		if (!fileRefactors.has(fileName)) {
			fileRefactors.set(fileName, []);
		}
		return fileRefactors.get(fileName)!;
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
