import type { Rule } from '@tsslint/config';

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
			);
		}
		ts.forEachChild(node, walk);
	});
};
