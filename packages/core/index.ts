export * from './lib/build';
export * from './lib/watch';

import type { Config, ProjectContext, Reporter, RuleContext, Rules } from '@tsslint/types';
import type * as ts from 'typescript';

import ErrorStackParser = require('error-stack-parser');
import path = require('path');
import minimatch = require('minimatch');

export type Linter = ReturnType<typeof createLinter>;

export function createLinter(ctx: ProjectContext, config: Config | Config[], withStack: boolean) {
	if (withStack) {
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
	const ts = ctx.typescript;
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
	const basePath = path.dirname(ctx.configFile);
	const configs = (Array.isArray(config) ? config : [config])
		.map(config => ({
			rules: config.rules ?? {},
			includes: (config.include ?? []).map(include => {
				return ts.server.toNormalizedPath(path.resolve(basePath, include));
			}),
			excludes: (config.exclude ?? []).map(exclude => {
				return ts.server.toNormalizedPath(path.resolve(basePath, exclude));
			}),
			plugins: (config.plugins ?? []).map(plugin => plugin(ctx)),
		}));
	const debug = (Array.isArray(config) ? config : [config]).some(config => config.debug);

	return {
		lint(fileName: string) {
			let diagnostics: ts.DiagnosticWithLocation[] = [];
			let debugInfo: ts.DiagnosticWithLocation | undefined;
			if (debug) {
				debugInfo = {
					category: ts.DiagnosticCategory.Message,
					code: 'debug' as any,
					messageText: '- Config: ' + ctx.configFile + '\n',
					file: ctx.languageService.getProgram()!.getSourceFile(fileName)!,
					start: 0,
					length: 0,
					source: 'tsslint',
					relatedInformation: [],
				};
				diagnostics.push(debugInfo);
			}

			const rules = getFileRules(fileName);
			if (!rules || !Object.keys(rules).length) {
				if (debugInfo) {
					debugInfo.messageText += '- Rules: ❌ (no rules)\n';
				}
				return diagnostics;
			}

			const sourceFile = ctx.languageService.getProgram()?.getSourceFile(fileName);
			if (!sourceFile) {
				throw new Error(`No source file found for ${fileName}`);
			}

			const rulesContext: RuleContext = {
				...ctx,
				sourceFile,
				reportError,
				reportWarning,
				reportSuggestion,
			};
			const token = ctx.languageServiceHost.getCancellationToken?.();
			const fixes = getFileFixes(sourceFile.fileName);
			const refactors = getFileRefactors(sourceFile.fileName);

			let currentRuleId: string;
			let currentIssues = 0;
			let currentFixes = 0;
			let currentRefactors = 0;

			fixes.clear();
			refactors.length = 0;

			if (debugInfo) {
				debugInfo.messageText += '- Rules:\n';
			}

			const processRules = (rules: Rules, paths: string[] = []) => {
				for (const [path, rule] of Object.entries(rules)) {
					if (token?.isCancellationRequested()) {
						break;
					}
					if (typeof rule === 'object') {
						processRules(rule, [...paths, path]);
						continue;
					}
					currentRuleId = [...paths, path].join('/');
					currentIssues = 0;
					currentFixes = 0;
					currentRefactors = 0;
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
				}
			};
			processRules(rules);

			const configs = getFileConfigs(fileName);

			for (const { plugins } of configs) {
				for (const { resolveDiagnostics } of plugins) {
					if (resolveDiagnostics) {
						diagnostics = resolveDiagnostics(sourceFile.fileName, diagnostics);
					}
				}
			}

			const diagnosticSet = new Set(diagnostics);

			for (const diagnostic of [...fixes.keys()]) {
				if (!diagnosticSet.has(diagnostic)) {
					fixes.delete(diagnostic);
				}
			}
			fileRefactors.set(fileName, refactors.filter(refactor => diagnosticSet.has(refactor.diagnostic)));

			return diagnostics;

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
					file: sourceFile!,
					start,
					length: end - start,
					source: 'tsslint',
					relatedInformation: [],
				};

				if (withStack) {
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
						if (!fixes.has(error)) {
							fixes.set(error, []);
						}
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
		getCodeFixes(fileName: string, start: number, end: number, diagnostics?: ts.Diagnostic[]) {

			const configs = getFileConfigs(fileName);
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
								codeFixes = resolveCodeFixes(fileName, diagnostic, codeFixes);
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

	function getFileRules(fileName: string) {
		let result = fileRules.get(fileName);
		if (!result) {
			result = {};
			const configs = getFileConfigs(fileName);
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

	function getFileConfigs(fileName: string) {
		let result = fileConfigs.get(fileName);
		if (!result) {
			result = configs.filter(({ includes, excludes }) => {
				if (excludes.some(pattern => minimatch.minimatch(fileName, pattern))) {
					return false;
				}
				if (includes.length && !includes.some(pattern => minimatch.minimatch(fileName, pattern))) {
					return false;
				}
				return true;
			});
			fileConfigs.set(fileName, result);
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
