import type { Diagnostic, Plugin } from '@tsslint/types';

type CheckMode = 'syntactic' | 'semantic' | 'declaration';

export function create(mode: CheckMode | CheckMode[] = 'semantic'): Plugin {
	const modes = Array.isArray(mode) ? mode : [mode];
	return ({ getProgram }) => ({
		resolveDiagnostics(file, diagnostics) {
			const program = getProgram();
			for (const mode of modes) {
				const diags = mode === 'syntactic'
					? program.getSyntacticDiagnostics(file.fileName)
					: mode === 'semantic'
					? program.getSemanticDiagnostics(file.fileName)
					: mode === 'declaration'
					? program.getDeclarationDiagnostics(file.fileName)
					: [];
				for (const diag of diags) {
					diagnostics.push(
						{
							category: diag.category,
							code: diag.code,
							messageText: flattenMessage(diag),
							file,
							start: diag.pos,
							length: diag.end - diag.pos,
							source: diag.source || 'ts',
							reportsUnnecessary: diag.reportsUnnecessary,
							reportsDeprecated: diag.reportsDeprecated,
						} satisfies Diagnostic,
					);
				}
			}
			return diagnostics;
		},
	});
}

function flattenMessage(
	diag: { text: string; messageChain?: readonly { text: string; messageChain?: any }[] },
	indent = 0,
): string {
	let text = (indent ? '\n' + '  '.repeat(indent) : '') + diag.text;
	for (const child of diag.messageChain ?? []) {
		text += flattenMessage(child, indent + 1);
	}
	return text;
}
