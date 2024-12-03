import type { Plugin, Rules } from '@tsslint/types';
import { exec } from 'node:child_process';
import type * as ts from 'typescript';

interface Cmd {
	command: typeof cmd;
	file: string;
	url: string;
}

const cmd = 'eslint:open-eslint-rule-docs';
const decorated = new WeakSet<ts.LanguageService>();

export function create(): Plugin {
	return ({ languageService }) => {
		const ruleId2Meta = new Map<string, { docs?: { url: string; }; }>();

		if (!decorated.has(languageService)) {
			decorated.add(languageService);
			const { applyCodeActionCommand } = languageService;
			languageService.applyCodeActionCommand = async (command, ...rest: any) => {
				if (typeof command === 'object' && (command as Cmd)?.command === cmd) {
					const start = process.platform == 'darwin' ? 'open' : process.platform == 'win32' ? 'start' : 'xdg-open';
					exec(`${start} ${(command as Cmd).url}`);
					return {};
				}
				return await applyCodeActionCommand(command, ...rest) as any;
			};
		}

		return {
			resolveRules(_fileName, rules) {
				collectMetadata(rules);
				return rules;
			},
			resolveCodeFixes(sourceFile, diagnostic, codeFixes) {
				const ruleMeta = ruleId2Meta.get(diagnostic.code as any);
				if (!ruleMeta?.docs?.url) {
					return codeFixes;
				}
				return [
					...codeFixes,
					{
						changes: [],
						description: `Show documentation for ${diagnostic.code}`,
						fixName: 'Show documentation',
						commands: [{
							command: cmd,
							file: sourceFile.fileName,
							url: ruleMeta.docs.url,
						} satisfies Cmd],
					},
				];
			},
		};

		function collectMetadata(rules: Rules, paths: string[] = []) {
			for (const [path, rule] of Object.entries(rules)) {
				if (typeof rule === 'object') {
					collectMetadata(rule, [...paths, path]);
					continue;
				}
				const meta = (rule as any).meta;
				if (typeof meta === 'object' && meta) {
					const ruleId = [...paths, path].join('/');
					ruleId2Meta.set(ruleId, meta);
				}
			}
		};
	};
}