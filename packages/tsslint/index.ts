import type { Config } from './lib/types';

export function defineConfig(config: Config) {
	return config;
}

export * from './lib/types';
export * from './lib/loadConfig';
