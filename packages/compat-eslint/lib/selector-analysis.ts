// Selector → trigger-type analysis for selector-aware traversal (Phase B).
//
// Given the union of all rule listener selectors, compute the set of node
// types that COULD be matched by any selector. The traverser uses this set
// to skip materialising subtrees that cannot contain any trigger type.
//
// We over-approximate (safer to over-materialise than under-emit). When in
// doubt — `:not`, `:has`, `[name="x"]` standalone, unknown class macros —
// we mark the set as "all", disabling skip optimisation entirely.
//
// esquery selector AST shapes (from esquery@1.7.0):
//   identifier     value: typeName
//   wildcard       *
//   compound       selectors: [...] — same node satisfies all
//   matches        selectors: [...] — union
//   not            selectors: [...] — could match anything except listed
//   has            selectors: [...] — filter on descendants
//   child          left > right
//   descendant     left right
//   sibling        left ~ right
//   adjacent       left + right
//   attribute      [name=value]
//   field          .fieldName
//   class          :exit, :function, :statement, :expression, :pattern, :declaration, :first-child, …
//   nth-child      :nth-child(N)
//   nth-last-child :nth-last-child(N)

// Resolved transitively through eslint (which depends on esquery).
// Avoids adding a direct dep just for selector parsing.
const esqueryPath = require.resolve('esquery', { paths: [require.resolve('eslint/package.json')] });
const esquery = require(esqueryPath) as { parse(selector: string): unknown };

export interface TriggerSet {
	matches(nodeType: string): boolean;
	isAll(): boolean;
}

class TriggerSetImpl implements TriggerSet {
	private all = false;
	private exactTypes = new Set<string>();
	private suffixes = new Set<string>();

	matches(nodeType: string): boolean {
		if (this.all) return true;
		if (this.exactTypes.has(nodeType)) return true;
		for (const suffix of this.suffixes) {
			if (nodeType.endsWith(suffix)) return true;
		}
		return false;
	}

	isAll(): boolean {
		return this.all;
	}

	isEmpty(): boolean {
		return !this.all && this.exactTypes.size === 0 && this.suffixes.size === 0;
	}

	setAll(): void {
		this.all = true;
		this.exactTypes.clear();
		this.suffixes.clear();
	}

	addType(t: string): void {
		if (!this.all) this.exactTypes.add(t);
	}

	addSuffix(s: string): void {
		if (!this.all) this.suffixes.add(s);
	}

	mergeFrom(other: TriggerSetImpl): void {
		if (this.all || other.isEmpty()) return;
		if (other.all) {
			this.setAll();
			return;
		}
		for (const t of other.exactTypes) this.exactTypes.add(t);
		for (const s of other.suffixes) this.suffixes.add(s);
	}
}

// ESLint dispatches some listener keys outside the selector mechanism:
// onCodePathStart / onCodePathEnd / onCodePathSegmentStart /
// onCodePathSegmentEnd / onCodePathSegmentLoop /
// onUnreachableCodePathSegmentStart / onUnreachableCodePathSegmentEnd.
// These don't parse as selectors, but more importantly they require full
// CodePathAnalyzer traversal — we MUST visit every node when any of them
// are registered, otherwise CPA is incomplete.
export function isCodePathListener(key: string): boolean {
	return key.startsWith('onCodePath') || key.startsWith('onUnreachableCodePath');
}

export function buildTriggerSet(selectors: Iterable<string>): TriggerSet {
	const into = new TriggerSetImpl();
	for (const sel of selectors) {
		if (into.isAll()) break;
		if (isCodePathListener(sel)) {
			// CPA listeners are not selectors. Their presence means we can't
			// skip subtrees at all. Caller decides; we just signal "all".
			into.setAll();
			continue;
		}
		let ast: any;
		try {
			ast = esquery.parse(sel);
		} catch {
			// Unknown selector syntax → conservative: matches everything.
			into.setAll();
			continue;
		}
		visit(ast, into);
	}
	return into;
}

function visit(ast: any, into: TriggerSetImpl): void {
	if (into.isAll()) return;
	switch (ast.type) {
		case 'identifier':
			into.addType(ast.value);
			return;
		case 'wildcard':
			into.setAll();
			return;
		case 'compound':
			visitCompound(ast.selectors, into);
			return;
		case 'child':
		case 'descendant':
		case 'sibling':
		case 'adjacent':
			// The MATCHED node is the right-hand side. Left is structural context.
			visit(ast.right, into);
			return;
		case 'matches':
			for (const sub of ast.selectors) visit(sub, into);
			return;
		case 'class':
			handleClass(ast.name, into);
			return;
		// Standalone filter selectors — they don't constrain type, so they
		// could match anything. Inside a compound, the compound visitor
		// handles them (skips them, doesn't drag in setAll).
		case 'not':
		case 'has':
		case 'attribute':
		case 'field':
		case 'nth-child':
		case 'nth-last-child':
		case 'exactNode':
			into.setAll();
			return;
		default:
			into.setAll();
			return;
	}
}

// Compound selector: one node must satisfy every constraint. We compute
// each member's type set independently. If a member resolves to "all"
// (because it's a filter like `:exit`, `:not(...)`, `:has(...)`, or
// `[attr]`), it doesn't constrain the matched type — skip it. If any
// member contributes a non-all set, those types union into `into`.
//
// True semantic is intersection of member type sets; we over-approximate
// with union when 2+ members both contribute. Over-approximation is
// always safe (more nodes considered as triggers, fewer subtrees skipped).
//
// If every member resolves to all (or empty), the compound has no type
// constraint → `into.setAll()`.
function visitCompound(selectors: any[], into: TriggerSetImpl): void {
	let contributedAny = false;
	for (const sub of selectors) {
		const subSet = new TriggerSetImpl();
		visit(sub, subSet);
		if (subSet.isAll() || subSet.isEmpty()) continue;
		into.mergeFrom(subSet);
		if (into.isAll()) return;
		contributedAny = true;
	}
	if (!contributedAny) {
		into.setAll();
	}
}

// esquery's class macros (esquery.lite.js:3375). Suffix-based on node.type:
//   :statement   endsWith Statement; falls through to :declaration
//   :declaration endsWith Declaration
//   :pattern     endsWith Pattern; falls through to :expression
//   :expression  endsWith Expression || endsWith Literal || Identifier (non-MetaProperty ancestor) || MetaProperty
//   :function    one of FunctionDeclaration / FunctionExpression / ArrowFunctionExpression
function handleClass(name: string, into: TriggerSetImpl): void {
	switch (String(name).toLowerCase()) {
		case 'statement':
			into.addSuffix('Statement');
			into.addSuffix('Declaration');
			return;
		case 'declaration':
			into.addSuffix('Declaration');
			return;
		case 'pattern':
			into.addSuffix('Pattern');
			into.addSuffix('Expression');
			into.addSuffix('Literal');
			into.addType('Identifier');
			into.addType('MetaProperty');
			return;
		case 'expression':
			into.addSuffix('Expression');
			into.addSuffix('Literal');
			into.addType('Identifier');
			into.addType('MetaProperty');
			return;
		case 'function':
			into.addType('FunctionDeclaration');
			into.addType('FunctionExpression');
			into.addType('ArrowFunctionExpression');
			return;
		default:
			// :exit, :first-child, :last-child, :scope, custom — phase
			// markers / structural with no type constraint. When standalone
			// (e.g., a literal selector ":exit"), they could match anything.
			into.setAll();
			return;
	}
}
