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

// Decompose a selector into a fast-dispatch description, or null if the
// selector can't be handled without an ESLint-style esquery walk.
//
// Beyond pure type-name matching, we also handle:
//   - `Type[attr=val]` / `Type[attr]` / `Type[attr!=val]` — attribute filter
//     becomes a per-target predicate; trigger types remain the type set.
//   - `Parent > Right.field` — trigger on Parent type, dispatch fires on
//     `target[field]`. Optional Right type narrows via post-fire check.
//   - `Parent > Right` (no field) — trigger on Right type, parent.type
//     check filters at dispatch time.
//   - `Parent Right` (descendant) — trigger on Right type; filter walks
//     ancestors looking for a Parent-typed match.
//
// Returns null on `:not`, `:has`, sibling/adjacent (~ +), `:nth-child`,
// `:scope`, raw class macros (`:statement`, `:expression`, …) or anything
// else where a precise per-target predicate would be expensive.
export interface FastDispatchInfo {
	// Trigger types for the listener. The dispatch loop fires when a
	// visited node's type is in this set. 'all' means visit every type.
	types: Set<string> | 'all';
	isExit: boolean;
	// When set, the listener receives `target[fieldFire]` instead of the
	// triggering target. Used for `Parent > *.field` / `Parent > Type.field`
	// patterns — trigger on Parent, but the listener is interested in a
	// specific child slot.
	fieldFire?: string;
	// Type that the dispatched node (post-fieldFire) must match. Set by
	// `Parent > Type.field` (Type is the constraint on the field child).
	typeFilter?: string;
	// Additional per-target predicate. Composes attribute checks,
	// ancestor walks, etc. Called after fieldFire / typeFilter resolve.
	filter?: (target: any) => boolean;
}

// `decomposeSimple` returns an array of dispatch infos. A single
// identifier / compound / child selector typically yields one entry, but
// a top-level matches/`A, B` list with per-branch filters expands into
// one entry per branch so each can carry its own filter.
export function decomposeSimple(selector: string): FastDispatchInfo[] | null {
	let ast: unknown;
	try {
		ast = esquery.parse(selector);
	} catch {
		return null;
	}
	return walkSelector(ast as any, false);
}

// Top-level selector entry. Handles combinators / attribute compounds.
function walkSelector(ast: any, isExit: boolean): FastDispatchInfo[] | null {
	switch (ast.type) {
		case 'child': {
			const info = walkChild(ast.left, ast.right, isExit);
			return info ? [info] : null;
		}
		case 'descendant': {
			const info = walkDescendant(ast.left, ast.right, isExit);
			return info ? [info] : null;
		}
		case 'matches': {
			// Top-level `A, B` — each branch gets its own dispatch entry so
			// branch-specific filters stay scoped to their own types.
			const out: FastDispatchInfo[] = [];
			for (const sub of ast.selectors) {
				const inner = walkSelector(sub, isExit);
				if (!inner) return null;
				out.push(...inner);
			}
			return out;
		}
		default: {
			const info = walkTypeMatcher(ast, isExit);
			return info ? [info] : null;
		}
	}
}

