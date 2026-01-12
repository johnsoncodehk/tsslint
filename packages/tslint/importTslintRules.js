"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.importTslintRules = importTslintRules;
const index_1 = require("./index");
const path = require("path");
const fs = require("fs");
const ts = require("typescript");
function toPascalCase(kebabCase) {
    return kebabCase.split('-').map(part => part.charAt(0).toUpperCase() + part.slice(1)).join('');
}
async function findTslintRule(ruleName, rulesDirectory) {
    const pascalCaseRuleName = toPascalCase(ruleName) + 'Rule';
    try {
        const tslint = require('tslint');
        const Rule = tslint.Rules[pascalCaseRuleName];
        if (Rule) {
            return Rule;
        }
    }
    catch (e) { }
    const directories = Array.isArray(rulesDirectory) ? rulesDirectory : (rulesDirectory ? [rulesDirectory] : []);
    for (const dir of directories) {
        const rulePath = path.join(dir, ruleName + '.js');
        if (fs.existsSync(rulePath)) {
            try {
                const Rule = require(rulePath).Rule;
                if (Rule) {
                    return Rule;
                }
            }
            catch (e) {
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
    }
    catch (e) { }
    console.warn(`[TSSLint/TSLint] TSLint rule '${ruleName}' not found.`);
    return undefined;
}
async function importTslintRules(config, category = ts.DiagnosticCategory.Message, rulesDirectory) {
    const tsslintRules = {};
    for (const [rule, configValue] of Object.entries(config)) {
        let enabled;
        let options;
        if (Array.isArray(configValue)) {
            enabled = true;
            options = configValue;
        }
        else {
            enabled = configValue;
            options = [];
        }
        if (!enabled) {
            tsslintRules[rule] = () => { };
            continue;
        }
        const RuleClass = await findTslintRule(rule, rulesDirectory);
        if (!RuleClass) {
            throw new Error(`Failed to resolve TSLint rule "${rule}".`);
        }
        tsslintRules[rule] = (0, index_1.convertRule)(RuleClass, options, category);
    }
    return tsslintRules;
}
//# sourceMappingURL=importTslintRules.js.map