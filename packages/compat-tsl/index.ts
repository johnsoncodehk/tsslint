import type * as TSSLint from '@tsslint/types';
import type * as ts from 'typescript';

export function convertRule(
	ruleOrFactory: any, // TSL.Rule | TSL.RuleFactory
	category: ts.DiagnosticCategory = 3 satisfies ts.DiagnosticCategory.Message,
): TSSLint.Rule {
	return ctx => {
		const { typescript: ts, file, report, program } = ctx;

		const rule = typeof ruleOrFactory === 'function' ? ruleOrFactory() : ruleOrFactory;

		if (rule.metadata?.typescriptOnly) {
			const scriptKind = (file as any).scriptKind;
			if (scriptKind === ts.ScriptKind.JS || scriptKind === ts.ScriptKind.JSX) {
				return;
			}
		}

		const checker = program.getTypeChecker();
		const tslContext: any = {
			sourceFile: file,
			program,
			checker: createTSLChecker(ts, checker),
			utils: createTSLUtils(ts, checker),
			compilerOptions: program.getCompilerOptions(),
			report: (descriptor: any) => {
				const start = 'node' in descriptor ? descriptor.node.getStart() : descriptor.start;
				const end = 'node' in descriptor ? descriptor.node.getEnd() : descriptor.end;
				const reporter = report(
					descriptor.message,
					start,
					end,
				).at(new Error(), Number.MAX_VALUE);

				if (category === 0 satisfies ts.DiagnosticCategory.Warning) {
					reporter.asWarning();
				}
				else if (category === 1 satisfies ts.DiagnosticCategory.Error) {
					reporter.asError();
				}
				else if (category === 2 satisfies ts.DiagnosticCategory.Suggestion) {
					reporter.asSuggestion();
				}

				if (descriptor.suggestions) {
					const suggestions = typeof descriptor.suggestions === 'function'
						? descriptor.suggestions()
						: descriptor.suggestions;
					for (const suggestion of suggestions) {
						reporter.withFix(
							suggestion.message,
							() => [{
								fileName: file.fileName,
								textChanges: suggestion.changes.map((change: any) => {
									if ('node' in change) {
										return {
											newText: change.newText,
											span: {
												start: change.node.getStart(),
												length: change.node.getWidth(),
											},
										};
									}
									return {
										newText: change.newText,
										span: {
											start: change.start,
											length: 'end' in change ? change.end - change.start : change.length,
										},
									};
								}),
							}],
						);
					}
				}
			},
		};

		if (rule.createData) {
			tslContext.data = rule.createData(tslContext);
		}

		const visitor = rule.visitor;
		const walk = (node: ts.Node) => {
			const nodeKindName = (ts.SyntaxKind as any)[node.kind];
			if (visitor[nodeKindName]) {
				visitor[nodeKindName](tslContext, node);
			}
			ts.forEachChild(node, walk);
		};
		walk(file);
	};
}

function createTSLChecker(_ts: any, checker: ts.TypeChecker) {
	return checker;
}

function createTSLUtils(_ts: any, _checker: ts.TypeChecker) {
	return {
		typeHasFlag: (type: ts.Type, flag: ts.TypeFlags) => (type.flags & flag) !== 0,
		typeOrUnionHasFlag: (type: ts.Type, flag: ts.TypeFlags) => {
			if (type.isUnion()) {
				return type.types.some(t => (t.flags & flag) !== 0);
			}
			return (type.flags & flag) !== 0;
		},
		typeHasSymbolFlag: (type: ts.Type, flag: ts.SymbolFlags) => (type.getSymbol()?.flags ?? 0 & flag) !== 0,
	};
}