// Right-hand of `Parent > X` or `Parent X`. Returns the trigger type set
// + optional structural extraction (fieldFire / typeFilter / additional filter).
// Returns null if the right side is a shape we can't fast-dispatch.
function walkChild(left: any, right: any, isExit: boolean): FastDispatchInfo | null {
	// `Parent > .field` — bare field selector, no type constraint on the
	// child. Equivalent to `Parent > *.field` for our purposes.
	if (right.type === 'field') {
		const parentInfo = walkTypeMatcher(left, isExit);
		if (!parentInfo || parentInfo.types === 'all') return null;
		return {
			types: parentInfo.types,
			isExit,
			fieldFire: right.name,
		};
	}
	// `Parent > Right.field`  — compound on the right has wildcard or
	// identifier + a field selector. Trigger on Parent; dispatch reads
	// `target[field]`. Filter by Right.type if Right was an identifier.
	if (right.type === 'compound') {
		let fieldName: string | undefined;
		let typeFilter: string | undefined;
		let wildcard = false;
		let extraFilter: ((t: any) => boolean) | undefined;
		for (const sub of right.selectors) {
			if (sub.type === 'wildcard') {
				wildcard = true;
			} else if (sub.type === 'identifier') {
				typeFilter = sub.value;
			} else if (sub.type === 'field') {
				fieldName = sub.name;
			} else if (sub.type === 'attribute') {
				const attrFilter = makeAttributeFilter(sub);
				if (!attrFilter) return null;
				const prev = extraFilter;
				extraFilter = prev ? n => prev(n) && attrFilter(n) : attrFilter;
			} else if (sub.type === 'class' && String(sub.name).toLowerCase() === 'exit') {
				isExit = true;
			} else if (sub.type === 'not') {
				// `Foo > :not(Bar).field` — exclude target.type matching Bar.
				const inner = collectMatcher({ type: 'matches', selectors: sub.selectors });
				if (!inner) return null;
				const negFilter = (n: any) => !inner(n);
				const prev = extraFilter;
				extraFilter = prev ? n => prev(n) && negFilter(n) : negFilter;
				wildcard = wildcard || (typeFilter === undefined);
			} else {
				return null;
			}
		}
		if (fieldName) {
			// fieldFire path — trigger on Parent (left).
			const parentInfo = walkTypeMatcher(left, isExit);
			if (!parentInfo || parentInfo.types === 'all') return null;
			return {
				types: parentInfo.types,
				isExit,
				fieldFire: fieldName,
				typeFilter,
				filter: extraFilter,
			};
		}
		// No field: `Parent > Type[attr]` / `Parent > Type:exit`. Trigger
		// on Right type, filter parent.type === Parent.
		if (typeFilter || wildcard) {
			const types: Set<string> | 'all' = wildcard ? 'all' : new Set([typeFilter!]);
			const parentMatch = collectMatcher(left);
			if (!parentMatch) return null;
			const parentFilter = (n: any) => parentMatch(n.parent);
			return {
				types,
				isExit,
				filter: extraFilter ? n => parentFilter(n) && extraFilter!(n) : parentFilter,
			};
		}
		return null;
	}
	// `Parent > Right` plain identifier or wildcard
	if (right.type === 'identifier' || right.type === 'wildcard') {
		const types: Set<string> | 'all' = right.type === 'wildcard'
			? 'all'
			: new Set([right.value]);
		const parentMatch = collectMatcher(left);
		if (!parentMatch) return null;
		return {
			types,
			isExit,
			filter: n => parentMatch(n.parent),
		};
	}
	return null;
}

// `Parent Right` (descendant). Trigger on right type, walk ancestors
// at dispatch time looking for a Parent-typed node. Right side must be
// a plain type matcher (no nested combinators / matches).
function walkDescendant(left: any, right: any, isExit: boolean): FastDispatchInfo | null {
	const rightInfo = walkTypeMatcher(right, isExit);
	if (!rightInfo || rightInfo.types === 'all') return null;
	const ancestorMatch = collectMatcher(left);
	if (!ancestorMatch) return null;
	const ancestorFilter = (n: any) => {
		let cur = n.parent;
		while (cur) {
			if (ancestorMatch(cur)) return true;
			cur = cur.parent;
		}
		return false;
	};
	const prev = rightInfo.filter;
	rightInfo.filter = prev ? n => ancestorFilter(n) && prev(n) : ancestorFilter;
	return rightInfo;
}

