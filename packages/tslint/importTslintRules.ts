import type * as TSSLint from '@tsslint/types';
import type { IOptions, IRule, IRuleMetadata } from 'tslint';
import { convertRule } from './index';
import * as path from 'path';
import * as fs from 'fs';
import * as ts from 'typescript';

type O<T extends any[]> = boolean | T;

export interface TSLintRulesConfig {
  [ruleName: string]: any;
}

function toPascalCase(kebabCase: string): string {
  return kebabCase.split('-').map(part => part.charAt(0).toUpperCase() + part.slice(1)).join('');
}

async function findTslintRule(ruleName: string, rulesDirectory?: string | string[]): Promise<{ metadata?: IRuleMetadata; new(options: IOptions): IRule; } | undefined> {
  const pascalCaseRuleName = toPascalCase(ruleName) + 'Rule';

  try {
    const tslint = require('tslint');
    const Rule = tslint.Rules[pascalCaseRuleName];
    if (Rule) {
      return Rule;
    }
  } catch (e) {}

  const directories = Array.isArray(rulesDirectory) ? rulesDirectory : (rulesDirectory ? [rulesDirectory] : []);
  for (const dir of directories) {
    const rulePath = path.join(dir, ruleName + '.js');
    if (fs.existsSync(rulePath)) {
      try {
        const Rule = require(rulePath).Rule;
        if (Rule) {
          return Rule;
        }
      } catch (e) {
        console.error(`[TSSLint/TSLint] Failed to load rule from ${rulePath}:`, e);
      }
    }
  }

  try {
    const pluginName = ruleName.split('/')[0];
    if (pluginName.startsWith('tslint-plugin-') || pluginName.startsWith('@')) {
      const plugin = require(pluginName);
      const Rule = plugin.Rules?.[pascalCaseRuleName];
      if (Rule) {
        return Rule;
      }
    }
  } catch (e) {}

  console.warn(`[TSSLint/TSLint] TSLint rule '${ruleName}' not found.`);
  return undefined;
}

export async function importTslintRules(
  config: { [K in keyof TSLintRulesConfig]: O<TSLintRulesConfig[K]> },
  category: ts.DiagnosticCategory = ts.DiagnosticCategory.Message,
  rulesDirectory?: string | string[]
): Promise<Record<string, TSSLint.Rule>> {
  const tsslintRules: Record<string, TSSLint.Rule> = {};

  for (const [rule, configValue] of Object.entries(config)) {
    let enabled: boolean;
    let options: any[];

    if (Array.isArray(configValue)) {
      enabled = true;
      options = configValue;
    } else {
      enabled = configValue;
      options = [];
    }

    if (!enabled) {
      tsslintRules[rule] = () => {};
      continue;
    }

    const RuleClass = await findTslintRule(rule, rulesDirectory);

    if (!RuleClass) {
      throw new Error(`Failed to resolve TSLint rule "${rule}".`);
    }

    tsslintRules[rule] = convertRule(
      RuleClass,
      options,
      category
    );
  }

  return tsslintRules;
}
