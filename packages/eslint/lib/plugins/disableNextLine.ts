import type { Plugin } from '@tsslint/types';

interface CommentState {
	used?: boolean;
	start: number;
	end: number;
}

const reg = new RegExp(/\/\/\s*eslint-disable-next-line\b[ \t]*(\S*)\b/g);

export function create(reportsUnusedComments = true): Plugin {
	return ({ languageService }) => ({
		resolveDiagnostics(fileName, results) {
			if (
				!reportsUnusedComments &&
				!results.some(error => error.source === 'tsslint')
			) {
				return results;
			}
			const sourceFile = languageService.getProgram()!.getSourceFile(fileName)!;
			const disabledLines = new Map<number, CommentState>();
			const disabledLinesByRules = new Map<string, Map<number, CommentState>>();
			for (const comment of sourceFile.text.matchAll(reg)) {
				const line =
					sourceFile.getLineAndCharacterOfPosition(comment.index).line + 1;
				const rule = comment[1];
				if (rule) {
					if (!disabledLinesByRules.has(rule)) {
						disabledLinesByRules.set(rule, new Map());
					}
					disabledLinesByRules.get(rule)!.set(line, {
						start: comment.index,
						end: comment.index + comment[0].length,
					});
				} else {
					disabledLines.set(line, {
						start: comment.index,
						end: comment.index + comment[0].length,
					});
				}
			}
			results = results.filter(error => {
				if (error.source !== 'tsslint') {
					return true;
				}
				const line = sourceFile.getLineAndCharacterOfPosition(error.start).line;
				if (disabledLines.has(line)) {
					disabledLines.get(line)!.used = true;
					return false;
				}
				const disabledLinesByRule = disabledLinesByRules.get(error.code as any);
				if (disabledLinesByRule?.has(line)) {
					disabledLinesByRule.get(line)!.used = true;
					return false;
				}
				return true;
			});
			if (reportsUnusedComments) {
				for (const state of disabledLines.values()) {
					if (!state.used) {
						results.push({
							file: sourceFile,
							start: state.start,
							length: state.end - state.start,
							code: 'eslint:unused-disable-next-line' as any,
							messageText: 'Unused eslint-disable-next-line comment.',
							source: 'tsslint',
							category: 1,
						});
					}
				}
				for (const disabledLinesByRule of disabledLinesByRules.values()) {
					for (const state of disabledLinesByRule.values()) {
						if (!state.used) {
							results.push({
								file: sourceFile,
								start: state.start,
								length: state.end - state.start,
								code: 'eslint:unused-disable-next-line' as any,
								messageText: 'Unused eslint-disable-next-line comment.',
								source: 'tsslint',
								category: 1,
							});
						}
					}
				}
			}
			return results;
		},
	});
}