// Compound of identifier(s) / wildcard / class(:exit) / attribute filters.
function walkTypeMatcher(ast: any, isExit: boolean): FastDispatchInfo | null {
	switch (ast.type) {
		case 'identifier':
			return { types: new Set([ast.value]), isExit };
		case 'wildcard':
			return { types: 'all', isExit };
		case 'class': {
			// Standalone class macro. `:function` expands to a fixed type
			// set; suffix-based macros become wildcard + filter.
			const name = String(ast.name).toLowerCase();
			if (name === 'function') {
				return { types: new Set(['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression']), isExit };
			}
			const m = classMacroMatcher(name);
			if (!m) return null;
			return { types: 'all', isExit, filter: m };
		}
		case 'not': {
			// `:not(X)` standalone — wildcard with negated inner matcher.
			const inner = collectMatcher({ type: 'matches', selectors: ast.selectors });
			if (!inner) return null;
			return { types: 'all', isExit, filter: n => !inner(n) };
		}
		case 'compound': {
			const collected = new Set<string>();
			let isAll = false;
			let sawType = false;
			let extraFilter: ((t: any) => boolean) | undefined;
			for (const sub of ast.selectors) {
				if (sub.type === 'identifier') {
					collected.add(sub.value);
					sawType = true;
				} else if (sub.type === 'wildcard') {
					isAll = true;
					sawType = true;
				} else if (sub.type === 'matches') {
					// Try as a type-contributing matches (union of identifier
					// branches). If that fails, every branch must be a
					// filter-only check (attribute or class macro), so
					// treat the whole `:matches(...)` as a per-target
					// filter via collectMatcher (OR-combines the branches).
					const inner = walkTypeMatcher(sub, isExit);
					if (inner) {
						if (inner.types === 'all') {
							isAll = true;
						} else {
							for (const t of inner.types) collected.add(t);
						}
						if (inner.filter) {
							const prev = extraFilter;
							const innerFilter = inner.filter;
							extraFilter = prev ? n => prev(n) && innerFilter(n) : innerFilter;
						}
						sawType = true;
					} else {
						const m = collectMatcher(sub);
						if (!m) return null;
						const prev = extraFilter;
						extraFilter = prev ? n => prev(n) && m(n) : m;
					}
				} else if (sub.type === 'class' && String(sub.name).toLowerCase() === 'exit') {
					isExit = true;
				} else if (sub.type === 'class') {
					// `:function` etc. inside compound. Same as standalone,
					// but composes with other constraints.
					const name = String(sub.name).toLowerCase();
					if (name === 'function') {
						const fnTypes = ['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression'];
						for (const t of fnTypes) collected.add(t);
						sawType = true;
					} else {
						const m = classMacroMatcher(name);
						if (!m) return null;
						isAll = true;
						sawType = true;
						const prev = extraFilter;
						extraFilter = prev ? n => prev(n) && m(n) : m;
					}
				} else if (sub.type === 'not') {
					// `Foo:not(Bar)` — types stay {Foo}, add filter inverting inner.
					const inner = collectMatcher({ type: 'matches', selectors: sub.selectors });
					if (!inner) return null;
					const negFilter = (n: any) => !inner(n);
					const prev = extraFilter;
					extraFilter = prev ? n => prev(n) && negFilter(n) : negFilter;
				} else if (sub.type === 'attribute') {
					const attrFilter = makeAttributeFilter(sub);
					if (!attrFilter) return null;
					const prev = extraFilter;
					extraFilter = prev ? n => prev(n) && attrFilter(n) : attrFilter;
				} else {
					return null;
				}
			}
			if (!sawType) return null;
			return { types: isAll ? 'all' : collected, isExit, filter: extraFilter };
		}
		case 'matches': {
			let types: Set<string> | null = null;
			let mergedExit: boolean | null = null;
			let extraFilter: ((t: any) => boolean) | undefined;
			for (const sub of ast.selectors) {
				const inner = walkTypeMatcher(sub, isExit);
				if (!inner || inner.types === 'all') return null;
				if (mergedExit === null) mergedExit = inner.isExit;
				else if (mergedExit !== inner.isExit) return null;
				types ??= new Set();
				for (const t of inner.types) types.add(t);
				if (inner.filter) {
					// Inside a `matches(...)`, each branch's filter applies only
					// to that branch's types — we can't represent per-branch
					// filters in the flat Set + filter shape, so bail.
					return null;
				}
			}
			if (!types) return null;
			return { types, isExit: mergedExit ?? isExit, filter: extraFilter };
		}
		default:
			return null;
	}
}

