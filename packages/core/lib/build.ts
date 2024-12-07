import type { Config } from '@tsslint/config';
import { watchConfigFile } from './watch';

export function buildConfigFile(
	configFilePath: string,
	createHash?: (path: string) => string,
	// @ts-expect-error
	logger?: typeof import('@clack/prompts')
): Promise<Config | Config[]> {
	return new Promise((resolve, reject) => {
		watchConfigFile(
			configFilePath,
			(config, result) => {
				if (config) {
					resolve(config);
				}
				else {
					reject(result);
				}
			},
			false,
			createHash,
			logger
		);
	});
}
