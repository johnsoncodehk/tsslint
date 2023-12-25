import type { Config } from './types';
import { watchConfigFile } from './watch';

export async function buildConfigFile(configFilePath: string): Promise<Config> {
	return new Promise((resolve, reject) => {
		watchConfigFile(configFilePath, (config, result) => {
			if (config) {
				resolve(config);
			}
			else {
				reject(result);
			}
		}, false);
	});
}
