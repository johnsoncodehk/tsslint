import * as fs from 'fs';
import * as path from 'path';

export async function generate(
	projectRoot: string,
	loader = async (mod: string) => {
		try {
			return require(mod);
		} catch {
			return await import(mod);
		}
	}
) {
	let indentLevel = 0;
	let dts = '';
	const stats: Record<string, number> = {};
	const visited = new Set<string>();

	line(`export interface TSLintRulesConfig {`);
	indentLevel++;

	const tslintJsonPath = path.join(projectRoot, 'tslint.json');
	if (fs.existsSync(tslintJsonPath)) {
		try {
			const tslintJson = JSON.parse(fs.readFileSync(tslintJsonPath, 'utf8'));
			const rulesDirectories: string[] = [];

			if (tslintJson.rulesDirectory) {
				if (Array.isArray(tslintJson.rulesDirectory)) {
					rulesDirectories.push(...tslintJson.rulesDirectory);
				} else {
					rulesDirectories.push(tslintJson.rulesDirectory);
				}
			}

			for (let rulesDir of rulesDirectories) {
				if (!path.isAbsolute(rulesDir)) {
					rulesDir = path.resolve(projectRoot, rulesDir);
				}

				if (fs.existsSync(rulesDir)) {
					const ruleFiles = fs.readdirSync(rulesDir);
					stats[rulesDir] = 0;
					for (const ruleFile of ruleFiles) {
						if (ruleFile.endsWith('Rule.js')) {
							const ruleName = ruleFile
								.slice(0, -'Rule.js'.length)
								.replace(/([a-z0-9])([A-Z])/g, '$1-$2')
								.toLowerCase();
							
							if (!visited.has(ruleName)) {
								visited.add(ruleName);
								line(`'${ruleName}'?: any,`);
								stats[rulesDir]++;
							}
						}
					}
				}
			}
		} catch (err) {
			console.error(`Failed to parse tslint.json: ${err}`);
		}
	}

	// Also scan node_modules for tslint and common plugins if they exist
	const nodeModulesDir = path.join(projectRoot, 'node_modules');
	if (fs.existsSync(nodeModulesDir)) {
		const tslintDir = path.join(nodeModulesDir, 'tslint', 'lib', 'rules');
		if (fs.existsSync(tslintDir)) {
			const ruleFiles = fs.readdirSync(tslintDir);
			stats['tslint'] = 0;
			for (const ruleFile of ruleFiles) {
				if (ruleFile.endsWith('Rule.js')) {
					const ruleName = ruleFile
						.slice(0, -'Rule.js'.length)
						.replace(/([a-z0-9])([A-Z])/g, '$1-$2')
						.toLowerCase();
					
					if (!visited.has(ruleName)) {
						visited.add(ruleName);
						line(`'${ruleName}'?: any,`);
						stats['tslint']++;
					}
				}
			}
		}
	}

	indentLevel--;
	line(`}`);

	return { dts, stats };

	function line(text: string) {
		dts += '\t'.repeat(indentLevel) + text + '\n';
	}
}
