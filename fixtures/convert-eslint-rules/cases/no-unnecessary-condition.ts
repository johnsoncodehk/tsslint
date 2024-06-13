// @ts-nocheck
function head<T>(items: T[]) {
    // items can never be nullable, so this is unnecessary
    if (items) {
        return items[0].toUpperCase();
    }
}

function foo(arg: 'bar' | 'baz') {
    // arg is never nullable or empty string, so this is unnecessary
    if (arg) {
    }
}

function bar<T>(arg: string) {
    // arg can never be nullish, so ?. is unnecessary
    return arg?.length;
}

// Checks array predicate return types, where possible
[
    [1, 2],
    [3, 4],
].filter(t => t); // number[] is always truthy
