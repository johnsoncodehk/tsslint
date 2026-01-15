import type { Plugin } from '@tsslint/types';

type CheckMode = 'syntactic' | 'semantic' | 'declaration';

export function create(mode: CheckMode | CheckMode[] = 'semantic'): Plugin {
	const modes = Array.isArray(mode) ? mode : [mode];
	return ({ languageService }) => ({
		resolveDiagnostics(file, diagnostics) {
			const program = languageService.getProgram()!;
			for (const mode of modes) {
				const diags = mode === 'syntactic'
					? program.getSyntacticDiagnostics(file)
					: mode === 'semantic'
					? program.getSemanticDiagnostics(file)
					: mode === 'declaration'
					? program.getDeclarationDiagnostics(file)
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
