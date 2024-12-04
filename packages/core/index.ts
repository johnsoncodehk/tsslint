export * from './lib/build';
export * from './lib/watch';

import type { Config, ProjectContext, Reporter, RuleContext, Rules } from '@tsslint/types';
import type * as ts from 'typescript';

import ErrorStackParser = require('error-stack-parser');
import path = require('path');
import minimatch = require('minimatch');

export type FileLintCache = [
	mtime: number,
	ruleFixes: Record<string, number>,
	result: ts.DiagnosticWithLocation[],
	resolvedResult: ts.DiagnosticWithLocation[],
	minimatchResult: Record<string, boolean>,
];

export type Linter = ReturnType<typeof createLinter>;

export function createLinter(ctx: ProjectContext, config: Config | Config[], mode: 'cli' | 'typescript-plugin') {
	if (mode === 'typescript-plugin') {
		require('source-map-support').install({
			retrieveFile(path: string) {
				if (!path.endsWith('.js.map')) {
					return;
				}
				path = path.replace(/\\/g, '/');
				// monkey-fix, refs: https://github.com/typescript-eslint/typescript-eslint/issues/9352
				if (
					path.includes('/@typescript-eslint/eslint-plugin/dist/rules/')
					|| path.includes('/eslint-plugin-expect-type/lib/rules/')
				) {
					return JSON.stringify({
						version: 3,
						sources: [],
						sourcesContent: [],
						mappings: '',
						names: [],
					});
				}
			},
		});
	}

	let languageServiceUsage = mode === 'typescript-plugin' ? 1 : 0;

	const ts = ctx.typescript;
	const languageService = new Proxy(ctx.languageService, {
		get(target, key, receiver) {
			if (!languageServiceUsage && debug) {
				console.log('Type-aware mode enabled');
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
	const sourceFiles = new Map<string, [boolean, ts.SourceFile]>();
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
	const debug = (Array.isArray(config) ? config : [config]).some(config => config.debug);

	return {
		lint(fileName: string, cache?: FileLintCache): ts.DiagnosticWithLocation[] {
			let cacheableDiagnostics: ts.DiagnosticWithLocation[] = [];
			let uncacheableDiagnostics: ts.DiagnosticWithLocation[] = [];
			let debugInfo: ts.DiagnosticWithLocation | undefined;
			let currentRuleId: string;
			let currentIssues = 0;
			let currentFixes = 0;
			let currentRefactors = 0;
			let currentRuleLanguageServiceUsage = 0;
			let sourceFile: ts.SourceFile | undefined;
			let hasUncacheResult = false;

			if (debug) {
				debugInfo = {
					category: ts.DiagnosticCategory.Message,
					code: 'debug' as any,
					messageText: '- Config: ' + ctx.configFile + '\n',
					file: getSourceFile(fileName),
					start: 0,
					length: 0,
					source: 'tsslint',
					relatedInformation: [],
				};
				uncacheableDiagnostics.push(debugInfo);
			}

			const rules = getFileRules(fileName, cache);
			if (!rules || !Object.keys(rules).length) {
				if (debugInfo) {
					debugInfo.messageText += '- Rules: ❌ (no rules)\n';
				}
			}

			const prevLanguageServiceUsage = languageServiceUsage;
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
			const cachedRules = new Map<string, number>();

			if (cache) {
				for (const ruleId in cache[1]) {
					cachedRules.set(ruleId, cache[1][ruleId]);
				}
			}

			fixes.clear();
			refactors.length = 0;

			if (debugInfo) {
				debugInfo.messageText += '- Rules:\n';
			}

			runRules(rules);

			if (!!prevLanguageServiceUsage !== !!languageServiceUsage) {
				return this.lint(fileName, cache);
			}

			const configs = getFileConfigs(fileName, cache);

			if (cache) {
				for (const [ruleId, fixes] of cachedRules) {
					cache[1][ruleId] = fixes;
				}
			}

			let diagnostics: ts.DiagnosticWithLocation[];

			if (hasUncacheResult) {
				diagnostics = [
					...(cacheableDiagnostics.length
						? cacheableDiagnostics
						: (cache?.[2] ?? []).map(data => ({
							...data,
							file: rulesContext.sourceFile,
							relatedInformation: data.relatedInformation?.map(info => ({
								...info,
								file: info.file ? getSourceFile(info.file.fileName) : undefined,
							})),
						}))
					),
					...uncacheableDiagnostics,
				];
				for (const { plugins } of configs) {
					for (const { resolveDiagnostics } of plugins) {
						if (resolveDiagnostics) {
							diagnostics = resolveDiagnostics(rulesContext.sourceFile, diagnostics);
						}
					}
				}
				if (cache) {
					cache[3] = diagnostics.map(data => ({
						...data,
						file: undefined as any,
						relatedInformation: data.relatedInformation?.map(info => ({
							...info,
							file: info.file ? { fileName: info.file.fileName } as any : undefined,
						})),
					}));
				}
			}
			else {
				diagnostics = (cache?.[3] ?? []).map(data => ({
					...data,
					file: rulesContext.sourceFile,
					relatedInformation: data.relatedInformation?.map(info => ({
						...info,
						file: info.file ? getSourceFile(info.file.fileName) : undefined,
					})),
				}));
			}

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
						runRules(rule, [...paths, path]);
						continue;
					}

					currentRuleLanguageServiceUsage = languageServiceUsage;
					currentRuleId = [...paths, path].join('/');
					currentIssues = 0;
					currentFixes = 0;
					currentRefactors = 0;

					if (cachedRules.has(currentRuleId)) {
						continue;
					}

					hasUncacheResult = true;

					const start = Date.now();
					try {
						rule(rulesContext);
						if (debugInfo) {
							const time = Date.now() - start;
							debugInfo.messageText += `  - ${currentRuleId}`;
							const details: string[] = [];
							if (currentIssues) {
								details.push(`${currentIssues} issues`);
							}
							if (currentFixes) {
								details.push(`${currentFixes} fixes`);
							}
							if (currentRefactors) {
								details.push(`${currentRefactors} refactors`);
							}
							if (time) {
								details.push(`${time}ms`);
							}
							if (details.length) {
								debugInfo.messageText += ` (${details.join(', ')})`;
							}
							debugInfo.messageText += '\n';
						}
					} catch (err) {
						console.error(err);
						if (debugInfo) {
							debugInfo.messageText += `  - ${currentRuleId} (❌ ${err && typeof err === 'object' && 'stack' in err ? err.stack : String(err)}})\n`;
						}
					}

					if (cache && currentRuleLanguageServiceUsage === languageServiceUsage) {
						cachedRules.set(currentRuleId, currentFixes);
					}
				}
			};

			function reportError(message: string, start: number, end: number, traceOffset: false | number = 0) {
				return report(ts.DiagnosticCategory.Error, message, start, end, traceOffset);
			}

			function reportWarning(message: string, start: number, end: number, traceOffset: false | number = 0) {
				return report(ts.DiagnosticCategory.Warning, message, start, end, traceOffset);
			}

			function reportSuggestion(message: string, start: number, end: number, traceOffset: false | number = 0) {
				return report(ts.DiagnosticCategory.Suggestion, message, start, end, traceOffset);
			}

			function report(category: ts.DiagnosticCategory, message: string, start: number, end: number, traceOffset: false | number): Reporter {
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
					cache[2].push({
						...error,
						file: undefined as any,
						relatedInformation: error.relatedInformation?.map(info => ({
							...info,
							file: info.file ? { fileName: info.file.fileName } as any : undefined,
						})),
					});
				}

				if (mode === 'typescript-plugin') {
					const stacks = traceOffset === false
						? []
						: ErrorStackParser.parse(new Error());
					if (typeof traceOffset === 'number') {
						const baseOffset = 2 + traceOffset;
						if (stacks.length > baseOffset) {
							pushRelatedInformation(error, stacks[baseOffset]);
						}
					}
				}

				fixes.set(error, []);
				(cacheable ? cacheableDiagnostics : uncacheableDiagnostics).push(error);
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

			function pushRelatedInformation(error: ts.DiagnosticWithLocation, stack: ErrorStackParser.StackFrame) {
				if (stack.fileName && stack.lineNumber !== undefined && stack.columnNumber !== undefined) {
					let fileName = stack.fileName
						.replace(/\\/g, '/')
						.split('?time=')[0];
					if (fileName.startsWith('file://')) {
						fileName = fileName.substring('file://'.length);
					}
					if (fileName.includes('http-url:')) {
						fileName = fileName.split('http-url:')[1];
					}
					if (!sourceFiles.has(fileName)) {
						const text = ctx.languageServiceHost.readFile(fileName);
						sourceFiles.set(
							fileName,
							[
								text !== undefined,
								ts.createSourceFile(fileName, text ?? '', ts.ScriptTarget.Latest, true)
							]
						);
					}
					const [exist, stackFile] = sourceFiles.get(fileName)!;
					let pos = 0;
					if (exist) {
						try {
							pos = stackFile.getPositionOfLineAndCharacter(stack.lineNumber - 1, stack.columnNumber - 1) ?? 0;
						} catch { }
					}
					error.relatedInformation ??= [];
					error.relatedInformation.push({
						category: ts.DiagnosticCategory.Message,
						code: 0,
						file: stackFile,
						start: pos,
						length: 0,
						messageText: 'at ' + (stack.functionName ?? '<anonymous>'),
					});
				}
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
			cache?: FileLintCache
		) {

			const configs = getFileConfigs(fileName, cache);
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
	};

	function getSourceFile(fileName: string): ts.SourceFile {
		if (languageServiceUsage) {
			return ctx.languageService.getProgram()!.getSourceFile(fileName)!;
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

	function getFileRules(fileName: string, cache: undefined | FileLintCache) {
		let result = fileRules.get(fileName);
		if (!result) {
			result = {};
			const configs = getFileConfigs(fileName, cache);
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

	function getFileConfigs(fileName: string, cache: undefined | FileLintCache) {
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
				if (cache) {
					if (pattern in cache[4]) {
						return cache[4][pattern];
					}
				}
				let normalized = normalizedPath.get(pattern);
				if (!normalized) {
					normalized = ts.server.toNormalizedPath(path.resolve(basePath, pattern));
					normalizedPath.set(pattern, normalized);
				}
				const res = minimatch.minimatch(fileName, normalized);
				if (cache) {
					cache[4][pattern] = res;
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
