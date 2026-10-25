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
					newText: '/* deleted */',
					pos: node.parent.getStart(file),
					end: node.parent.getEnd(),
				}],
			);
		}
		node.forEachChild(cb);
	});
});
