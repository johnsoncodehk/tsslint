import { defineRule } from '../packages/config/index.js';

export default defineRule(({ typescript: ts, file, report }) => {
	file.forEachChild(function cb(node): void {
		if (
			ts.isPropertyAccessExpression(node)
			&& ts.isIdentifier(node.expression)
			&& node.expression.text === 'console'
		) {
			report(
				`Calls to 'console.x' are not allowed.`,
				node.parent.getStart(file),
				node.parent.getEnd(),
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
				}],
			);
		}
		node.forEachChild(cb);
	});
});
