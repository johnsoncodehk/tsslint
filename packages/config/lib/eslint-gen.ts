import * as fs from 'fs';
import * as path from 'path';

const variableNameRegex = /^[a-zA-Z_$][0-9a-zA-Z_$]*$/;

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
				const tslintJson = JSON.parse(fs.readFileSync(tslintJsonPath, 'utf8'));
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
						line(`'${ruleName}'?: any[],`);
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
						line(`'${ruleName}'?: any[],`);
						stats['tslint']++;
					}
				}
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

export async function generateESlintTypes(
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
	let defId = 0;

	line(`export interface ESLintRulesConfig {`);
	indentLevel++;

	const visited = new Set<string>();
	const defs = new Map<any, [string, string]>();
	const stats: Record<string, number> = {};

	for (const nodeModulesDir of nodeModulesDirs) {
		const pkgs = readdirDirSync(nodeModulesDir);

		for (const pkg of pkgs) {
			if (pkg.startsWith('@')) {
				const subPkgs = readdirDirSync(path.join(nodeModulesDir, pkg));
				for (const subPkg of subPkgs) {
					if (subPkg === 'eslint-plugin' || subPkg.startsWith('eslint-plugin-')) {
						const pluginName = `${pkg}/${subPkg}`;
						let plugin = await loader(pluginName);
						if ('default' in plugin) {
							plugin = plugin.default;
						}
						if (plugin.rules) {
							stats[pluginName] = 0;
							for (const ruleName in plugin.rules) {
								const rule = plugin.rules[ruleName];
								if (subPkg === 'eslint-plugin') {
									if (addRule(pkg, ruleName, rule)) {
										stats[pluginName]++;
									}
								}
								else {
									if (addRule(pkg, `${subPkg.slice('eslint-plugin-'.length)}/${ruleName}`, rule)) {
										stats[pluginName]++;
									}
								}
							}
						}
					}
				}
			}
			else if (pkg.startsWith('eslint-plugin-')) {
				let plugin = await loader(pkg);
				if ('default' in plugin) {
					plugin = plugin.default;
				}
				if (plugin.rules) {
					const scope = pkg.replace('eslint-plugin-', '');
					stats[pkg] = 0;
					for (const ruleName in plugin.rules) {
						const rule = plugin.rules[ruleName];
						if (addRule(scope, ruleName, rule)) {
							stats[pkg]++;
						}
					}
				}
			}
			else if (pkg === 'eslint') {
				const rulesDir = path.join(nodeModulesDir, pkg, 'lib', 'rules');
				const ruleFiles = fs.readdirSync(rulesDir);
				stats['eslint'] = 0;
				for (const ruleFile of ruleFiles) {
					if (ruleFile.endsWith('.js')) {
						const ruleName = ruleFile.replace('.js', '');
						const rule = await loader(path.join(rulesDir, ruleFile));
						if (addRule(undefined, ruleName, rule)) {
							stats['eslint']++;
						}
					}
				}
			}
		}
	}

	indentLevel--;
	line(`}`);
	line(``);

	for (const [typeName, typeString] of defs.values()) {
		line(`type ${typeName} = ${typeString};`);
	}

	return { dts, stats };

	function addRule(scope: string | undefined, ruleName: string, rule: any) {
		let ruleKey: string;
		if (scope) {
			ruleKey = `${scope}/${ruleName}`;
		}
		else {
			ruleKey = `${ruleName}`;
		}

		if (visited.has(ruleKey)) {
			return false;
		}
		visited.add(ruleKey);

		const meta = rule.meta ?? {};
		const { description, url } = meta.docs ?? {};
		const { schema } = meta;

		if (description || url) {
			line(`/**`);
			if (description) {
				line(` * ${description.replace(/\*\//g, '* /')}`);
			}
			if (url) {
				line(` * @see ${url}`);
			}
			line(` */`);
		}

		let optionsType: string | undefined;

		if (schema) {
			if (Array.isArray(schema)) {
				const optionsTypes: string[] = [];
				for (const item of schema) {
					const itemType = parseSchema(schema, item, indentLevel);
					optionsTypes.push(itemType);
				}
				optionsType = `[`;
				optionsType += optionsTypes
					.map(type => `(${type})?`)
					.join(', ');
				optionsType += `]`;
			}
			else {
				optionsType = parseSchema(schema, schema, indentLevel);
			}
		}

		if (optionsType) {
			line(`'${ruleKey}'?: ${optionsType},`);
		}
		else {
			line(`'${ruleKey}'?: any[],`);
		}
		return true;
	}

	function line(line: string) {
		dts += indent(indentLevel) + line + '\n';
	}

	function parseSchema(schema: any, item: any, indentLevel: number): string {
		if (typeof item === 'object') {
			if (item.$ref) {
				const paths = item.$ref
					.replace('#/items/', '#/')
					.split('/').slice(1);
				let current = schema;
				for (const path of paths) {
					try {
						current = current[path];
					}
					catch {
						current = undefined;
						break;
					}
				}
				if (current) {
					let resolved = defs.get(current);
					if (!resolved) {
						resolved = [`Def${defId++}_${paths[paths.length - 1]}`, parseSchema(schema, current, 0)];
						defs.set(current, resolved);
					}
					return resolved[0];
				}
				else {
					console.error(`Failed to resolve schema path: ${item.$ref}`);
					return 'unknown';
				}
			}
			else if (Array.isArray(item)) {
				return item.map(item => parseSchema(schema, item, indentLevel)).join(' | ');
			}
			else if (Array.isArray(item.type)) {
				return item.type.map((type: any) => parseSchema(schema, type, indentLevel)).join(' | ');
			}
			else if (item.properties) {
				let res = `{\n`;
				indentLevel++;
				const properties = item.properties;
				const requiredArr = item.required ?? [];
				for (const key in properties) {
					const property = properties[key];
					if (property.description) {
						res += indent(indentLevel) + `/**\n`;
						res += indent(indentLevel) + ` * ${property.description.replace(/\*\//g, '* /')}\n`;
						res += indent(indentLevel) + ` */\n`;
					}
					const propertyType = parseSchema(schema, property, indentLevel);
					const isRequired = requiredArr.includes(key);
					if (!variableNameRegex.test(key)) {
						res += indent(indentLevel) + `'${key}'${isRequired ? '' : '?'}: ${propertyType},\n`;
					}
					else {
						res += indent(indentLevel) + `${key}${isRequired ? '' : '?'}: ${propertyType},\n`;
					}
				}
				indentLevel--;
				res += indent(indentLevel) + `}`;
				if (item.additionalProperties) {
					res += ` & `;
					res += parseAdditionalProperties(schema, item.additionalProperties, indentLevel);
				}
				return res;
			}
			else if (Array.isArray(item.required)) {
				let res = `{ `;
				const propertiesType: string[] = [];
				for (const key of item.required) {
					const propertyType = `any`;
					if (!variableNameRegex.test(key)) {
						propertiesType.push(`'${key}': ${propertyType}`);
					}
					else {
						propertiesType.push(`${key}: ${propertyType}`);
					}
				}
				res += propertiesType.join(', ');
				res += ` }`;
				return res;
			}
			else if (item.const) {
				return JSON.stringify(item.const);
			}
			else if (item.type === 'array') {
				if (Array.isArray(item.items)) {
					return `[${item.items.map((item: any) => parseSchema(schema, item, indentLevel)).join(', ')}]`;
				}
				if (item.items) {
					return `(${parseSchema(schema, item.items, indentLevel)})[]`;
				}
				return `any[]`;
			}
			else if (item.enum) {
				return item.enum.map((v: any) => JSON.stringify(v)).join(' | ');
			}
			else if (item.type) {
				return parseSchema(schema, item.type, indentLevel);
			}
			else if (item.anyOf) {
				return item.anyOf.map((item: any) => parseSchema(schema, item, indentLevel)).join(' | ');
			}
			else if (item.oneOf) {
				return item.oneOf.map((item: any) => parseSchema(schema, item, indentLevel)).join(' | ');
			}
		}
		else if (item === 'string' || item === 'boolean' || item === 'null' || item === 'number') {
			return item;
		}
		else if (item === 'object') {
			if (item.additionalProperties) {
				return parseAdditionalProperties(schema, item.additionalProperties, indentLevel);
			}
			else {
				return `{ [key: string]: unknown }`;
			}
		}
		else if (item === 'integer') {
			return 'number';
		}
		else if (item === 'array') {
			return 'any[]';
		}
		return 'unknown';
	}

	function indent(indentLevel: number) {
		return '\t'.repeat(indentLevel);
	}

	function parseAdditionalProperties(schema: any, item: any, indentLevel: number) {
		if (item === true) {
			return `{ [key: string]: unknown }`;
		}
		else {
			return `{ [key: string]: ${parseSchema(schema, item, indentLevel)} }`;
		}
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
					}
					catch {
						return false;
					}
				}
				return false;
			})
			.map(dirent => dirent.name);
	}
}
