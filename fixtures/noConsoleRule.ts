import type { Rule } from '@tsslint/config';

export function create(): Rule {
	return ({ typescript: ts, sourceFile, reportWarning }) => {
		ts.forEachChild(sourceFile, function cb(node) {
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
								length: node.parent.getWidth(sourceFile),
							},
						}],
					}]
				);
			}
			ts.forEachChild(node, cb);
		});
	};
}
