// Selector → fast-dispatch decomposition.
//
// Each rule listener registers an esquery selector. `decomposeSimple`
// turns that into a tuple (typeSet, fieldFire?, typeFilter?, filter?)
// the dispatcher can match against per-visited-node without walking the
// selector AST again. When a selector shape isn't yet decomposable, we
// throw `UnsupportedSelectorError` rather than silently fall back —
// gaps surface immediately as a coverage signal.
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

// Vendored visitor-keys table (`./visitor-keys`) — used by sibling /
// `:nth-child` / `:has` filters at dispatch time to walk a node's
// children without hard-coding keys per type.
import { visitorKeys as _visitorKeys } from './visitor-keys';
function visitorKeysFor(type: string): readonly string[] | null {
	return _visitorKeys[type] ?? null;
}

// Iterate every direct child node (or array element) under `node`. Used
// by `:has(X)` (DFS) and structural filters that need the full child
// list, not just specific named slots. When visitor-keys has no entry
// for the type, fall back to enumerating own enumerable properties —
// this safely covers GenericTSNode (synthetic, no lazy children to miss)
// and plain test fixtures with arbitrary types. LazyNodes always have a
// visitor-keys entry, so the fallback never fires for them; if it did,
// `Object.keys` couldn't see their lazy getters anyway.
function* iterChildNodes(node: any): IterableIterator<any> {
	const keys = visitorKeysFor(node.type) ?? Object.keys(node);
	for (const key of keys) {
		if (key === 'parent' || key === 'type') continue;
		const child = node[key];
		if (Array.isArray(child)) {
			for (let i = 0; i < child.length; i++) {
				const c = child[i];
				if (c && typeof c === 'object' && typeof (c as { type?: unknown }).type === 'string') {
					yield c;
				}
			}
		} else if (child && typeof child === 'object' && typeof (child as { type?: unknown }).type === 'string') {
			yield child;
		}
	}
}

// Find the array on `node.parent` that contains `node`, plus its index.
// Returns null if the node sits in a non-array slot (e.g. parent.test
// rather than parent.body[]) — `:nth-child` / sibling combinators only
// have meaning inside an array slot. Same visitor-keys-with-fallback
// policy as iterChildNodes.
function locateInArraySlot(node: any): { siblings: any[]; index: number } | null {
	const parent = node.parent;
	if (!parent) return null;
	const keys = visitorKeysFor(parent.type) ?? Object.keys(parent);
	for (let i = 0; i < keys.length; i++) {
		if (keys[i] === 'parent' || keys[i] === 'type') continue;
		const child = parent[keys[i]];
		if (Array.isArray(child)) {
			const idx = child.indexOf(node);
			if (idx >= 0) return { siblings: child, index: idx };
		}
	}
	return null;
}

// True when any descendant of `node` matches `inner`. DFS pre-order; bails
// on first hit. Used by `:has(X)` filter.
function hasDescendantMatching(node: any, inner: NodePredicate): boolean {
	for (const child of iterChildNodes(node)) {
		if (inner(child)) return true;
		if (hasDescendantMatching(child, inner)) return true;
	}
	return false;
}

