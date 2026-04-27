// Adversarial type-system patterns: distributive conditional with infer
// chain, mapped type with `as` clause renaming, template literal type
// + recursive narrowing, `keyof typeof X` chains, `typeof import()`
// indirection, ExpressionWithTypeArguments in type position.
// Hits: scope-manager type-position routing, _isValueReferencePosition's
// ExpressionWithTypeArguments special case, TSImportType qualifier
// skipping, mapped-type scope params.

const Routes = {
	home: '/home',
	profile: '/profile',
	settings: { user: '/settings/user', team: '/settings/team' },
} as const;
void Routes;

// keyof typeof — `Routes` is a value reference; the typeof wraps it.
// no-undef must NOT report Routes here.
type RouteKey = keyof typeof Routes;
const _r1: RouteKey = 'home';
void _r1;

// keyof typeof X.Y — chained; the `Routes` identifier is the value
// reference, `.settings` is a member-access in type position.
type SettingsKey = keyof typeof Routes.settings;
const _r2: SettingsKey = 'user';
void _r2;

// Distributive conditional with infer — the inferred type variable
// `U` is scoped to the trueType only; outer scope must not see it.
type Unwrap<T> = T extends Array<infer U> ? U : T extends Promise<infer U> ? U : T;
type _u1 = Unwrap<string[]>;
type _u2 = Unwrap<Promise<number>>;
void (null as any as _u1);
void (null as any as _u2);

// Nested infer — `infer K` then `infer V` in the same conditional;
// both must scope to the trueType.
type EntriesOf<T> = T extends Record<infer K, infer V> ? [K, V][] : never;
type _e = EntriesOf<{ a: 1; b: 2 }>;
void (null as any as _e);

// Mapped type with `as` clause — the `K` parameter is bound by the
// `in` clause, used in both the key and the value position.
type Renamed<T> = { [K in keyof T as `get${Capitalize<string & K>}`]: () => T[K] };
type _ren = Renamed<{ name: string; age: number }>;
void (null as any as _ren);

// Mapped type with conditional `as` filter — exclude keys.
type OmitFnKeys<T> = { [K in keyof T as T[K] extends Function ? never : K]: T[K] };
type _omit = OmitFnKeys<{ a: number; b: () => void }>;
void (null as any as _omit);

// Template literal type with recursive narrowing — used by typed-router
// libs. `Path` is recursive; the type-level recursion must not confuse
// scope-manager.
type SplitPath<S extends string> = S extends `${infer Head}/${infer Tail}` ? [Head, ...SplitPath<Tail>] : [S];
type _split = SplitPath<'a/b/c'>;
void (null as any as _split);

// typeof import() — qualifier names exports of imported module, not
// locals. The `import("inspector")` is in type position; its
// `.Session` qualifier must be skipped from free references.
type SessTypeOf = typeof import("inspector").Session.prototype;
void (null as any as SessTypeOf);

// ExpressionWithTypeArguments in `extends` clause — the `Vec`
// reference here is in *value* position (it's a class), but the type
// arguments aren't. Recently fixed; regression risk for
// _isValueReferencePosition.
class Base<T> { constructor(public readonly seed: T) {} }
class Derived extends Base<string> {
	constructor() { super('seed'); }
}
void Derived;

// extends with intersection in type args — TSIntersectionType inside
// ExpressionWithTypeArguments.
interface A { a: number }
interface B { b: number }
class Both extends Base<A & B> { constructor() { super({ a: 1, b: 2 }); } }
void Both;

// Conditional with template-literal narrowing — common in type-level
// parsers. Tests scope.through filtering for nested type params.
type IsHelloPrefix<S> = S extends `Hello, ${infer Name}` ? Name : never;
type _hp = IsHelloPrefix<'Hello, world'>;
void (null as any as _hp);
