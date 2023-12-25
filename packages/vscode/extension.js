module.exports.activate = () => { };
module.exports.deactivate = () => { };

try {
	const tsExtension = require('vscode').extensions.getExtension('vscode.typescript-language-features');
	const extensionJsPath = require.resolve('./dist/extension.js', { paths: [tsExtension.extensionPath] });
	const readFileSync = require('fs').readFileSync;

	require('assert')(!require.cache[extensionJsPath]);
	require('fs').readFileSync = (...args) => {
		if (args[0] === extensionJsPath) {
			let text = readFileSync(...args);
			// patch getFixableDiagnosticsForContext
			text = text.replace('t.has(e.code+"")', s => `(${s}||e.source==="tsslint")`);
			return text;
		}
		return readFileSync(...args);
	};
} catch { }
