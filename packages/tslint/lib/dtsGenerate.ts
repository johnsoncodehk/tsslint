import * as fs from 'fs';
import * as path from 'path';
import type { IRuleMetadata } from 'tslint';

/**
 * Generates TypeScript declaration file for TSLint rules, to be used with `importTslintRules`.
 */
export async function generate(
	nodeModulesDirs: string[],
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

	line(`export interface TSLintRulesConfig {`);
	indentLevel++;

	const visited = new Set<string>();

	// 1. Load built-in TSLint rules
	try {
		const tslint = await loader('tslint');
		if (tslint && tslint.Rules) {
			for (const ruleName in tslint.Rules) {
				const RuleClass = tslint.Rules[ruleName];
				if (RuleClass && RuleClass.metadata) {
					addRule(undefined, ruleName.replace(/Rule$/, ''), RuleClass.metadata);
				}
			}
		}
	} catch (e) {
		console.warn(`[TSSLint/TSLint] Failed to load built-in TSLint rules: ${e}`);
	}

	// 2. Load TSLint plugin rules from node_modules
	for (const nodeModulesDir of nodeModulesDirs) {
		const pkgs = readdirDirSync(nodeModulesDir);

		for (const pkg of pkgs) {
			if (pkg.startsWith('@')) {
				const subPkgs = readdirDirSync(path.join(nodeModulesDir, pkg));
				for (const subPkg of subPkgs) {
					if (subPkg.startsWith('tslint-plugin-') || subPkg === 'tslint-plugin') {
						const pluginName = `${pkg}/${subPkg}`;
						let plugin = await loader(pluginName);
						if ('default' in plugin) {
							plugin = plugin.default;
						}
						if (plugin.rules) {
							for (const ruleName in plugin.rules) {
								const RuleClass = plugin.rules[ruleName];
								if (RuleClass && RuleClass.metadata) {
									addRule(pkg, `${subPkg.replace('tslint-plugin-', '')}/${ruleName.replace(/Rule$/, '')}`, RuleClass.metadata);
								}
							}
						}
					}
				}
			}
			else if (pkg.startsWith('tslint-plugin-')) {
				let plugin = await loader(pkg);
				if ('default' in plugin) {
					plugin = plugin.default;
				}
				if (plugin.rules) {
					const scope = pkg.replace('tslint-plugin-', '');
					for (const ruleName in plugin.rules) {
						const RuleClass = plugin.rules[ruleName];
						if (RuleClass && RuleClass.metadata) {
							addRule(scope, ruleName.replace(/Rule$/, ''), RuleClass.metadata);
						}
					}
				}
			}
		}
	}

	// TODO: Add support for rulesDirectory from tslint.json

	indentLevel--;
	line(`}`);
	line(``);

	return dts;

	function addRule(scope: string | undefined, ruleName: string, metadata: IRuleMetadata) {
		let ruleKey: string;
		if (scope) {
			ruleKey = `${scope}/${ruleName}`;
		} else {
			ruleKey = `${ruleName}`;
		}

		if (visited.has(ruleKey)) {
			return;
		}
		visited.add(ruleKey);

		const { description, options } = metadata;

		if (description) {
			line(`/**`);
			line(` * ${description.replace(/\*\//g, '* /')}`);
			line(` */`);
		}

		let optionsType: string | undefined;

		if (options) {
			// TSLint options are often less structured than ESLint schemas.
			// For now, we'll generate a simple array type. A more advanced solution
			// would involve parsing the 'options' field if it contains a JSON schema.
			optionsType = `boolean | any[]`; // TSLint rules usually start with a boolean severity
		} else {
			optionsType = `boolean`; // If no options, just boolean for severity
		}

		if (optionsType) {
			line(`'${ruleKey}'?: ${optionsType},`);
		} else {
			line(`'${ruleKey}'?: boolean,`);
		}
	}

	function line(line: string) {
		dts += indent(indentLevel) + line + '\n';
	}

	function indent(indentLevel: number) {
		return '\t'.repeat(indentLevel);
	}

	function readdirDirSync(_path: string): string[] {
		return fs.readdirSync(_path, { withFileTypes: true })
			.filter(dirent => {
				if (dirent.isDirectory()) {
					return true;
				}
				if (dirent.isSymbolicLink()) {
					const fullPath = path.join(_path, dirent.name);
					try {
						return fs.statSync(fullPath).isDirectory();
					} catch {
						return false;
					}
				}
				return false;
			})
			.map(dirent => dirent.name);
	}
}
