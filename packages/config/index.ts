export * from './lib/findConfigFile';
export * from './lib/tslint';
export * from './lib/types';

import type { Config } from './lib/types';

export function defineConfig(config: Config) {
	return config;
}
