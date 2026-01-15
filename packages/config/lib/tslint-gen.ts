import * as fs from 'fs';
import * as path from 'path';
import type { IRuleMetadata, RuleConstructor } from '@tsslint/compat-tslint';
import { getTSLintRulesDirectories } from './tslint';

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
	let defId = 0;

	line(`export interface TSLintRulesConfig {`);
	indentLevel++;

	const visited = new Set<string>();
	const defs = new Map<any, [string, string]>();
	const stats: Record<string, number> = {};
	const rulesDirectories = getTSLintRulesDirectories();

	for (const [rawDir, rulesDir] of rulesDirectories) {
		if (fs.existsSync(rulesDir)) {
			const ruleFiles = fs.readdirSync(rulesDir);
			stats[rawDir] = 0;
			for (const ruleFile of ruleFiles) {
				if (ruleFile.endsWith('Rule.js') || ruleFile.endsWith('Rule.ts')) {
					const camelCaseName = ruleFile.slice(0, -'Rule.js'.length);
					const ruleName = camelCaseName.replace(
						/[A-Z]/g,
						(c, i) => (i === 0 ? c.toLowerCase() : '-' + c.toLowerCase()),
					);
					if (!visited.has(ruleName)) {
						visited.add(ruleName);
						try {
							const rule: RuleConstructor = (await loader(path.join(rulesDir, ruleFile))).Rule;
							addRule(ruleName, rule.metadata, rawDir);
							stats[rawDir]++;
						}
						catch (e) {
							addRule(ruleName, undefined, rawDir, e);
							stats[rawDir]++;
						}
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
						addRule(ruleName, rule.metadata);
						stats['tslint']++;
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

	function addRule(ruleName: string, metadata: IRuleMetadata | undefined, rulesDir?: string, error?: any) {
		if (metadata || rulesDir || error) {
			line(`/**`);
			if (rulesDir) {
				line(` * @rulesDirectory ${rulesDir}`);
			}
			if (error) {
				line(` * @error ${error.message || error.toString()}`);
			}
			if (metadata?.description) {
				for (const lineText of metadata.description.trim().split('\n')) {
					line(` * ${lineText.replace(/\*\//g, '* /')}`);
				}
			}
			if (metadata?.descriptionDetails) {
				line(` *`);
				for (const lineText of metadata.descriptionDetails.trim().split('\n')) {
					line(` * ${lineText.replace(/\*\//g, '* /')}`);
				}
			}
			if (metadata?.rationale) {
				line(` *`);
				line(` * @rationale`);
				for (const lineText of metadata.rationale.trim().split('\n')) {
					line(` * ${lineText.replace(/\*\//g, '* /')}`);
				}
			}
			if (metadata?.optionsDescription) {
				line(` *`);
				line(` * @options`);
				for (const lineText of metadata.optionsDescription.trim().split('\n')) {
					line(` * ${lineText.replace(/\*\//g, '* /')}`);
				}
			}
			if (metadata?.optionExamples) {
				line(` *`);
				line(` * @example`);
				for (const example of metadata.optionExamples) {
					if (typeof example === 'string') {
						for (const lineText of example.trim().split('\n')) {
							line(` * ${lineText.replace(/\*\//g, '* /')}`);
						}
					}
					else {
						line(` * ${JSON.stringify(ruleName)}: ${JSON.stringify(example)}`);
					}
				}
			}
			if (metadata?.type) {
				line(` *`);
				line(` * @type ${metadata.type}`);
			}
			if (metadata?.typescriptOnly) {
				line(` *`);
				line(` * @typescriptOnly`);
			}
			line(` */`);
		}

		let optionsType: string | undefined;
		const schema = metadata?.options;

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
			line(`'${ruleName}'?: ${optionsType},`);
		}
		else {
			line(`'${ruleName}'?: any[],`);
		}
	}

	function line(line: string) {
		dts += indent(indentLevel) + line + '\n';
	}

	function parseSchema(schema: any, item: any, indentLevel: number): string {
		if (typeof item === 'object' && item !== null) {
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
}
