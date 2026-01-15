'use strict';
Object.defineProperty(exports, '__esModule', { value: true });
exports.convertRule = convertRule;
function convertRule(
	ruleOrFactory, // TSL.Rule | TSL.RuleFactory
	category = 3,
) {
	return ctx => {
		const { typescript: ts, file, report, program } = ctx;
		const rule = typeof ruleOrFactory === 'function' ? ruleOrFactory() : ruleOrFactory;
		if (rule.metadata?.typescriptOnly) {
			const scriptKind = file.scriptKind;
			if (scriptKind === ts.ScriptKind.JS || scriptKind === ts.ScriptKind.JSX) {
				return;
			}
		}
		const checker = program.getTypeChecker();
		const tslContext = {
			sourceFile: file,
			program,
			checker: createTSLChecker(ts, checker),
			utils: createTSLUtils(ts, checker),
			compilerOptions: program.getCompilerOptions(),
			report: descriptor => {
				const start = 'node' in descriptor ? descriptor.node.getStart() : descriptor.start;
				const end = 'node' in descriptor ? descriptor.node.getEnd() : descriptor.end;
				const reporter = report(descriptor.message, start, end).at(new Error(), Number.MAX_VALUE);
				if (category === 0) {
					reporter.asWarning();
				}
				else if (category === 1) {
					reporter.asError();
				}
				else if (category === 2) {
					reporter.asSuggestion();
				}
				if (descriptor.suggestions) {
					const suggestions = typeof descriptor.suggestions === 'function'
						? descriptor.suggestions()
						: descriptor.suggestions;
					for (const suggestion of suggestions) {
						reporter.withFix(suggestion.message, () => [{
							fileName: file.fileName,
							textChanges: suggestion.changes.map(change => {
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
						}]);
					}
				}
			},
		};
		if (rule.createData) {
			tslContext.data = rule.createData(tslContext);
		}
		const visitor = rule.visitor;
		const walk = node => {
			const nodeKindName = ts.SyntaxKind[node.kind];
			if (visitor[nodeKindName]) {
				visitor[nodeKindName](tslContext, node);
			}
			ts.forEachChild(node, walk);
		};
		walk(file);
	};
}
function createTSLChecker(_ts, checker) {
	return checker;
}
function createTSLUtils(_ts, _checker) {
	return {
		typeHasFlag: (type, flag) => (type.flags & flag) !== 0,
		typeOrUnionHasFlag: (type, flag) => {
			if (type.isUnion()) {
				return type.types.some(t => (t.flags & flag) !== 0);
			}
			return (type.flags & flag) !== 0;
		},
		typeHasSymbolFlag: (type, flag) => (type.getSymbol()?.flags ?? 0 & flag) !== 0,
	};
}
// # sourceMappingURL=index.js.map