// A flexible matcher predicate. Used for the LEFT side of combinators
// (parent / ancestor constraints) and for inverting via `:not`. Returns
// null if the AST shape is something we can't reason about.
//
// Recognised shapes:
//   identifier   → n.type === value
//   wildcard     → always true
//   matches      → OR of inner matchers
//   not          → NOT of the OR-of-inners
//   compound     → AND of inner matchers (skipping :exit class)
//   attribute    → attribute predicate (reuses makeAttributeFilter)
//   class macros → :function / :statement / :expression /
//                  :declaration / :pattern (suffix-based)
type NodePredicate = (node: any) => boolean;
function collectMatcher(ast: any): NodePredicate | null {
	if (!ast) return null;
	switch (ast.type) {
		case 'identifier': {
			const v = ast.value;
			return n => !!n && n.type === v;
		}
		case 'wildcard':
			return _n => true;
		case 'matches': {
			const subs: NodePredicate[] = [];
			for (const sub of ast.selectors) {
				const m = collectMatcher(sub);
				if (!m) return null;
				subs.push(m);
			}
			return n => {
				for (let i = 0; i < subs.length; i++) if (subs[i](n)) return true;
				return false;
			};
		}
		case 'not': {
			const subs: NodePredicate[] = [];
			for (const sub of ast.selectors) {
				const m = collectMatcher(sub);
				if (!m) return null;
				subs.push(m);
			}
			return n => {
				if (!n) return false;
				for (let i = 0; i < subs.length; i++) if (subs[i](n)) return false;
				return true;
			};
		}
		case 'compound': {
			const subs: NodePredicate[] = [];
			for (const sub of ast.selectors) {
				if (sub.type === 'class' && String(sub.name).toLowerCase() === 'exit') continue;
				const m = collectMatcher(sub);
				if (!m) return null;
				subs.push(m);
			}
			if (subs.length === 0) return _n => true;
			return n => {
				if (!n) return false;
				for (let i = 0; i < subs.length; i++) if (!subs[i](n)) return false;
				return true;
			};
		}
		case 'attribute': {
			const f = makeAttributeFilter(ast);
			return f;
		}
		case 'class':
			return classMacroMatcher(String(ast.name).toLowerCase());
		case 'child': {
			// `Left > Right` — n matches when n matches Right AND n.parent
			// matches Left. Nested combinators bottom out here.
			const leftMatch = collectMatcher(ast.left);
			const rightMatch = collectMatcher(ast.right);
			if (!leftMatch || !rightMatch) return null;
			return n => !!n && rightMatch(n) && leftMatch(n.parent);
		}
		case 'descendant': {
			// `Left Right` — n matches Right AND some ancestor matches Left.
			const leftMatch = collectMatcher(ast.left);
			const rightMatch = collectMatcher(ast.right);
			if (!leftMatch || !rightMatch) return null;
			return n => {
				if (!n || !rightMatch(n)) return false;
				let cur = n.parent;
				while (cur) {
					if (leftMatch(cur)) return true;
					cur = cur.parent;
				}
				return false;
			};
		}
		case 'field': {
			// `.field` standalone in a compound, e.g. `Identifier.label`
			// means "n is at parent[label]". The matcher needs reference
			// equality with parent[field].
			const fieldName = ast.name;
			return n => !!n && !!n.parent && n.parent[fieldName] === n;
		}
		default:
			return null;
	}
}

// esquery's class macros (esquery.lite.js:3375). Suffix-based on node.type
// (statement / declaration / pattern / expression) plus a hardcoded
// expansion for `:function`. Mirrors handleClass() in trigger-set
// analysis but returns a per-node predicate so it can compose with
// other matchers (e.g. as a `:not(:function)` filter).
function classMacroMatcher(name: string): NodePredicate | null {
	switch (name) {
		case 'function':
			return n => n != null
				&& (n.type === 'FunctionDeclaration'
					|| n.type === 'FunctionExpression'
					|| n.type === 'ArrowFunctionExpression');
		case 'statement':
			return n => {
				if (!n) return false;
				const t = n.type as string;
				return t.endsWith('Statement') || t.endsWith('Declaration');
			};
		case 'declaration':
			return n => !!n && (n.type as string).endsWith('Declaration');
		case 'pattern':
			return n => {
				if (!n) return false;
				const t = n.type as string;
				return t.endsWith('Pattern')
					|| t.endsWith('Expression')
					|| t.endsWith('Literal')
					|| t === 'Identifier'
					|| t === 'MetaProperty';
			};
		case 'expression':
			return n => {
				if (!n) return false;
				const t = n.type as string;
				return t.endsWith('Expression')
					|| t.endsWith('Literal')
					|| t === 'Identifier'
					|| t === 'MetaProperty';
			};
		default:
			return null;
	}
}

// Build a predicate from an esquery attribute selector AST.
// Supports: name(.path), op (=, !=), value (literal/regexp/type).
function makeAttributeFilter(attr: any): ((target: any) => boolean) | null {
	const path = String(attr.name).split('.');
	const get = (target: any) => {
		let cur = target;
		for (const seg of path) {
			if (cur == null) return undefined;
			cur = cur[seg];
		}
		return cur;
	};
	const op = attr.operator;
	if (!op) {
		// `[attr]` — exists & truthy
		return target => {
			const v = get(target);
			return v != null && v !== false;
		};
	}
	const want = attr.value;
	if (want?.type === 'regexp') {
		const re = want.value;
		return target => {
			const v = get(target);
			return typeof v === 'string' && re.test(v);
		};
	}
	const literal = want?.type === 'literal' ? want.value : undefined;
	const wantType = want?.type === 'type' ? want.value : undefined; // unused: rare
	if (literal === undefined && wantType === undefined) return null;
	switch (op) {
		case '=':
			return target => get(target) === literal;
		case '!=':
			return target => get(target) !== literal;
		default:
			return null;
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