// True when `node` is the `nth` element (1-indexed) of whichever array
// slot it occupies on its parent. `fromEnd` flips the count to start
// from the last sibling — used by `:nth-last-child` / `:last-child`.
function isNthChild(node: any, n: number, fromEnd: boolean): boolean {
	const loc = locateInArraySlot(node);
	if (!loc) return false;
	return fromEnd
		? loc.index === loc.siblings.length - n
		: loc.index === n - 1;
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

// Thrown when a selector parses as valid esquery syntax but its shape
// isn't yet covered by the fast-dispatch decomposer. Distinct from a
// raw parse error so callers can tell the difference between user
// typos and our coverage gaps.
export class UnsupportedSelectorError extends Error {
	constructor(public readonly selector: string, reason?: string) {
		super(`compat-eslint fast dispatch can't decompose selector \`${selector}\`${reason ? `: ${reason}` : ''}. This is a coverage gap in selector-analysis.ts; please open an issue with the selector + the rule that registered it.`);
		this.name = 'UnsupportedSelectorError';
	}
}

// `decomposeSimple` returns an array of dispatch infos. A single
// identifier / compound / child selector typically yields one entry, but
// a top-level matches/`A, B` list with per-branch filters expands into
// one entry per branch so each can carry its own filter.
//
// Throws on:
//   - esquery parse error (syntactically invalid selector — user bug)
//   - any selector shape we don't yet decompose (UnsupportedSelectorError
//     — coverage gap; see callers of the helper). The caller (e.g.
//     tryBuildFastDispatch) MUST propagate, never silently swallow —
//     fallback to NodeEventGenerator was retired.
export function decomposeSimple(selector: string): FastDispatchInfo[] {
	let ast: unknown;
	try {
		ast = esquery.parse(selector);
	} catch (e) {
		throw new Error(`Invalid esquery selector \`${selector}\`: ${(e as Error).message}`);
	}
	const infos = walkSelector(ast as any, false);
	if (!infos) throw new UnsupportedSelectorError(selector);
	return infos;
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
		case 'sibling':
		case 'adjacent': {
			const info = walkSibling(ast.left, ast.right, isExit, ast.type === 'adjacent');
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

// `Left ~ Right` (sibling, any earlier) and `Left + Right` (adjacent
// previous). Trigger on Right type (or `all` when right is wildcard);
// filter checks earlier siblings in whichever array slot the node
// occupies on its parent.
function walkSibling(left: any, right: any, isExit: boolean, adjacent: boolean): FastDispatchInfo | null {
	const rightInfo = walkTypeMatcher(right, isExit);
	if (!rightInfo) return null;
	const leftMatch = collectMatcher(left);
	if (!leftMatch) return null;
	const filter = adjacent
		? (n: any) => {
			const loc = locateInArraySlot(n);
			if (!loc || loc.index === 0) return false;
			return leftMatch(loc.siblings[loc.index - 1]);
		}
		: (n: any) => {
			const loc = locateInArraySlot(n);
			if (!loc) return false;
			for (let i = 0; i < loc.index; i++) {
				if (leftMatch(loc.siblings[i])) return true;
			}
			return false;
		};
	const prev = rightInfo.filter;
	rightInfo.filter = prev ? n => filter(n) && prev(n) : filter;
	return rightInfo;
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
		const addFilter = (f: NodePredicate) => {
			const prev = extraFilter;
			extraFilter = prev ? n => prev(n) && f(n) : f;
		};
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
				addFilter(attrFilter);
			} else if (sub.type === 'class' && String(sub.name).toLowerCase() === 'exit') {
				isExit = true;
			} else if (sub.type === 'class' && String(sub.name).toLowerCase() === 'scope') {
				// no-op
			} else if (sub.type === 'class') {
				const m = classMacroMatcher(String(sub.name).toLowerCase());
				if (!m) return null;
				wildcard = wildcard || typeFilter === undefined;
				addFilter(m);
			} else if (sub.type === 'not') {
				const inner = collectMatcher({ type: 'matches', selectors: sub.selectors });
				if (!inner) return null;
				addFilter(n => !inner(n));
				wildcard = wildcard || typeFilter === undefined;
			} else if (sub.type === 'has') {
				const m = collectMatcher(sub);
				if (!m) return null;
				addFilter(m);
			} else if (sub.type === 'nth-child' || sub.type === 'nth-last-child') {
				const idx = sub.index?.value;
				if (typeof idx !== 'number') return null;
				const fromEnd = sub.type === 'nth-last-child';
				addFilter(n => isNthChild(n, idx, fromEnd));
			} else if (sub.type === 'matches') {
				// Inside `Parent > :matches(...)`, branches contribute either
				// types (collapse into typeFilter — first one wins, others
				// added as filter) or attribute-style filters.
				const m = collectMatcher(sub);
				if (!m) return null;
				addFilter(m);
			} else {
				return null;
			}
		}
		if (fieldName) {
			// fieldFire path — trigger on Parent (left).
			const parentInfo = walkTypeMatcher(left, isExit);
			if (!parentInfo || parentInfo.types === 'all') return null;
			// Parent-side filters (e.g. `[optional=true]`) check the
			// triggering node, but `filter` runs on the post-fieldFire
			// `actual` — wrap them as `actual.parent` checks.
			const parentSideFilter = parentInfo.filter;
			const composed = parentSideFilter && extraFilter
				? (actual: any) => parentSideFilter(actual.parent) && extraFilter!(actual)
				: parentSideFilter
					? (actual: any) => parentSideFilter(actual.parent)
					: extraFilter;
			return {
				types: parentInfo.types,
				isExit,
				fieldFire: fieldName,
				typeFilter,
				filter: composed,
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
	// Fallback: any other selector kind on the right (`:not`, `:has`,
	// `:nth-child`, `:function`, etc.) — let walkTypeMatcher decompose
	// it as a standalone, then compose parent-of-target via collectMatcher.
	const rightInfo = walkTypeMatcher(right, isExit);
	if (!rightInfo) return null;
	const parentMatch = collectMatcher(left);
	if (!parentMatch) return null;
	const parentFilter = (n: any) => parentMatch(n.parent);
	const prev = rightInfo.filter;
	rightInfo.filter = prev ? n => parentFilter(n) && prev(n) : parentFilter;
	return rightInfo;
}

// `Parent Right` (descendant). Trigger on right type (or `all` when
// right is wildcard / class macro), walk ancestors at dispatch time
// looking for a Parent-typed node.
function walkDescendant(left: any, right: any, isExit: boolean): FastDispatchInfo | null {
	const rightInfo = walkTypeMatcher(right, isExit);
	if (!rightInfo) return null;
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
			if (name === 'scope') {
				// `:scope` only carries meaning inside `:has(...)`; standalone
				// it matches every node.
				return { types: 'all', isExit };
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
		case 'has': {
			// `:has(X)` standalone — wildcard, fires when the node has at
			// least one descendant matching X. Delegate to collectMatcher
			// so the inner properly binds `:scope` to the dispatched node.
			const m = collectMatcher(ast);
			if (!m) return null;
			return { types: 'all', isExit, filter: m };
		}
		case 'nth-child':
		case 'nth-last-child': {
			const idx = ast.index?.value;
			if (typeof idx !== 'number') return null;
			const fromEnd = ast.type === 'nth-last-child';
			return {
				types: 'all',
				isExit,
				filter: n => isNthChild(n, idx, fromEnd),
			};
		}
		case 'attribute': {
			// Standalone `[attr=val]` — wildcard with attribute filter.
			const f = makeAttributeFilter(ast);
			if (!f) return null;
			return { types: 'all', isExit, filter: f };
		}
		case 'field': {
			// Standalone `.field` — wildcard, fires when the node
			// occupies the named field slot on its parent.
			const fieldName = ast.name as string;
			return {
				types: 'all',
				isExit,
				filter: n => !!n.parent && n.parent[fieldName] === n,
			};
		}
		case 'sibling':
		case 'adjacent':
		case 'child':
		case 'descendant': {
			// Combinator nested inside a context that wants a type
			// matcher (e.g. inside `:has(...)` or `:matches(...)`).
			// Walk via collectMatcher to get a runtime predicate.
			const m = collectMatcher(ast);
			if (!m) return null;
			return { types: 'all', isExit, filter: m };
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
					const inner = walkTypeMatcher(sub, isExit);
					if (!inner) return null;
					if (inner.types === 'all') {
						// Filter-only matches (e.g. `:matches([a=1], [b=2])`)
						// — the outer compound's identifier supplies the
						// type. Don't promote the compound to wildcard;
						// just add this matches as an extra OR filter.
						if (inner.filter) {
							const prev = extraFilter;
							const innerFilter = inner.filter;
							extraFilter = prev ? n => prev(n) && innerFilter(n) : innerFilter;
						}
					} else {
						for (const t of inner.types) collected.add(t);
						if (inner.filter) {
							const prev = extraFilter;
							const innerFilter = inner.filter;
							extraFilter = prev ? n => prev(n) && innerFilter(n) : innerFilter;
						}
						sawType = true;
					}
				} else if (sub.type === 'class' && String(sub.name).toLowerCase() === 'exit') {
					isExit = true;
				} else if (sub.type === 'class' && String(sub.name).toLowerCase() === 'scope') {
					// `:scope` is a no-op identity marker outside `:has(...)`.
					// Carry on without contributing types or filters.
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
				} else if (sub.type === 'has') {
					// `Foo:has(Bar)` — types stay {Foo}, add :has filter
					// (delegates to collectMatcher so `:scope` binds
					// correctly to the dispatched node).
					const m = collectMatcher(sub);
					if (!m) return null;
					const prev = extraFilter;
					extraFilter = prev ? n => prev(n) && m(n) : m;
				} else if (sub.type === 'nth-child' || sub.type === 'nth-last-child') {
					const idx = sub.index?.value;
					if (typeof idx !== 'number') return null;
					const fromEnd = sub.type === 'nth-last-child';
					const f = (n: any) => isNthChild(n, idx, fromEnd);
					const prev = extraFilter;
					extraFilter = prev ? n => prev(n) && f(n) : f;
				} else if (sub.type === 'attribute') {
					const attrFilter = makeAttributeFilter(sub);
					if (!attrFilter) return null;
					const prev = extraFilter;
					extraFilter = prev ? n => prev(n) && attrFilter(n) : attrFilter;
				} else if (sub.type === 'field') {
					// `Foo.field` — node is at parent[field]. Reference equality.
					const fieldName = sub.name as string;
					const f = (n: any) => !!n.parent && n.parent[fieldName] === n;
					const prev = extraFilter;
					extraFilter = prev ? n => prev(n) && f(n) : f;
				} else if (sub.type === 'sibling' || sub.type === 'adjacent'
					|| sub.type === 'child' || sub.type === 'descendant') {
					// Nested combinator inside a compound — fall back to
					// collectMatcher's full evaluation as a per-target filter.
					const m = collectMatcher(sub);
					if (!m) return null;
					const prev = extraFilter;
					extraFilter = prev ? n => prev(n) && m(n) : m;
				} else {
					return null;
				}
			}
			if (!sawType) return null;
			return { types: isAll ? 'all' : collected, isExit, filter: extraFilter };
		}
		case 'matches': {
			// Each branch contributes a (typeMatcher, optional filter) pair.
			// At runtime, target matches if ANY branch's typeMatcher fires
			// AND that branch's filter (if any) passes. The advertised
			// `types` is the union (or 'all' if any branch is unbounded).
			interface Branch { types: Set<string> | 'all'; filter?: NodePredicate; }
			const branches: Branch[] = [];
			let mergedExit: boolean | null = null;
			let anyAll = false;
			for (const sub of ast.selectors) {
				const inner = walkTypeMatcher(sub, isExit);
				if (!inner) return null;
				if (mergedExit === null) mergedExit = inner.isExit;
				else if (mergedExit !== inner.isExit) return null;
				if (inner.types === 'all') anyAll = true;
				branches.push({ types: inner.types, filter: inner.filter });
			}
			if (branches.length === 0) return null;
			let types: Set<string> | 'all';
			if (anyAll) {
				types = 'all';
			} else {
				const merged = new Set<string>();
				for (const b of branches) {
					if (b.types !== 'all') for (const t of b.types) merged.add(t);
				}
				types = merged;
			}
			// Combined filter: OR across branches; each branch checks its
			// own type set first then its own filter.
			const combined: NodePredicate = n => {
				for (let i = 0; i < branches.length; i++) {
					const b = branches[i];
					if (b.types !== 'all' && !b.types.has(n.type)) continue;
					if (b.filter && !b.filter(n)) continue;
					return true;
				}
				return false;
			};
			return { types, isExit: mergedExit ?? isExit, filter: combined };
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
// `scopeRef` is a per-`:has` evaluation cell. `:has(:scope > X)` binds
// `:scope` to the node currently being tested by the outer `:has`. The
// outer `:has` swaps `scopeRef.value` to the test root before evaluating
// its inner matcher; nested `:has` get their own cell.
type ScopeRef = { value: any };
function collectMatcher(ast: any, scope?: ScopeRef): NodePredicate | null {
	if (!ast) return null;
	switch (ast.type) {
		case 'identifier': {
			const v = ast.value;
			return n => !!n && n.type === v;
		}
		case 'wildcard':
			return n => !!n;
		case 'matches': {
			const subs: NodePredicate[] = [];
			for (const sub of ast.selectors) {
				const m = collectMatcher(sub, scope);
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
				const m = collectMatcher(sub, scope);
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
				const m = collectMatcher(sub, scope);
				if (!m) return null;
				subs.push(m);
			}
			if (subs.length === 0) return n => !!n;
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
		case 'class': {
			const name = String(ast.name).toLowerCase();
			if (name === 'scope') {
				// Inside `:has(...)` the scope cell points at the node being
				// tested; outside it acts like wildcard (matches anything).
				return scope ? n => n === scope.value : n => !!n;
			}
			return classMacroMatcher(name);
		}
		case 'child': {
			// `Left > Right` — n matches when n matches Right AND n.parent
			// matches Left. Nested combinators bottom out here.
			const leftMatch = collectMatcher(ast.left, scope);
			const rightMatch = collectMatcher(ast.right, scope);
			if (!leftMatch || !rightMatch) return null;
			return n => !!n && rightMatch(n) && leftMatch(n.parent);
		}
		case 'descendant': {
			// `Left Right` — n matches Right AND some ancestor matches Left.
			const leftMatch = collectMatcher(ast.left, scope);
			const rightMatch = collectMatcher(ast.right, scope);
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
		case 'has': {
			// Each `:has(...)` gets its own scope cell so the inner
			// selector's `:scope` references resolve to the node currently
			// being tested by THIS has, not an enclosing one.
			const innerScope: ScopeRef = { value: null };
			const inner = collectMatcher({ type: 'matches', selectors: ast.selectors }, innerScope);
			if (!inner) return null;
			return n => {
				if (!n) return false;
				const prev = innerScope.value;
				innerScope.value = n;
				const ok = hasDescendantMatching(n, inner);
				innerScope.value = prev;
				return ok;
			};
		}
		case 'nth-child':
		case 'nth-last-child': {
			const idx = ast.index?.value;
			if (typeof idx !== 'number') return null;
			const fromEnd = ast.type === 'nth-last-child';
			return n => !!n && isNthChild(n, idx, fromEnd);
		}
		case 'sibling': {
			const leftMatch = collectMatcher(ast.left, scope);
			const rightMatch = collectMatcher(ast.right, scope);
			if (!leftMatch || !rightMatch) return null;
			return n => {
				if (!n || !rightMatch(n)) return false;
				const loc = locateInArraySlot(n);
				if (!loc) return false;
				for (let i = 0; i < loc.index; i++) {
					if (leftMatch(loc.siblings[i])) return true;
				}
				return false;
			};
		}
		case 'adjacent': {
			const leftMatch = collectMatcher(ast.left, scope);
			const rightMatch = collectMatcher(ast.right, scope);
			if (!leftMatch || !rightMatch) return null;
			return n => {
				if (!n || !rightMatch(n)) return false;
				const loc = locateInArraySlot(n);
				if (!loc || loc.index === 0) return false;
				return leftMatch(loc.siblings[loc.index - 1]);
			};
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
// Mirrors every combination esquery itself supports (see
// esquery.esm.js:3981 onwards):
//   - `[name]` (no operator): truthy-existence check
//   - `[name=value]` / `[name!=value]`:
//       * literal — stringify both sides and compare (loose-string)
//       * /regex/ — regex.test on the stringified attribute
//       * type(name) — typeof check
//   - `[name<v]` / `[name<=v]` / `[name>v]` / `[name>=v]`:
//       * numeric — coerce both sides to Number, compare
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
	// Regex: applies to `=` and `!=` only.
	if (want?.type === 'regexp') {
		const re = want.value as RegExp;
		switch (op) {
			case '=':
				return target => {
					const v = get(target);
					return typeof v === 'string' && re.test(v);
				};
			case '!=':
				return target => {
					const v = get(target);
					return !(typeof v === 'string' && re.test(v));
				};
			default:
				return null;
		}
	}
	// Type-of: esquery's `[attr=type(string)]` form (esquery.esm.js:4004).
	if (want?.type === 'type') {
		const wantType = want.value as string;
		switch (op) {
			case '=':
				return target => typeof get(target) === wantType;
			case '!=':
				return target => typeof get(target) !== wantType;
			default:
				return null;
		}
	}
	// Literal value: numeric / string / null / boolean. esquery parses
	// numbers as JS numbers and bare words as strings; we delegate to
	// the operator's natural coercion.
	if (want?.type !== 'literal') return null;
	const literal = want.value;
	switch (op) {
		case '=':
			// Stringify both sides — esquery has no boolean grammar, so
			// `[optional=true]` is "true" matched against String(node.optional).
			return target => `${get(target)}` === `${literal}`;
		case '!=':
			return target => `${get(target)}` !== `${literal}`;
		case '<':
			return target => Number(get(target)) < Number(literal);
		case '<=':
			return target => Number(get(target)) <= Number(literal);
		case '>':
			return target => Number(get(target)) > Number(literal);
		case '>=':
			return target => Number(get(target)) >= Number(literal);
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

