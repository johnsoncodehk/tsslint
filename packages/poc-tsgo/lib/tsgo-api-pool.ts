// One tsgo child process per CLI worker. Multi-`--project` runs call
// `updateSnapshot({ openProject })` on the same API instead of spawn +
// teardown per tsconfig.

import { loadTsgoModules } from './tsgo-load.js';

type TsgoSync = ReturnType<typeof loadTsgoModules>['sync'];
type TsgoAPI = InstanceType<TsgoSync['API']>;

let sharedApi: TsgoAPI | undefined;
let beforeExitHooked = false;

function ensureBeforeExitHook(): void {
	if (beforeExitHooked) return;
	beforeExitHooked = true;
	process.once('beforeExit', () => {
		closeSharedTsgoApi();
	});
}

/** Lazily spawn tsgo once; reuse until `closeSharedTsgoApi`. */
export function acquireSharedTsgoApi(): TsgoAPI {
	if (!sharedApi) {
		const { sync } = loadTsgoModules();
		sharedApi = new sync.API({});
		ensureBeforeExitHook();
	}
	return sharedApi;
}

export function closeSharedTsgoApi(): void {
	sharedApi?.close();
	sharedApi = undefined;
}

export function hasSharedTsgoApi(): boolean {
	return sharedApi != null;
}
