const _reset = '\x1b[0m';

export const gray = (s: string | number) => '\x1b[90m' + s + _reset;
export const red = (s: string | number) => '\x1b[91m' + s + _reset;
export const green = (s: string | number) => '\x1b[92m' + s + _reset;
export const yellow = (s: string | number) => '\x1b[93m' + s + _reset;
export const blue = (s: string | number) => '\x1b[94m' + s + _reset;
export const purple = (s: string | number) => '\x1b[95m' + s + _reset;
export const cyan = (s: string | number) => '\x1b[96m' + s + _reset;

// https://talyian.github.io/ansicolors/
export const tsColor = (s: string) => '\x1b[34m' + s + _reset;
export const tsMacroColor = (s: string) => '\x1b[38;5;135m' + s + _reset;
export const vueColor = (s: string) => '\x1b[32m' + s + _reset;
export const vueVineColor = (s: string) => '\x1b[38;5;48m' + s + _reset;
export const mdxColor = (s: string) => '\x1b[33m' + s + _reset;
export const astroColor = (s: string) => '\x1b[38;5;209m' + s + _reset;
