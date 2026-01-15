import type { Config, LinterContext } from '@tsslint/config';
import type * as ts from 'typescript';

import core = require('@tsslint/core');
import path = require('path');
import ErrorStackParser = require('error-stack-parser');

const languageServiceDecorators = new WeakMap<ts.server.Project, ReturnType<typeof decorateLanguageService>>();
const plugin: ts.server.PluginModuleFactory = modules => {
	const { typescript: ts } = modules;
	const pluginModule: ts.server.PluginModule = {
		create(info) {
			let decorator = languageServiceDecorators.get(info.project);
			if (!decorator) {
				if (info.project.projectKind === ts.server.ProjectKind.Configured) {
					const tsconfig = info.project.getProjectName();
					decorator = decorateLanguageService(ts, path.dirname(tsconfig), info);
				} else {
					decorator = decorateLanguageService(ts, info.project.getCurrentDirectory(), info);
				}
				languageServiceDecorators.set(info.project, decorator);
			}
			decorator.update();
			return info.languageService;
		},
	};
	return pluginModule;
};
const fsFiles = new Map<string, [exist: boolean, mtime: number, ts.SourceFile]>();

export = plugin;

function decorateLanguageService(
	ts: typeof import('typescript'),
	projectRoot: string,
	info: ts.server.PluginCreateInfo
) {
	const {
		getSemanticDiagnostics,
		getCodeFixesAtPosition,
		getCombinedCodeFix,
		getApplicableRefactors,
		getEditsForRefactor,
	} = info.languageService;
	const projectFileNameKeys = new Set<string>();

	let configFile: string | undefined;
	let configFileDiagnostics: Omit<ts.Diagnostic, 'file' | 'start' | 'length' | 'source'>[] = [];
	let config: Config | Config[] | undefined;
	let linter: core.Linter | undefined;

	info.languageService.getSemanticDiagnostics = fileName => {
		let result = getSemanticDiagnostics(fileName);
		if (!isProjectFileName(fileName)) {
			return result;
		}
		if (configFileDiagnostics.length) {
			const file = info.languageService.getProgram()?.getSourceFile(fileName);
			if (file) {
				result = result.concat(configFileDiagnostics.map<ts.DiagnosticWithLocation>(diagnostic => ({
					...diagnostic,
					source: 'tsslint',
					file,
					start: 0,
					length: 0,
				})));
			}
		}
		if (linter) {
			result = result.concat(linter.lint(fileName));
		}
		return result;
	};
	info.languageService.getCodeFixesAtPosition = (fileName, start, end, errorCodes, formatOptions, preferences) => {
		return [
			...getCodeFixesAtPosition(fileName, start, end, errorCodes, formatOptions, preferences),
			...linter?.getCodeFixes(fileName, start, end) ?? [],
		];
	};
	info.languageService.getCombinedCodeFix = (scope, fixId, formatOptions, preferences) => {
		if (fixId === 'tsslint' && linter) {
			const fixes = linter.getCodeFixes(scope.fileName, 0, Number.MAX_VALUE).filter(fix => fix.fixId === 'tsslint');
			const changes = core.combineCodeFixes(scope.fileName, fixes);
			return {
				changes: [{
					fileName: scope.fileName,
					textChanges: changes,
				}],
			};
		}
		return getCombinedCodeFix(scope, fixId, formatOptions, preferences);
	};
	info.languageService.getApplicableRefactors = (fileName, positionOrRange, preferences, triggerReason, kind, includeInteractiveActions) => {
		const start = typeof positionOrRange === 'number' ? positionOrRange : positionOrRange.pos;
		const end = typeof positionOrRange === 'number' ? positionOrRange : positionOrRange.end;
		const refactors = linter?.getRefactors(fileName, start, end) ?? [];
		return [
			...getApplicableRefactors(fileName, positionOrRange, preferences, triggerReason, kind, includeInteractiveActions),
			{
				actions: refactors,
				name: 'TSSLint',
				description: 'TSSLint refactor actions',
			},
		];
	};
		info.languageService.getEditsForRefactor = (fileName, formatOptions, positionOrRange, refactorName, actionName, preferences, interactiveRefactorArguments) => {
			const tsslintEdits = linter?.getRefactorEdits(fileName, actionName);
			if (tsslintEdits) {
				return tsslintEdits;
			}
			return getEditsForRefactor(fileName, formatOptions, positionOrRange, refactorName, actionName, preferences, interactiveRefactorArguments);
		};

	return { update };

	function isProjectFileName(fileName: string) {
		fileName = fileName.replace(/\\/g, '/');
		const projectFileNames = info.languageServiceHost.getScriptFileNames();
		if (projectFileNames.length !== projectFileNameKeys.size) {
			projectFileNameKeys.clear();
			for (const fileName of projectFileNames) {
				projectFileNameKeys.add(getFileKey(fileName));
			}
		}
		return projectFileNameKeys.has(getFileKey(fileName));
	}

	function getFileKey(fileName: string) {
		return info.languageServiceHost.useCaseSensitiveFileNames?.() ? fileName : fileName.toLowerCase();
	}

	async function update() {

		const newConfigFile = ts.findConfigFile(projectRoot, ts.sys.fileExists, 'tsslint.config.ts');

		if (newConfigFile !== configFile) {
			configFile = newConfigFile;
			config = undefined;
			linter = undefined;
			configFileDiagnostics = [];

			if (!configFile) {
				return;
			}

			const projectContext: LinterContext = {
				languageServiceHost: info.languageServiceHost,
				languageService: info.languageService,
				typescript: ts,
			};


			try {
				config = (await import(configFile)).default;
				linter = core.createLinter(projectContext, path.dirname(configFile), config!, (err, stackIndex) => {
					const stacks = ErrorStackParser.parse(err);
					if (stacks.length <= stackIndex) {
						return [];
					}
					const relatedInfo = createRelatedInformation(ts, stacks[stackIndex]);
					if (relatedInfo) {
						return [relatedInfo];
					}
					return [];
				});
			} catch (err) {
				config = undefined;
				linter = undefined;
				const prevLength = configFileDiagnostics.length;
				if (err instanceof Error) {
					const relatedInfo = createRelatedInformation(ts, ErrorStackParser.parse(err)[0]);
					if (relatedInfo) {
						configFileDiagnostics.push({
							category: ts.DiagnosticCategory.Message,
							code: 0,
							messageText: err.message,
							relatedInformation: [relatedInfo],
						});
					}
				}
				if (prevLength === configFileDiagnostics.length) {
					configFileDiagnostics.push({
						category: ts.DiagnosticCategory.Message,
						code: 0,
						messageText: String(err),
					});
				}
			}
		}
	}
}

function createRelatedInformation(ts: typeof import('typescript'), stack: ErrorStackParser.StackFrame): ts.DiagnosticRelatedInformation | undefined {
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
