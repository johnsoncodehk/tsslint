export * from './lib/build';
export * from './lib/watch';
export * from './lib/tslint';
export * from './lib/types';

import type { Config } from './lib/types';

export function defineConfig(config: Config) {
	return config;
}
