export * from './lib/types';
export * from './lib/findConfigFile';

import type { Config } from './lib/types';

export function defineConfig(config: Config) {
	return config;
}
