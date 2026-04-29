// Adversarial decorators: class + method + parameter + property + accessor.
// Each decorator references identifiers from outer scopes / other decorators.
// Hits: Decorator parent walk, recently-added wrapper drills for class
// members (PropertyDefinition / AccessorProperty / TSAbstract*),
// no-undef on decorator factory call expressions.

const Registry = new Map<string, unknown>();
void Registry;

// Decorator factories — referenced as values from class declarations.
function Entity(name: string): ClassDecorator {
	return (_target: any) => { Registry.set(name, _target); };
}
function Audit(level: 'info' | 'warn'): MethodDecorator & PropertyDecorator {
	return (_t: any, _k: any, _d?: any) => { void level; };
}
function Inject(token: string): ParameterDecorator {
	return (_t: any, _k: any, _i: number) => { void token; };
}
function Watch(): ClassAccessorDecoratorFunction<any, any> {
	return ((_v: any, _ctx: any) => undefined) as any;
}
type ClassAccessorDecoratorFunction<T, V> = (target: { get: (this: T) => V; set: (this: T, value: V) => void }, ctx: any) => any;

// Identifier referenced ONLY inside decorator arg — must NOT trip
// no-unused-vars semantically; here we exercise no-undef.
const SERVICE_TOKEN = 'service';
void SERVICE_TOKEN;

@Entity('user')
export class User {
	// Property decorator — `Audit` referenced here. Must resolve.
	@Audit('info')
	declare email: string;

	// Method decorator with arg — `Audit` referenced; level value
	// is a string literal.
	@Audit('warn')
	save(@Inject(SERVICE_TOKEN) svc: object): void {
		void svc;
	}

	// Constructor parameter property + parameter decorator — the
	// `private readonly` parameter property has a decorator on it.
	constructor(@Inject('id') public readonly id: string) {}

	// Accessor decorator on a getter — TS5+ accessor keyword is
	// distinct from get/set; here we use plain `get` with decorator.
	@Audit('info')
	get displayName(): string { return this.email ?? this.id; }
}
void User;

// Stage-3 `accessor` keyword field with decorator — distinct from
// get/set. ESLint's parser may or may not surface as AccessorProperty.
export class Settings {
	@Watch()
	accessor theme: 'light' | 'dark' = 'light';

	@Watch()
	static accessor count: number = 0;
}
void Settings;

// Decorator referencing another decorator-decorated class — the
// `User` reference must resolve.
function ChildOf(_parent: typeof User): ClassDecorator {
	return () => {};
}

@ChildOf(User)
export class Admin extends User {
	constructor() { super('admin'); }
}
void Admin;

// Decorator on a class expression assigned to a const — rare but
// legal; tests Decorator parent walk through VariableDeclarator.
const _Anon = @Entity('anon') class { name = 'anon'; };
void _Anon;
