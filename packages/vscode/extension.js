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
			text = text.replace('t.has(e.code+"")', s => `(${s}||e.source==="tsl")`);

			// patch buildIndividualFixes
			text = text.replace('!r.has(s.code)', s => `${s}&&s.source!=="tsl"`);
			text = text.replace('e.fixName===o', s => `${s}||s.source==="tsl"`);

			return text;
		}
		return readFileSync(...args);
	};
} catch { }
