import { createIgnorePlugin } from '@tsslint/config';

/**
 * @deprecated Use `createIgnorePlugin` from `@tsslint/config` instead.
 */
export function create(reportsUnusedComments = true) {
	return createIgnorePlugin('eslint-disable-next-line', reportsUnusedComments);
}
