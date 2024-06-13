// @ts-nocheck
{
    const foo = 3;
    const bar = foo!;
}
{
    const foo = <number>(3 + 5);
}
{
    type Foo = number;
    const foo = <Foo>(3 + 5);
}
{
    type Foo = number;
    const foo = (3 + 5) as Foo;
}
{
    const foo = 'foo' as const;
}
{
    function foo(x: number): number {
        return x!; // unnecessary non-null
    }
}
export { }
