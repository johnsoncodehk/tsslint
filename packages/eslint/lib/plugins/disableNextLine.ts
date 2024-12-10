import { createIgnorePlugin } from '@tsslint/config';

/**
 * @deprecated Use `createIgnorePlugin` from `@tsslint/config` instead.
 */
export function create(
	reportsUnusedComments = true,
	reg = new RegExp(/\/\/\s*eslint-disable-next-line\b[ \t]*(?<ruleId>\S*)\b/g)
) {
	return createIgnorePlugin('eslint-disable-next-line', reportsUnusedComments, reg);
}
