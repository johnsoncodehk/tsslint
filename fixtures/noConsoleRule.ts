import type { Rule } from 'tsl';

export const noConsoleRule: Rule = ({ typescript: ts, sourceFile, reportWarning }) => {
	ts.forEachChild(sourceFile, function walk(node) {
		if (
			ts.isPropertyAccessExpression(node) &&
			ts.isIdentifier(node.expression) &&
			node.expression.text === 'console'
		) {
			reportWarning(
				`Calls to 'console.x' are not allowed.`,
				node.parent.getStart(sourceFile),
				node.parent.getEnd()
			).withFix(
				`Remove 'console.${node.name.text}'`,
				() => [{
					fileName: sourceFile.fileName,
					textChanges: [{
						newText: '/* deleted */',
						span: {
							start: node.parent.getStart(sourceFile),
							length: node.parent.getEnd() - node.parent.getStart(sourceFile),
						},
					}],
				}]
			);
		}
		ts.forEachChild(node, walk);
	});
};
