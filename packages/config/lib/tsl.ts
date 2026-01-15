import { convertRule } from '@tsslint/compat-tsl';
import type * as TSSLint from '@tsslint/types';
import * as fs from 'fs';
import { createRequire } from 'module';
import * as path from 'path';
import type * as ts from 'typescript';
import { pathToFileURL } from 'url';

const require = createRequire(import.meta.url);

export async function importTSLRules(
	rules: TSSLint.Config['rules'],
	ruleNames: string[],
	severity: 'error' | 'warn' | boolean = true,
) {
	let tsl: any;
	try {
		tsl = require('tsl');
	}
	catch {
		// Try to find tsl in the project's node_modules
		const tslDir = path.join(process.cwd(), 'node_modules', 'tsl');
		if (fs.existsSync(tslDir)) {
			const pkgJson = JSON.parse(fs.readFileSync(path.join(tslDir, 'package.json'), 'utf8'));
			const mainFile = path.join(tslDir, pkgJson.module || pkgJson.main || 'index.js');
			tsl = await import(pathToFileURL(mainFile).href);
		}
	}

	if (!tsl) {
		throw new Error('Failed to load "tsl" package. Please ensure it is installed.');
	}

	const tslRules = tsl.core || tsl;

	for (const ruleName of ruleNames) {
		let tslRuleName = ruleName.startsWith('tsl/') ? ruleName.slice(4) : ruleName;
		tslRuleName = tslRuleName.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
		const rule = tslRules[tslRuleName];
		if (!rule) {
			throw new Error(`Failed to resolve TSL rule "${ruleName}".`);
		}
		rules[ruleName] = convertRule(
			rule,
			severity === 'error'
				? 1 satisfies ts.DiagnosticCategory.Error
				: severity === 'warn'
				? 0 satisfies ts.DiagnosticCategory.Warning
				: 3 satisfies ts.DiagnosticCategory.Message,
		);
	}
}
