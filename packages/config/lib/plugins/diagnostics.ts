import type { Plugin } from '@tsslint/types';

type CheckMode = 'syntactic' | 'semantic' | 'declaration';

export function create(mode: CheckMode | CheckMode[] = 'semantic'): Plugin {
	const modes = Array.isArray(mode) ? mode : [mode];
	return () => ({
		resolveDiagnostics({ program, file }, diagnostics) {
			for (const mode of modes) {
				const diags = mode === 'syntactic'
					? program.getSyntacticDiagnostics(file.fileName)
					: mode === 'semantic'
					? program.getSemanticDiagnostics(file.fileName)
					: mode === 'declaration'
					? program.getDeclarationDiagnostics(file.fileName)
					: [];
				for (const diag of diags) {
					diagnostics.push({
						category: diag.category,
						code: diag.code,
						text: diag.text,
						messageChain: diag.messageChain,
						fileName: diag.fileName,
						pos: diag.pos,
						end: diag.end,
						startPosition: diag.startPosition,
						endPosition: diag.endPosition,
						sourceLines: diag.sourceLines,
						source: diag.source || 'ts',
						reportsUnnecessary: diag.reportsUnnecessary,
						reportsDeprecated: diag.reportsDeprecated,
					});
				}
			}
			return diagnostics;
		},
	});
}
