import { createIgnorePlugin } from '@tsslint/config';

/**
 * @deprecated Use `createIgnorePlugin` from `@tsslint/config` instead.
 */
export function create(
	reportsUnusedComments = true,
	cmdOrReg = 'eslint-disable-next-line'
) {
	return createIgnorePlugin(cmdOrReg, reportsUnusedComments);
}
