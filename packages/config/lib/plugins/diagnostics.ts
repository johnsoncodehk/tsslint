import type { Plugin } from '@tsslint/types';

type CheckMode = 'syntactic' | 'semantic' | 'declaration';

export function create(mode: CheckMode | CheckMode[] = 'semantic'): Plugin {
	const modes = Array.isArray(mode) ? mode : [mode];
	return ({ languageService }) => ({
		resolveDiagnostics(sourceFile, diagnostics) {
			const program = languageService.getProgram()!;
			for (const mode of modes) {
				const diags = mode === 'syntactic'
					? program.getSyntacticDiagnostics(sourceFile)
					: mode === 'semantic'
						? program.getSemanticDiagnostics(sourceFile)
						: mode === 'declaration'
							? program.getDeclarationDiagnostics(sourceFile)
							: [];
				for (const diag of diags) {
					diag.start ??= 0;
					diag.length ??= 0;
					diagnostics.push(diag as any);
				}
			}
			return diagnostics;
		},
	});
}
