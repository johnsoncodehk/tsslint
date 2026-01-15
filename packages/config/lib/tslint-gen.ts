import * as fs from 'fs';
import * as path from 'path';
import type { RuleConstructor } from 'tslint';

export async function generateTSLintTypes(
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

	line(`export interface TSLintRulesConfig {`);
	indentLevel++;

	const visited = new Set<string>();
	const stats: Record<string, number> = {};

	// 1. Scan directories from tslint.json
	let dir = process.cwd();
	const rulesDirectories: string[] = [];
	while (true) {
		const tslintJsonPath = path.join(dir, 'tslint.json');
		if (fs.existsSync(tslintJsonPath)) {
			try {
				let content = fs.readFileSync(tslintJsonPath, 'utf8');
				// Simple comment removal
				content = content.replace(/\/\*[\s\S]*?\*\/|([^\\:]|^)\/\/.*$/gm, '$1');
				const tslintJson = JSON.parse(content);
				if (tslintJson.rulesDirectory) {
					const dirs = Array.isArray(tslintJson.rulesDirectory)
						? tslintJson.rulesDirectory
						: [tslintJson.rulesDirectory];
					for (const d of dirs) {
						rulesDirectories.push(path.resolve(dir, d));
					}
				}
			}
			catch {}
			break;
		}
		const parentDir = path.resolve(dir, '..');
		if (parentDir === dir) break;
		dir = parentDir;
	}

	for (const rulesDir of rulesDirectories) {
		if (fs.existsSync(rulesDir)) {
			const ruleFiles = fs.readdirSync(rulesDir);
			const dirName = path.basename(rulesDir);
			stats[dirName] = 0;
			for (const ruleFile of ruleFiles) {
				if (ruleFile.endsWith('Rule.js')) {
					const camelCaseName = ruleFile.replace('Rule.js', '');
					const ruleName = camelCaseName.replace(
						/[A-Z]/g,
						(c, i) => (i === 0 ? c.toLowerCase() : '-' + c.toLowerCase()),
					);
					if (!visited.has(ruleName)) {
						visited.add(ruleName);
						const rule: RuleConstructor = (await loader(path.join(rulesDir, ruleFile))).Rule;
						addRule(ruleName, rule);
						stats[dirName]++;
					}
				}
			}
		}
	}

	// 2. Scan TSLint core rules
	for (const nodeModulesDir of nodeModulesDirs) {
		const tslintDir = path.join(nodeModulesDir, 'tslint', 'lib', 'rules');
		if (fs.existsSync(tslintDir)) {
			const ruleFiles = fs.readdirSync(tslintDir);
			stats['tslint'] = stats['tslint'] || 0;
			for (const ruleFile of ruleFiles) {
				if (ruleFile.endsWith('Rule.js')) {
					const camelCaseName = ruleFile.replace('Rule.js', '');
					const ruleName = camelCaseName.replace(
						/[A-Z]/g,
						(c, i) => (i === 0 ? c.toLowerCase() : '-' + c.toLowerCase()),
					);
					if (!visited.has(ruleName)) {
						visited.add(ruleName);
						const rule: RuleConstructor = (await loader(path.join(tslintDir, ruleFile))).Rule;
						addRule(ruleName, rule);
						stats['tslint']++;
					}
				}
			}
		}
	}

	indentLevel--;
	line(`}`);

	return { dts, stats };

	function addRule(ruleName: string, rule: any) {
		const metadata = rule?.metadata;
		if (metadata) {
			line(`/**`);
			if (metadata.description) {
				line(` * ${metadata.description.replace(/\*\//g, '* /')}`);
			}
			if (metadata.rationale) {
				line(` *`);
				line(` * ${metadata.rationale.replace(/\*\//g, '* /')}`);
			}
			line(` */`);
		}
		line(`'${ruleName}'?: any[],`);
	}

	function line(line: string) {
		dts += indent(indentLevel) + line + '\n';
	}

	function indent(indentLevel: number) {
		return '\t'.repeat(indentLevel);
	}
}
