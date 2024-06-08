import type { Config } from './types';
import { watchConfigFile } from './watch';

export function buildConfigFile(configFilePath: string, createHash?: (path: string) => string): Promise<Config> {
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
			createHash
		);
	});
}
