import { defineRule } from '@tsslint/config';

export function create() {
	return defineRule(({ typescript: ts, file, report }) => {
		ts.forEachChild(file, function cb(node) {
			if (
				ts.isPropertyAccessExpression(node) &&
				ts.isIdentifier(node.expression) &&
				node.expression.text === 'console'
			) {
				report(
					`Calls to 'console.x' are not allowed.`,
					node.parent.getStart(file),
					node.parent.getEnd()
				).withFix(
					`Remove 'console.${node.name.text}'`,
					() => [{
						fileName: file.fileName,
						textChanges: [{
							newText: '/* deleted */',
							span: {
								start: node.parent.getStart(file),
								length: node.parent.getWidth(file),
							},
						}],
					}]
				);
			}
			ts.forEachChild(node, cb);
		});
	});
}
