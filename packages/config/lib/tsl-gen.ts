import * as fs from 'fs';
import * as path from 'path';

export async function generateTSLTypes(
	nodeModulesDirs: string[],
	loader = async (mod: string) => {
		try {
			return require(mod);
		}
		catch {
			return await import(mod);
		}
	},
) {
	let indentLevel = 0;
	let dts = '';

	line(`export interface TSLRulesConfig {`);
	indentLevel++;

	const stats: Record<string, number> = {};

	for (const nodeModulesDir of nodeModulesDirs) {
		const tslDir = path.join(nodeModulesDir, 'tsl');
		if (fs.existsSync(tslDir)) {
			try {
				const tsl = await loader(tslDir);
				if (tsl.core) {
					const coreRules = tsl.core.all();
					stats['tsl'] = coreRules.length;
					for (const rule of coreRules) {
						if (rule.metadata) {
							line(`/**`);
							if (rule.metadata.description) {
								for (const lineText of rule.metadata.description.trim().split('\n')) {
									line(` * ${lineText.replace(/\*\//g, '* /')}`);
								}
							}
							line(` */`);
						}
						line(`'${rule.name}'?: boolean | 'error' | 'warn',`);
					}
				}
			}
			catch {
				// Ignore
			}
		}
	}

	indentLevel--;
	line(`}`);

	return { dts, stats };

	function line(line: string) {
		dts += indent(indentLevel) + line + '\n';
	}

	function indent(indentLevel: number) {
		return '\t'.repeat(indentLevel);
	}
}
