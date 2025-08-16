const vscode = require('vscode');

module.exports.activate = () => { };
module.exports.deactivate = () => { };

try {
	const tsExtension = vscode.extensions.getExtension('vscode.typescript-language-features');
	const extensionJsPath = require.resolve('./dist/extension.js', { paths: [tsExtension.extensionPath] });
	const readFileSync = require('fs').readFileSync;

	require('assert')(!require.cache[extensionJsPath]);
	require('fs').readFileSync = (...args) => {
		if (args[0] === extensionJsPath) {
			let text = readFileSync(...args);

			// Fix DiagnosticCategory.Message display
			text = text.replace('.category){case', '.category){case "message":return 2;case')

			// Patch getFixableDiagnosticsForContext
			text = text.replace('t.has(e.code+"")', s => `(${s}||e.source==="tsslint")`);

			// Support "Fix all"
			for (const replaceText of [
				'const i=new y(t,n,r);',
				// VSCode 1.93.1 (#36)
				'const i=new v(t,n,r)',
			]) {
				if (!text.includes(replaceText)) {
					continue;
				}
				text = text.replace(replaceText, s => s + `
const vscode = require('vscode');
vscode.languages.registerCodeActionsProvider(
	e.semantic,
	{
		async provideCodeActions(document, range, context, token) {
			if (!context.only || (context.only.value !== 'source' && context.only.value !== 'source.fixAll' && context.only.value !== 'source.fixAll.tsslint' && !context.only.value.startsWith('source.fixAll.tsslint.'))) {
				return;
			}
			let action;
			for (const diagnostic of context.diagnostics) {
				if (token.isCancellationRequested) {
					return;
				}

				if (diagnostic.source !== 'tsslint') {
					continue;
				}

				if (!action) {
					action = new vscode.CodeAction('Fix all TSSLint issues', vscode.CodeActionKind.SourceFixAll.append('tsslint'));
					action.edit = new vscode.WorkspaceEdit();
				}

				const args = {
					file: document.uri.fsPath,
					startLine: diagnostic.range.start.line + 1,
					startOffset: diagnostic.range.start.character + 1,
					endLine: diagnostic.range.end.line + 1,
					endOffset: diagnostic.range.end.character + 1,
					errorCodes: [diagnostic.code],
				};

				const response = await n.client.execute('getCodeFixes', args, token);
				if (response.type !== 'response') {
					continue;
				}

				const fix = response.body?.find(fix => fix.fixName === 'tsslint:' + diagnostic.code);
				if (fix) {
					withFileCodeEdits(action.edit, n.client, fix.changes);
				}
			}
			if (action) {
				return [action];
			}

			function withFileCodeEdits(
				workspaceEdit,
				client,
				edits
			) {
				for (const edit of edits) {
					const resource = client.toResource(edit.fileName);
					for (const textChange of edit.textChanges) {
						workspaceEdit.replace(
							resource,
							new vscode.Range(
								Math.max(0, textChange.start.line - 1), Math.max(textChange.start.offset - 1, 0),
								Math.max(0, textChange.end.line - 1), Math.max(0, textChange.end.offset - 1)),
							textChange.newText
						);
					}
				}
				return workspaceEdit;
			}
		}
	},
	{
		providedCodeActionKinds: [vscode.CodeActionKind.SourceFixAll.append('tsslint')],
	}
				);`)
			}

			// Ensure tsslint is the first plugin to be loaded, which fixes compatibility with "astro-build.astro-vscode"
			const pluginName = require('./package.json').contributes.typescriptServerPlugins[0].name;
			text = text.replace('"--globalPlugins",i.plugins', `"--globalPlugins",i.plugins.sort((a,b)=>(b.name==="${pluginName}"?1:0)-(a.name==="${pluginName}"?1:0))`);

			return text;
		}
		return readFileSync(...args);
	};
} catch { }
