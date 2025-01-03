import * as fs from 'fs';
import * as json5 from 'json5';
import type * as ts from 'typescript';

export function getVSCodeFormattingSettings(settingsFile: string) {
	const jsonc = fs.readFileSync(settingsFile, 'utf8');
	const editorSettings = json5.parse(jsonc);
	const jsSettings: ts.FormatCodeSettings = {};
	const tsSettings: ts.FormatCodeSettings = {};
	const vueSettings: {
		'script.initialIndent'?: boolean;
	} = {};

	if ('editor.insertSpaces' in editorSettings) {
		jsSettings.convertTabsToSpaces = !!editorSettings['editor.insertSpaces'];
		tsSettings.convertTabsToSpaces = !!editorSettings['editor.insertSpaces'];
	}
	if ('editor.tabSize' in editorSettings) {
		jsSettings.tabSize = editorSettings['editor.tabSize'];
		tsSettings.tabSize = editorSettings['editor.tabSize'];
	}
	for (const key in editorSettings) {
		if (key.startsWith('javascript.format.')) {
			const settingKey = key.slice('javascript.format.'.length) as keyof ts.FormatCodeSettings;
			// @ts-expect-error
			jsSettings[settingKey] = editorSettings[key];
		}
		else if (key.startsWith('typescript.format.')) {
			const settingKey = key.slice('typescript.format.'.length) as keyof ts.FormatCodeSettings;
			// @ts-expect-error
			tsSettings[settingKey] = editorSettings[key];
		}
	}
	if ('vue.format.script.initialIndent' in editorSettings) {
		vueSettings['script.initialIndent'] = !!editorSettings['vue.format.script.initialIndent'];
	}

	return {
		javascript: jsSettings,
		typescript: tsSettings,
		vue: vueSettings,
	};
}

export function computeInitialIndent(content: string, i: number, baseTabSize?: number) {
	let nChars = 0;
	const tabSize = baseTabSize || 4;
	while (i < content.length) {
		const ch = content.charAt(i);
		if (ch === ' ') {
			nChars++;
		} else if (ch === '\t') {
			nChars += tabSize;
		} else {
			break;
		}
		i++;
	}
	return Math.floor(nChars / tabSize);
}
