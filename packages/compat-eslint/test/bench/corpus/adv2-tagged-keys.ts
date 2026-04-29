// Adv2: Tagged template + computed key combo. Template expressions
// with side-effect calls inside `${}`, computed keys generated from
// template literals, tagged templates with spread arguments.
// Hits: TemplateLiteral / TaggedTemplateExpression predicates +
// computed key in object literal + the new MethodDeclaration visit.

function bump(): number {
	let n = 0;
	return n += 1;
}

const obj = { x: 1, y: 2 } as Record<string, number>;

// Template literal with computed access inside ${}.
// `${obj[bump()]}` — TemplateLiteral with ElementAccessExpression
// in its expression list.
export const tpl1 = `${obj[bump()]} suffix`;
void tpl1;

// Computed key built from template literal — `[\`prefix-${name}\`]: value`.
// ObjectExpression Property with `computed: true` and a TemplateLiteral
// as the key. no-useless-computed-key MUST NOT report (the key has a
// dynamic part).
const name = 'foo';
export const dyn = {
	[`prefix-${name}`]: 'value',
	[`literal`]: 'should-flag', // no-useless-computed-key flags this:
	                            // template with NO substitutions = same as a string literal.
};
void dyn;

// Tagged template with computed-key access result inside.
function tag(strs: TemplateStringsArray, ...vals: unknown[]): string {
	return strs.raw.join('') + vals.join(',');
}
export const tagged = tag`pre ${obj[`x`]} mid ${obj[bump()]} end`;
void tagged;

// Class with computed method names — `[\`m${i}\`](){}`.
// no-useless-computed-key on the method name. NEW: FunctionExpression
// listener now fires on these MethodDeclaration bodies.
const i = 0;
export class Methods {
	[`m${i}`](): number { return 1; }
	[`literal`](): number { return 2; } // useless-computed-key
	[`__static`](): number { return 3; }
}
void Methods;

// Computed key with side-effecting call.
export const sideEff = {
	[bump()]: 'value', // dynamic key
};
void sideEff;

// Tagged template invoking method that yields a generator (call-time
// effect). Combine with the new MethodDeclaration visit.
class Gen {
	*emit(): Generator<string, void, unknown> {
		yield 'a';
		yield 'b';
	}
	use(): string {
		const g = this.emit();
		return tag`first ${g.next().value} ; second ${g.next().value}`;
	}
}
export const gen = new Gen();
void gen.use();

// Template literal in default param.
export function withTplDefault(s: string = `default-${name}`): string {
	return s;
}
void withTplDefault;

// Nested template inside template — `\`a-${\`b-${x}\`}-c\``.
const x = 1;
export const nested = `a-${`b-${x}`}-c`;
void nested;
