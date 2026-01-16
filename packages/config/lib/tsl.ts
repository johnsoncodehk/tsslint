import type { Rule } from '@tsslint/config';
import * as fs from 'fs';
import * as path from 'path';
import type * as TSL from 'tsl' with { 'resolution-mode': 'import' };

export function fromTSLRules(tslRules: TSL.Rule<unknown>[]) {
	let dir = __dirname;
	let tslDir: string | undefined;
	while (true) {
		const potential = path.join(dir, 'node_modules', 'tsl');
		if (fs.existsSync(potential)) {
			tslDir = potential;
			break;
		}
		const parentDir = path.dirname(dir);
		if (parentDir === dir) {
			break;
		}
		dir = parentDir;
	}
	if (!tslDir) {
		throw new Error('Failed to find tsl package in node_modules.');
	}
	const visitorEntriesFile = fs.readdirSync(tslDir).find(f => /^visitorEntries-.*\.js$/.test(f));
	if (!visitorEntriesFile) {
		throw new Error('Failed to find visitorEntries file in tsl package.');
	}
	const { getContextUtils, visitorEntries } = require(path.join(tslDir, visitorEntriesFile));
	const rules: Record<string, Rule> = {};
	for (const tslRule of tslRules) {
		rules[tslRule.name] = convertTSLRule(tslRule, visitorEntries);
	}
	return rules;

	function convertTSLRule(rule: TSL.Rule<unknown>, visitorEntries: any[]): Rule {
		return ({ typescript: ts, file, program, report }) => {
			const context1: Omit<TSL.Context, 'data'> = {
				checker: program.getTypeChecker() as unknown as TSL.Checker,
				rawChecker: program.getTypeChecker(),
				sourceFile: file as any,
				report: descriptor => {
					if ('node' in descriptor) {
						report(descriptor.message, descriptor.node.getStart(file), descriptor.node.getEnd())
							.at(new Error(), 1);
					}
					else {
						report(descriptor.message, descriptor.start, descriptor.end)
							.at(new Error(), 1);
					}
				},
				compilerOptions: program.getCompilerOptions(),
				program,
				utils: getContextUtils(() => program),
			};
			const context2 = { ...context1, data: rule.createData?.(context1) };
			ts.forEachChild(file, function cb(node) {
				const nodeType = visitorEntries.find(e => e[0] === node.kind)?.[1];
				if (nodeType) {
					// @ts-expect-error
					rule.visitor[nodeType]?.(context2, node as any);
				}
				ts.forEachChild(node, cb);
				if (nodeType) {
					// @ts-expect-error
					rule.visitor[`${nodeType}_exit` as keyof Visitor]?.(
						context2,
						node as any,
					);
				}
			});
		};
	}
}
