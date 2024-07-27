import type { Config } from '@tsslint/config';
import { watchConfigFile } from './watch';

export function buildConfigFile(
	configFilePath: string,
	createHash?: (path: string) => string,
	logger?: Pick<typeof console, 'log' | 'warn' | 'error'>
): Promise<Config> {
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
