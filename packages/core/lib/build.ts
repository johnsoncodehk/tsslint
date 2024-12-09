import { watchConfig } from './watch';
import _path = require('path');

export function buildConfig(
	configFilePath: string,
	createHash?: (path: string) => string,
	// @ts-expect-error
	logger?: typeof import('@clack/prompts')
): Promise<string | undefined> {
	const buildStart = Date.now();
	const configFileDisplayPath = _path.relative(process.cwd(), configFilePath);
	const spinner = logger?.spinner();

	spinner?.start('Building ' + configFileDisplayPath);

	return new Promise(async resolve => {
		try {
			await watchConfig(
				configFilePath,
				builtConfig => {
					if (builtConfig) {
						spinner?.stop('Built ' + configFileDisplayPath + ' in ' + (Date.now() - buildStart) + 'ms');
					} else {
						spinner?.stop('Failed to build ' + configFileDisplayPath + ' in ' + (Date.now() - buildStart) + 'ms', 1);
					}
					resolve(builtConfig);
				},
				false,
				createHash,
				spinner
			);
		} catch (e) {
			spinner?.stop('Failed to build ' + configFileDisplayPath + ' in ' + (Date.now() - buildStart) + 'ms', 1);
			resolve(undefined);
		}
	});
}
