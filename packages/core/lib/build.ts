import { watchConfig } from './watch';
import _path = require('path');

export function buildConfig(
	configFilePath: string,
	createHash?: (path: string) => string,
	// @ts-expect-error
	spinner?: ReturnType<typeof import('@clack/prompts').spinner>,
	stopSnipper?: (message: string, code?: number) => void
): Promise<string | undefined> {
	const buildStart = Date.now();
	const configFileDisplayPath = _path.relative(process.cwd(), configFilePath);

	spinner?.message('Building ' + configFileDisplayPath);

	return new Promise(async resolve => {
		try {
			await watchConfig(
				configFilePath,
				builtConfig => {
					if (builtConfig) {
						stopSnipper?.('Built ' + configFileDisplayPath + ' in ' + (Date.now() - buildStart) + 'ms');
					} else {
						stopSnipper?.('Failed to build ' + configFileDisplayPath + ' in ' + (Date.now() - buildStart) + 'ms', 1);
					}
					resolve(builtConfig);
				},
				false,
				createHash,
				spinner,
				stopSnipper
			);
		} catch (e) {
			stopSnipper?.('Failed to build ' + configFileDisplayPath + ' in ' + (Date.now() - buildStart) + 'ms', 1);
			resolve(undefined);
		}
	});
}
