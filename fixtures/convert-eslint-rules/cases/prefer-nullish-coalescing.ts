// @ts-nocheck
const foo: any = 'bar';
foo !== undefined && foo !== null ? foo : 'a string';
foo === undefined || foo === null ? 'a string' : foo;
foo == undefined ? 'a string' : foo;
foo == null ? 'a string' : foo;

const foo: string | undefined = 'bar';
foo !== undefined ? foo : 'a string';
foo === undefined ? 'a string' : foo;

const foo: string | null = 'bar';
foo !== null ? foo : 'a string';
foo === null ? 'a string' : foo;
