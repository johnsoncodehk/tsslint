// TS-backed reimplementation of @typescript-eslint/scope-manager's surface.
//
// Approach: walk the TS AST once at construction time, build a scope tree that
// matches @typescript-eslint/scope-manager's shape (so ESLint rules see the
// same structure they would from the upstream analyzer). Variables and refs
// are populated lazily per scope. The TS type checker is queried lazily for
// reference resolution.
//
// Scope kind dispatch is keyed off TS SyntaxKind directly — not `node.locals`,
// which only contains a subset of ES bindings (var hoisting + let/const) and
// would miss block-scopes-without-decls that ESLint expects.

import type { TSESTree } from '@typescript-eslint/types';
import ts = require('typescript');

type AstMaps = {
	esTreeNodeToTSNodeMap: WeakMap<TSESTree.Node, ts.Node>;
	tsNodeToESTreeNodeMap: WeakMap<ts.Node, TSESTree.Node>;
};

// Lib globals that upstream's `analyze({ lib: ['esnext'] })` exposes as values
// (i.e. `isValueVariable === true`) after resolving the lib chain. Most lib
// names are type-only because later libs (e.g. `esnext.collection`) override
// es5/es2015's TYPE_VALUE entries with TYPE. Captured empirically from a
// minimal analyze() run; refresh if upstream's lib data changes.
const LIB_VALUE_GLOBALS = new Set([
	'AggregateError',
	'AsyncDisposableStack',
	'BigInt',
	'Boolean',
	'DisposableStack',
	'EvalError',
	'FinalizationRegistry',
	'Float16Array',
	'Intl',
	'Iterator',
	'Object',
	'RangeError',
	'ReferenceError',
	'Reflect',
	'SuppressedError',
	'SyntaxError',
	'Temporal',
	'TypeError',
	'URIError',
	'WeakRef',
]);

// Scope kinds we tag. Names match upstream casing (e.g. 'tsEnum', 'tsModule').
type ScopeType =
	| 'global'
	| 'module'
	| 'function'
	| 'block'
	| 'switch'
	| 'for'
	| 'catch'
	| 'with'
	| 'class'
	| 'function-expression-name'
	| 'tsEnum'
	| 'tsModule'
	| 'type'
	| 'function-type'
	| 'mapped-type'
	| 'conditional-type';

type DefinitionType =
	| 'CatchClause'
	| 'ClassName'
	| 'FunctionName'
	| 'ImplicitGlobalVariable'
	| 'ImportBinding'
	| 'Parameter'
	| 'TDZ'
	| 'Variable'
	| 'Type'
	| 'TSEnumName'
	| 'TSEnumMember'
	| 'TSModuleName';

export class TsScopeManager {
	scopes: TsScope[] = [];
	globalScope!: TsScope;
	moduleScope: TsScope | null = null;
	declaredVariables = new WeakMap<TSESTree.Node, TsVariable[]>();
	nodeToScope = new Map<ts.Node, TsScope[]>();
	currentScope: TsScope | null = null;

	_variableBySymbol = new Map<ts.Symbol, TsVariable>();
	_libVariableBySymbol = new Map<ts.Symbol, TsVariable>();
	_libDecisionBySymbol = new Map<ts.Symbol, 0 | 1>();
	_syntheticArguments = new Map<TsScope, TsVariable>();
	readonly checker: ts.TypeChecker;

	constructor(
		readonly tsFile: ts.SourceFile,
		readonly program: ts.Program,
		readonly estree: TSESTree.Program,
		readonly astMaps: AstMaps,
		readonly sourceType: 'module' | 'script',
	) {
		this.checker = program.getTypeChecker();
		// Build scope tree by walking the TS AST.
		this._buildScopeTree();
	}

	// Identifiers picked up during the scope-tree walk; classified once after
	// scope variables are populated (so we know which symbols are "ours").
	_pendingIdentifiers: ts.Identifier[] = [];

	_buildScopeTree() {
		this.globalScope = new TsScope(this, this.tsFile, 'global', null);
		this._registerScope(this.tsFile, this.globalScope);

		let topScope: TsScope = this.globalScope;
		if (this.sourceType === 'module') {
			this.moduleScope = new TsScope(this, this.tsFile, 'module', this.globalScope);
			this._registerScope(this.tsFile, this.moduleScope);
			topScope = this.moduleScope;
		}
		this.currentScope = topScope;

		// Single AST walk: build scope tree + collect identifiers for later
		// classification. We thread `currentParent` through a stack-style
		// save/restore around the recursion so `forEachChild` can take a single
		// stable callback (no per-call arrow allocation).
		const SK_Identifier = ts.SyntaxKind.Identifier;
		const idents = this._pendingIdentifiers;
		let currentParent: TsScope = topScope;
		const walk = (n: ts.Node) => {
			const prevParent = currentParent;
			const created = this._createScopesFor(n, prevParent);
			if (created) currentParent = created;
			if (n.kind === SK_Identifier) idents.push(n as ts.Identifier);
			ts.forEachChild(n, walk);
			currentParent = prevParent;
		};
		ts.forEachChild(this.tsFile, walk);

		// Eagerly populate every scope's variables — this fills
		// `_variableBySymbol` so reference resolution can distinguish symbols
		// declared in this file (resolved) from cross-file globals (unresolved
		// → no-undef material in `globalScope.through`).
		for (const s of this.scopes) {
			void s.variables;
		}
	}

	_registerScope(tsNode: ts.Node, scope: TsScope) {
		this.scopes.push(scope);
		let arr = this.nodeToScope.get(tsNode);
		if (!arr) {
			this.nodeToScope.set(tsNode, arr = []);
		}
		arr.push(scope);
	}

	// For nodes that are themselves scope-creating, build the appropriate scope
	// (or pair of scopes, for named function expressions). Returns the innermost
	// scope created, so its descendants live in it.
	_createScopesFor(n: ts.Node, parent: TsScope): TsScope | undefined {
		const SK = ts.SyntaxKind;
		switch (n.kind) {
			case SK.FunctionDeclaration:
			case SK.ArrowFunction:
			case SK.MethodDeclaration:
			case SK.Constructor:
			case SK.GetAccessor:
			case SK.SetAccessor:
				return new TsScope(this, n, 'function', parent, true);
			case SK.FunctionExpression: {
				// Named function expressions get a wrapping
				// `function-expression-name` scope; inner function scope is its
				// child.
				const name = (n as ts.FunctionExpression).name;
				const outer = name
					? new TsScope(this, n, 'function-expression-name', parent, true)
					: parent;
				return new TsScope(this, n, 'function', outer, true);
			}
			case SK.ClassDeclaration:
			case SK.ClassExpression:
				return new TsScope(this, n, 'class', parent, true);
			case SK.Block: {
				// Block as a function/method body is NOT its own scope; the
				// function scope already covers it. Free-standing blocks are.
				const pk = n.parent?.kind;
				if (
					pk === SK.FunctionDeclaration
					|| pk === SK.FunctionExpression
					|| pk === SK.ArrowFunction
					|| pk === SK.MethodDeclaration
					|| pk === SK.Constructor
					|| pk === SK.GetAccessor
					|| pk === SK.SetAccessor
				) return undefined;
				return new TsScope(this, n, 'block', parent, true);
			}
			case SK.ForStatement:
			case SK.ForInStatement:
			case SK.ForOfStatement: {
				// Upstream nests a 'for' scope only when the init clause is a
				// let/const declaration (block-scoped binding). For
				// `for (a in xs)` or `for (var x = …)` the loop binding lives
				// in the enclosing scope.
				const init = n.kind === SK.ForStatement
					? (n as ts.ForStatement).initializer
					: (n as ts.ForInStatement | ts.ForOfStatement).initializer;
				if (
					init
					&& init.kind === SK.VariableDeclarationList
					&& ((init as ts.VariableDeclarationList).flags
						& (ts.NodeFlags.Let | ts.NodeFlags.Const)) !== 0
				) {
					return new TsScope(this, n, 'for', parent, true);
				}
				return undefined;
			}
			case SK.CatchClause:
				return new TsScope(this, n, 'catch', parent, true);
			case SK.SwitchStatement:
				return new TsScope(this, n, 'switch', parent, true);
			case SK.WithStatement:
				return new TsScope(this, n, 'with', parent, true);
			case SK.EnumDeclaration:
				return new TsScope(this, n, 'tsEnum', parent, true);
			case SK.ModuleDeclaration:
				return new TsScope(this, n, 'tsModule', parent, true);
			case SK.InterfaceDeclaration:
			case SK.TypeAliasDeclaration:
				// Upstream only creates a 'type' scope when type parameters are
				// present (since they need to be scoped to this declaration).
				return (n as { typeParameters?: ts.NodeArray<ts.TypeParameterDeclaration> }).typeParameters
					? new TsScope(this, n, 'type', parent, true)
					: undefined;
			case SK.MappedType:
				return new TsScope(this, n, 'mapped-type', parent, true);
			case SK.ConditionalType:
				return new TsScope(this, n, 'conditional-type', parent, true);
			case SK.FunctionType:
			case SK.ConstructorType:
			case SK.CallSignature:
			case SK.ConstructSignature:
			case SK.MethodSignature:
				return new TsScope(this, n, 'function-type', parent, true);
			default:
				return undefined;
		}
	}

	_getOrCreateVariable(symbol: ts.Symbol): TsVariable {
		let v = this._variableBySymbol.get(symbol);
		if (!v) {
			v = new TsVariable(this, symbol);
			this._variableBySymbol.set(symbol, v);
		}
		return v;
	}

	_collectBinding(binding: ts.BindingName | undefined, out: TsVariable[]) {
		if (!binding) return;
		const ts_ = ts;
		if (ts_.isIdentifier(binding)) {
			const sym = this.checker.getSymbolAtLocation(binding);
			if (sym) out.push(this._getOrCreateVariable(sym));
			return;
		}
		if (ts_.isObjectBindingPattern(binding) || ts_.isArrayBindingPattern(binding)) {
			for (const el of binding.elements) {
				if (ts_.isOmittedExpression(el)) continue;
				this._collectBinding(el.name, out);
			}
		}
	}

	getDeclaredVariables(node: TSESTree.Node): TsVariable[] {
		const tsNode = this.astMaps.esTreeNodeToTSNodeMap.get(node);
		if (!tsNode) return [];
		const out: TsVariable[] = [];
		const collect = (decl: ts.Node | undefined) => {
			if (!decl) return;
			let sym: ts.Symbol | undefined = (decl as { symbol?: ts.Symbol }).symbol;
			if (!sym) {
				const nameNode = (decl as { name?: ts.Node }).name;
				if (nameNode) sym = this.checker.getSymbolAtLocation(nameNode);
			}
			if (sym) out.push(this._getOrCreateVariable(sym));
		};
		const ts_ = ts;
		if (ts_.isVariableStatement(tsNode)) {
			for (const d of tsNode.declarationList.declarations) collect(d);
		}
		else if (ts_.isVariableDeclarationList(tsNode)) {
			for (const d of tsNode.declarations) collect(d);
		}
		else if (
			ts_.isVariableDeclaration(tsNode)
			|| ts_.isParameter(tsNode)
			|| ts_.isFunctionDeclaration(tsNode)
			|| ts_.isFunctionExpression(tsNode)
			|| ts_.isArrowFunction(tsNode)
			|| ts_.isMethodDeclaration(tsNode)
			|| ts_.isClassDeclaration(tsNode)
			|| ts_.isClassExpression(tsNode)
			|| ts_.isImportSpecifier(tsNode)
			|| ts_.isImportClause(tsNode)
			|| ts_.isNamespaceImport(tsNode)
			|| ts_.isImportEqualsDeclaration(tsNode)
			|| ts_.isEnumDeclaration(tsNode)
			|| ts_.isModuleDeclaration(tsNode)
			|| ts_.isTypeAliasDeclaration(tsNode)
			|| ts_.isInterfaceDeclaration(tsNode)
			|| ts_.isCatchClause(tsNode)
		) {
			collect(tsNode);
		}
		// For function-like nodes, also return their parameters.
		if (
			ts_.isFunctionDeclaration(tsNode)
			|| ts_.isFunctionExpression(tsNode)
			|| ts_.isArrowFunction(tsNode)
			|| ts_.isMethodDeclaration(tsNode)
		) {
			const fn = tsNode as ts.FunctionLikeDeclaration;
			if (fn.parameters) {
				for (const p of fn.parameters) {
					this._collectBinding(p.name, out);
				}
			}
		}
		return out;
	}

	acquire(node: TSESTree.Node, inner = false): TsScope | null {
		const tsNode = this.astMaps.esTreeNodeToTSNodeMap.get(node);
		if (!tsNode) return null;
		const arr = this.nodeToScope.get(tsNode);
		if (!arr || arr.length === 0) return null;
		if (arr.length === 1) return arr[0];
		// Multiple scopes share this node (e.g. Program → [global, module] or
		// FunctionExpression → [fn-expr-name, function]).
		const predicate = (s: TsScope) => !(s.type === 'function' && s.functionExpressionScope);
		if (inner) {
			for (let i = arr.length - 1; i >= 0; --i) {
				if (predicate(arr[i])) return arr[i];
			}
			return null;
		}
		return arr.find(predicate) ?? null;
	}

	get variables(): TsVariable[] {
		const out: TsVariable[] = [];
		for (const s of this.scopes) out.push(...s.variables);
		return out;
	}

	isES6() { return true; }
	isGlobalReturn() { return false; }
	isImpliedStrict() { return this.sourceType === 'module'; }
	isModule() { return this.sourceType === 'module'; }
	isStrictModeSupported() { return true; }
	addGlobals(_names: string[]) { /* legacy noop */ }

	// Lazy: a single AST walk classifies every Identifier as either a known
	// reference (symbol declared in our scope tree) or an unresolved "through"
	// reference (escapes the file). Both indexes share the walk.
	_through?: TsReference[];
	_refIndex?: Map<ts.Symbol, TsReference[]>;
	_referencesByScope?: Map<TsScope, TsReference[]>;
	_ensureRefIndex(): Map<ts.Symbol, TsReference[]> {
		if (this._refIndex) return this._refIndex;
		const refs = new Map<ts.Symbol, TsReference[]>();
		const through: TsReference[] = [];
		const byScope = new Map<TsScope, TsReference[]>();
		const recordScope = (ref: TsReference) => {
			const s = ref.from;
			let arr = byScope.get(s);
			if (!arr) byScope.set(s, arr = []);
			arr.push(ref);
		};
		const checker = this.checker;
		const SK = ts.SyntaxKind;
		const variableBySymbol = this._variableBySymbol;
		// Iterate identifiers gathered during the scope-tree walk — no second
		// AST traversal.
		const idents = this._pendingIdentifiers;
		for (let i = 0; i < idents.length; i++) {
			const node = idents[i];
			// Cheap filter first: many identifiers (property names, label
			// targets, decl names) are neither reference-eligible nor free —
			// skip them before triggering the (expensive) symbol resolver.
			const refUsage = this._isReferenceableUsage(node);
			const freeRef = this._isFreeReference(node);
			if (!refUsage && !freeRef) continue;

			// Symbol resolution. For binding identifiers (the `x` in `let x = …`,
			// destructured `{ x }`, `for (const x of …)`), the symbol is already
			// on the parent declaration node (set by the TS binder) — read it
			// directly instead of paying for a checker.getSymbolAtLocation walk.
			const parent = node.parent;
			let sym: ts.Symbol | undefined;
			const pk = parent?.kind;
			if (
				pk === SK.VariableDeclaration && (parent as ts.VariableDeclaration).name === node
				|| pk === SK.BindingElement && (parent as ts.BindingElement).name === node
			) {
				sym = (parent as { symbol?: ts.Symbol }).symbol;
			}
			if (!sym) {
				sym = checker.getSymbolAtLocation(node);
			}
			// `{ x }` shorthand: getSymbolAtLocation returns the property
			// symbol; we want the binding `x` resolves to.
			if (parent && pk === SK.ShorthandPropertyAssignment && (parent as ts.ShorthandPropertyAssignment).name === node) {
				const valSym = checker.getShorthandAssignmentValueSymbol(parent);
				if (valSym) sym = valSym;
			}
			if (sym && variableBySymbol.has(sym)) {
				// Resolved reference — add to per-symbol index (only when this
				// position counts as a reference, e.g. usage or init).
				if (refUsage) {
					let arr = refs.get(sym);
					if (!arr) refs.set(sym, arr = []);
					{
						const ref = new TsReference(this, node, sym);
						arr.push(ref);
						recordScope(ref);
					}
				}
			}
			else if (sym) {
				// Lib-global decision is cached per symbol: check the cache
				// before re-walking the symbol's declarations through
				// `_isLibGlobalSymbol`. `null` in the cache means
				// "checked, not a lib global".
				let cached = this._libDecisionBySymbol.get(sym);
				if (cached === undefined) {
					cached = this._isLibGlobalSymbol(sym) ? 1 : 0;
					this._libDecisionBySymbol.set(sym, cached);
				}
				if (cached === 1) {
					const isValue = LIB_VALUE_GLOBALS.has(sym.name);
					const inTypePosition = !this._isValueReferencePosition(node);
					if (inTypePosition || isValue) {
						let v = this._libVariableBySymbol.get(sym);
						if (!v) {
							v = new TsVariable(this, sym);
							this._libVariableBySymbol.set(sym, v);
							this.globalScope._addLibVariable(v);
						}
						let arr = refs.get(sym);
						if (!arr) refs.set(sym, arr = []);
						{
						const ref = new TsReference(this, node, sym);
						arr.push(ref);
						recordScope(ref);
					}
					}
					else if (freeRef) {
						// Value ref to a type-only lib global (e.g. Set, Map,
						// Iterable in expression position) — upstream treats
						// as undefined. Match.
						{
						const ref = new TsReference(this, node, sym);
						through.push(ref);
						recordScope(ref);
					}
					}
				}
				else if (freeRef) {
					{
						const ref = new TsReference(this, node, sym);
						through.push(ref);
						recordScope(ref);
					}
				}
			}
			else if (freeRef) {
				// Unresolved (no symbol). Through-only (e.g. typo).
				const ref = new TsReference(this, node, undefined as any);
				through.push(ref);
				recordScope(ref);
			}
		}
		// Free the identifier list — won't be needed again.
		this._pendingIdentifiers = [];
		this._through = through;
		this._referencesByScope = byScope;
		return this._refIndex = refs;
	}

	getReferencesFor(symbol: ts.Symbol): TsReference[] {
		return this._ensureRefIndex().get(symbol) ?? [];
	}

	getThroughReferences(): TsReference[] {
		this._ensureRefIndex();
		return this._through!;
	}

	// Identifier is a reference position (NOT a declaration name, property
	// access RHS, type/property name, label, etc.). Helper for ref-index walk.
	_isFreeReference(id: ts.Identifier): boolean {
		const p = id.parent;
		if (!p) return true;
		// Switch on parent kind — single comparison vs the long ts.isXxx chain.
		// Each case checks the specific child slot the identifier sits in.
		const SK = ts.SyntaxKind;
		switch (p.kind) {
			case SK.PropertyAccessExpression:
				return (p as ts.PropertyAccessExpression).name !== id;
			case SK.QualifiedName:
				return (p as ts.QualifiedName).right !== id;
			case SK.LabeledStatement:
				return (p as ts.LabeledStatement).label !== id;
			case SK.BreakStatement:
			case SK.ContinueStatement:
				return (p as ts.BreakStatement | ts.ContinueStatement).label !== id;
			case SK.PropertyDeclaration:
			case SK.PropertySignature:
			case SK.PropertyAssignment:
			case SK.MethodDeclaration:
			case SK.MethodSignature:
			case SK.GetAccessor:
			case SK.SetAccessor:
			case SK.EnumMember:
			case SK.VariableDeclaration:
			case SK.Parameter:
			case SK.FunctionDeclaration:
			case SK.FunctionExpression:
			case SK.ClassDeclaration:
			case SK.ClassExpression:
			case SK.EnumDeclaration:
			case SK.ModuleDeclaration:
			case SK.TypeAliasDeclaration:
			case SK.InterfaceDeclaration:
			case SK.TypeParameter:
			case SK.ImportClause:
			case SK.NamespaceImport:
			case SK.ImportSpecifier:
			case SK.ImportEqualsDeclaration:
			case SK.NamedTupleMember:
			case SK.JsxAttribute:
				return (p as { name?: ts.Node }).name !== id;
			case SK.ExportSpecifier:
			case SK.BindingElement: {
				const e = p as ts.ExportSpecifier | ts.BindingElement;
				return e.name !== id && e.propertyName !== id;
			}
			case SK.TypeReference:
				// `expr as const` — `const` is a syntactic marker, not a reference.
				if (
					id.text === 'const'
					&& (p as ts.TypeReferenceNode).typeName === id
					&& p.parent
					&& (p.parent.kind === SK.AsExpression || p.parent.kind === SK.TypeAssertionExpression)
					&& (p.parent as ts.AsExpression | ts.TypeAssertion).type === p
				) return false;
				return true;
			default:
				return true;
		}
	}

	// Should this identifier produce a Reference in ESLint's model? True for
	// usages and for VariableDeclaration-with-initializer (which counts as an
	// init Reference). False for "pure declarations" — Parameter, function /
	// class / interface / enum / module / type names, import bindings — those
	// produce a Definition only.
	_isReferenceableUsage(id: ts.Identifier): boolean {
		const p = id.parent;
		if (!p) return true;
		const SK = ts.SyntaxKind;
		switch (p.kind) {
			case SK.VariableDeclaration: {
				const v = p as ts.VariableDeclaration;
				if (v.name !== id) return true;
				// `let x = expr` → init reference. `let x;` → none.
				// for-of / for-in binding → counts (iteration provides the value).
				if (v.initializer !== undefined) return true;
				const list = v.parent;
				if (list && list.kind === SK.VariableDeclarationList) {
					const stmt = list.parent;
					if (stmt && (stmt.kind === SK.ForOfStatement || stmt.kind === SK.ForInStatement)) return true;
				}
				return false;
			}
			case SK.BindingElement: {
				const b = p as ts.BindingElement;
				if (b.name !== id && b.propertyName !== id) return true;
				// Same rules as VariableDeclaration with init or for-of/in bind.
				for (let cur: ts.Node | undefined = p; cur; cur = cur.parent) {
					if (cur.kind === SK.VariableDeclaration) {
						const v = cur as ts.VariableDeclaration;
						if (v.initializer !== undefined) return true;
						const list = v.parent;
						if (list && list.kind === SK.VariableDeclarationList) {
							const stmt = list.parent;
							if (stmt && (stmt.kind === SK.ForOfStatement || stmt.kind === SK.ForInStatement)) return true;
						}
						return false;
					}
					if (cur.kind === SK.Parameter) return false;
				}
				return false;
			}
			case SK.Parameter: {
				// `function f(a, b = 0)` — `b` has an initializer, which counts
				// as an init Reference for the parameter binding.
				const param = p as ts.ParameterDeclaration;
				if (param.name === id && param.initializer !== undefined) return true;
				return param.name !== id;
			}
			case SK.FunctionDeclaration:
			case SK.FunctionExpression:
			case SK.ClassDeclaration:
			case SK.ClassExpression:
			case SK.EnumDeclaration:
			case SK.EnumMember:
			case SK.ModuleDeclaration:
			case SK.InterfaceDeclaration:
			case SK.TypeAliasDeclaration:
			case SK.TypeParameter:
			case SK.ImportClause:
			case SK.NamespaceImport:
			case SK.ImportEqualsDeclaration:
			case SK.NamedTupleMember:
			case SK.PropertyDeclaration:
			case SK.PropertySignature:
			case SK.PropertyAssignment:
			case SK.MethodDeclaration:
			case SK.MethodSignature:
			case SK.GetAccessor:
			case SK.SetAccessor:
			case SK.JsxAttribute:
				return (p as { name?: ts.Node }).name !== id;
			case SK.ImportSpecifier:
			case SK.ExportSpecifier: {
				const e = p as ts.ImportSpecifier | ts.ExportSpecifier;
				return e.name !== id && e.propertyName !== id;
			}
			case SK.PropertyAccessExpression:
				return (p as ts.PropertyAccessExpression).name !== id;
			case SK.QualifiedName:
				return (p as ts.QualifiedName).right !== id;
			case SK.LabeledStatement:
				return (p as ts.LabeledStatement).label !== id;
			case SK.BreakStatement:
			case SK.ContinueStatement:
				return (p as ts.BreakStatement | ts.ContinueStatement).label !== id;
			default:
				return true;
		}
	}

	// Is this Identifier in a value position (not a type)? Used to decide
	// whether an unresolved free reference becomes a `no-undef`-eligible
	// through-reference.
	_isValueReferencePosition(id: ts.Identifier): boolean {
		const ts_ = ts;
		for (let cur: ts.Node | undefined = id.parent; cur; cur = cur.parent) {
			if (ts_.isTypeNode(cur)) return false;
			if (ts_.isExpression(cur) || ts_.isStatement(cur)) return true;
		}
		return true;
	}

	// True if this symbol is declared exclusively in a TS default library
	// (`lib.es*.d.ts`). The caller decides whether the reference resolves —
	// type-position refs always do; value-position refs only do for the names
	// upstream marks as `isValueVariable: true` (LIB_VALUE_GLOBALS).
	_isLibGlobalSymbol(sym: ts.Symbol): boolean {
		const decls = sym.declarations;
		if (!decls || decls.length === 0) return false;
		for (const d of decls) {
			const sf = d.getSourceFile();
			if (!this.program.isSourceFileDefaultLibrary(sf)) return false;
		}
		return true;
	}

	tsToEstree<T extends TSESTree.Node = TSESTree.Node>(tsNode: ts.Node): T | undefined {
		return this.astMaps.tsNodeToESTreeNodeMap.get(tsNode) as T | undefined;
	}

	// Like tsToEstree, but if the node lives in a skipped (TS-only) subtree,
	// return a synthetic stub with `parent` chained back to the nearest
	// real ancestor. Used by rule-facing getters (def.name, def.node, etc.)
	// where returning undefined would crash rules that read `.parent.type`.
	tsToEstreeOrStub<T extends TSESTree.Node = TSESTree.Node>(tsNode: ts.Node | undefined): T | undefined {
		if (!tsNode) return undefined;
		const real = this.astMaps.tsNodeToESTreeNodeMap.get(tsNode) as T | undefined;
		if (real) return real;
		const { buildSyntheticParent } = require(
			'./skip-type-converter',
		) as typeof import('./skip-type-converter');
		return buildSyntheticParent(
			tsNode,
			this.astMaps.tsNodeToESTreeNodeMap as unknown as WeakMap<ts.Node, object>,
		) as T | undefined;
	}
}

export class TsScope {
	_variables?: TsVariable[];
	_childScopes: TsScope[] = [];
	_set?: Map<string, TsVariable>;
	upper: TsScope | null;

	constructor(
		readonly manager: TsScopeManager,
		readonly tsNode: ts.Node,
		readonly type: ScopeType,
		upper: TsScope | null,
		register = false,
	) {
		this.upper = upper;
		if (upper) upper._childScopes.push(this);
		if (register) manager._registerScope(tsNode, this);
	}

	get block(): TSESTree.Node | undefined {
		return this.manager.tsToEstreeOrStub(this.tsNode);
	}

	get variableScope(): TsScope {
		// Nearest enclosing function/global/module/class scope.
		let s: TsScope | null = this;
		while (s && s.type !== 'function' && s.type !== 'global' && s.type !== 'module' && s.type !== 'class') {
			s = s.upper;
		}
		return s ?? this.manager.globalScope;
	}

	get functionExpressionScope(): boolean {
		return this.type === 'function-expression-name';
	}

	get isStrict(): boolean {
		// Modules are implicitly strict.
		if (this.manager.isModule()) return true;
		// Class bodies are always strict.
		if (this.type === 'class') return true;
		const SK = ts.SyntaxKind;
		const hasUseStrictDirective = (statements: ReadonlyArray<ts.Statement>): boolean => {
			for (const stmt of statements) {
				if (
					stmt.kind === SK.ExpressionStatement
					&& (stmt as ts.ExpressionStatement).expression.kind === SK.StringLiteral
					&& ((stmt as ts.ExpressionStatement).expression as ts.StringLiteral).text === 'use strict'
				) return true;
				break; // directive prologue only — first non-directive stops the search.
			}
			return false;
		};
		// SourceFile (script with `'use strict'` at top): propagates.
		if (this.type === 'global') {
			if (hasUseStrictDirective((this.tsNode as ts.SourceFile).statements)) return true;
		}
		// Function with 'use strict' directive in body.
		if (this.type === 'function') {
			const fn = this.tsNode as ts.FunctionLikeDeclaration;
			const body = (fn as { body?: ts.Node }).body;
			if (body && body.kind === SK.Block && hasUseStrictDirective((body as ts.Block).statements)) {
				return true;
			}
		}
		// Inherit from upper scope.
		return this.upper?.isStrict ?? false;
	}

	get variables(): TsVariable[] {
		if (!this._variables) {
			this._variables = this._collectVariables();
		}
		return this._variables;
	}

	// Inject a synthesized lib global (Object, Array, etc.) discovered during
	// reference-index walk. Only globalScope receives these.
	_addLibVariable(v: TsVariable) {
		void this.variables; // ensure populated
		if (!this._variables!.includes(v)) {
			this._variables!.push(v);
			this._set?.set(v.name, v);
		}
	}

	_collectVariables(): TsVariable[] {
		const ts_ = ts;
		const SK = ts_.SyntaxKind;
		const out: TsVariable[] = [];
		const seen = new Set<ts.Symbol>();
		const seenNames = new Set<string>();
		const push = (sym: ts.Symbol | undefined) => {
			if (!sym || seen.has(sym)) return;
			seen.add(sym);
			// Dedupe by name too: TS sometimes produces multiple symbols for the
			// same lexical binding (e.g. parameter properties have one symbol
			// for the parameter and another for the synthesized class member).
			// ESLint expects one Variable per name in a scope.
			if (seenNames.has(sym.name)) return;
			seenNames.add(sym.name);
			out.push(this.manager._getOrCreateVariable(sym));
		};
		const symOf = (decl: ts.Node | undefined): ts.Symbol | undefined => {
			if (!decl) return undefined;
			const direct = (decl as { symbol?: ts.Symbol }).symbol;
			if (direct) return direct;
			const nameNode = (decl as { name?: ts.Node }).name;
			if (nameNode) return this.manager.checker.getSymbolAtLocation(nameNode);
			return undefined;
		};
		// Walk the binding pattern of a declarator/parameter, pushing every
		// identifier's symbol into `out`.
		const pushBinding = (binding: ts.BindingName | undefined) => {
			if (!binding) return;
			if (ts_.isIdentifier(binding)) {
				push(this.manager.checker.getSymbolAtLocation(binding));
				return;
			}
			if (ts_.isObjectBindingPattern(binding) || ts_.isArrayBindingPattern(binding)) {
				for (const el of binding.elements) {
					if (ts_.isOmittedExpression(el)) continue;
					pushBinding(el.name);
				}
			}
		};
		// Walk children up to (but not into) any nested scope of these kinds.
		const walkUntilScope = (n: ts.Node, visit: (c: ts.Node) => void) => {
			ts_.forEachChild(n, c => {
				visit(c);
				// Skip into another scope (we don't recurse into function bodies etc.)
				if (this._isOwnScopeBoundary(c)) return;
				walkUntilScope(c, visit);
			});
		};

		switch (this.type) {
			case 'global': {
				// In module mode the globalScope is empty — moduleScope owns the
				// top-level decls. In script mode globalScope owns them.
				if (this.manager.isModule()) break;
				const sf = this.tsNode as ts.SourceFile;
				for (const stmt of sf.statements) this._collectStatementBindings(stmt, push, pushBinding);
				break;
			}
			case 'module': {
				const sf = this.tsNode as ts.SourceFile;
				for (const stmt of sf.statements) this._collectStatementBindings(stmt, push, pushBinding);
				break;
			}
			case 'function': {
				const fn = this.tsNode as ts.FunctionLikeDeclaration;
				// Parameters
				if (fn.parameters) {
					for (const p of fn.parameters) pushBinding(p.name);
				}
				// Synthetic 'arguments' for non-arrow functions.
				if (fn.kind !== SK.ArrowFunction) {
					const argsVar = this._getOrCreateArgumentsVar();
					if (!seen.has(argsVar.symbol)) {
						out.push(argsVar);
						seen.add(argsVar.symbol);
					}
				}
				// Var-hoisted decls live in `fn.locals`; let/const/function in
				// the body live in `body.locals`. ESLint collapses both into
				// the function scope.
				const fnLocals = (fn as { locals?: ts.SymbolTable }).locals;
				if (fnLocals) fnLocals.forEach(sym => push(sym));
				if (fn.body && ts_.isBlock(fn.body)) {
					const bodyLocals = (fn.body as { locals?: ts.SymbolTable }).locals;
					if (bodyLocals) bodyLocals.forEach(sym => push(sym));
				}
				break;
			}
			case 'function-expression-name': {
				const fn = this.tsNode as ts.FunctionExpression;
				if (fn.name) push(this.manager.checker.getSymbolAtLocation(fn.name));
				break;
			}
			case 'class': {
				const cls = this.tsNode as ts.ClassLikeDeclaration;
				if (cls.name) push(this.manager.checker.getSymbolAtLocation(cls.name));
				if (cls.typeParameters) {
					for (const tp of cls.typeParameters) push(symOf(tp));
				}
				break;
			}
			case 'block': {
				// let/const/function/class declared directly in the block. var is
				// excluded — it hoists to the enclosing function/global scope.
				const block = this.tsNode as ts.Block;
				for (const stmt of block.statements) {
					if (ts_.isVariableStatement(stmt)) {
						const flags = stmt.declarationList.flags;
						if (flags & (ts_.NodeFlags.Let | ts_.NodeFlags.Const)) {
							for (const d of stmt.declarationList.declarations) pushBinding(d.name);
						}
						continue;
					}
					this._collectStatementBindings(stmt, push, pushBinding);
				}
				break;
			}
			case 'for': {
				const f = this.tsNode as ts.ForStatement | ts.ForInStatement | ts.ForOfStatement;
				const initializer = (f as ts.ForStatement).initializer ?? (f as ts.ForInStatement | ts.ForOfStatement).initializer;
				if (initializer && ts_.isVariableDeclarationList(initializer)) {
					for (const d of initializer.declarations) pushBinding(d.name);
				}
				break;
			}
			case 'catch': {
				const c = this.tsNode as ts.CatchClause;
				if (c.variableDeclaration) pushBinding(c.variableDeclaration.name);
				break;
			}
			case 'switch':
			case 'with':
				// No own variables.
				break;
			case 'tsEnum': {
				const e = this.tsNode as ts.EnumDeclaration;
				for (const m of e.members) push(symOf(m));
				break;
			}
			case 'tsModule': {
				const mod = this.tsNode as ts.ModuleDeclaration;
				const body = mod.body;
				if (body && ts_.isModuleBlock(body)) {
					for (const stmt of body.statements) this._collectStatementBindings(stmt, push, pushBinding);
				}
				break;
			}
			case 'type':
			case 'conditional-type': {
				const tps = (this.tsNode as { typeParameters?: ts.NodeArray<ts.TypeParameterDeclaration> }).typeParameters;
				if (tps) {
					for (const tp of tps) push(symOf(tp));
				}
				break;
			}
			case 'mapped-type': {
				// Mapped types use a single `typeParameter` (not the plural array).
				const tp = (this.tsNode as ts.MappedTypeNode).typeParameter;
				if (tp) push(symOf(tp));
				break;
			}
			case 'function-type': {
				// Function type signatures (FunctionType, MethodSignature, etc.):
				// type params + parameter names are scoped here. Upstream's
				// no-unused-vars treats their parameter names as variables.
				const tps = (this.tsNode as { typeParameters?: ts.NodeArray<ts.TypeParameterDeclaration> }).typeParameters;
				if (tps) {
					for (const tp of tps) push(symOf(tp));
				}
				const params = (this.tsNode as { parameters?: ts.NodeArray<ts.ParameterDeclaration> }).parameters;
				if (params) {
					for (const p of params) pushBinding(p.name);
				}
				break;
			}
		}
		return out;
	}

	_isOwnScopeBoundary(n: ts.Node): boolean {
		const ts_ = ts;
		const SK = ts_.SyntaxKind;
		switch (n.kind) {
			case SK.FunctionDeclaration:
			case SK.FunctionExpression:
			case SK.ArrowFunction:
			case SK.MethodDeclaration:
			case SK.Constructor:
			case SK.GetAccessor:
			case SK.SetAccessor:
			case SK.ClassDeclaration:
			case SK.ClassExpression:
			case SK.ForStatement:
			case SK.ForInStatement:
			case SK.ForOfStatement:
			case SK.CatchClause:
			case SK.SwitchStatement:
			case SK.WithStatement:
			case SK.EnumDeclaration:
			case SK.ModuleDeclaration:
			case SK.InterfaceDeclaration:
			case SK.TypeAliasDeclaration:
			case SK.MappedType:
			case SK.ConditionalType:
			case SK.FunctionType:
			case SK.ConstructorType:
			case SK.CallSignature:
			case SK.ConstructSignature:
			case SK.MethodSignature:
				return true;
			case SK.Block: {
				// Function bodies are not their own block scope (they ARE the function
				// scope's body). Free-standing blocks are.
				const p = n.parent;
				if (
					p && (
						p.kind === SK.FunctionDeclaration
						|| p.kind === SK.FunctionExpression
						|| p.kind === SK.ArrowFunction
						|| p.kind === SK.MethodDeclaration
						|| p.kind === SK.Constructor
						|| p.kind === SK.GetAccessor
						|| p.kind === SK.SetAccessor
					)
				) {
					return false;
				}
				return true;
			}
		}
		return false;
	}

	// Collect bindings from a statement that lives in this scope (i.e. block /
	// global / module / tsModule scope). Does not recurse into nested scopes.
	_collectStatementBindings(
		stmt: ts.Statement,
		push: (sym: ts.Symbol | undefined) => void,
		pushBinding: (b: ts.BindingName | undefined) => void,
	) {
		const ts_ = ts;
		if (ts_.isVariableStatement(stmt)) {
			// Module/global/block scope: only let/const/var (var hoists to function,
			// but at top level it lives in the module/global scope).
			for (const d of stmt.declarationList.declarations) pushBinding(d.name);
			return;
		}
		if (ts_.isFunctionDeclaration(stmt) || ts_.isClassDeclaration(stmt)) {
			if (stmt.name) push(this.manager.checker.getSymbolAtLocation(stmt.name));
			return;
		}
		if (ts_.isImportDeclaration(stmt)) {
			const clause = stmt.importClause;
			if (!clause) return;
			if (clause.name) push(this.manager.checker.getSymbolAtLocation(clause.name));
			const bindings = clause.namedBindings;
			if (bindings) {
				if (ts_.isNamespaceImport(bindings)) {
					push(this.manager.checker.getSymbolAtLocation(bindings.name));
				}
				else {
					for (const el of bindings.elements) {
						push(this.manager.checker.getSymbolAtLocation(el.name));
					}
				}
			}
			return;
		}
		if (ts_.isImportEqualsDeclaration(stmt)) {
			// `import x = require('mod')` and `import x = OtherNS` — the name
			// binds in module/global scope.
			push(this.manager.checker.getSymbolAtLocation(stmt.name));
			return;
		}
		if (ts_.isEnumDeclaration(stmt) || ts_.isModuleDeclaration(stmt)) {
			if (stmt.name && ts.isIdentifier(stmt.name)) {
				push(this.manager.checker.getSymbolAtLocation(stmt.name));
			}
			return;
		}
		if (ts_.isInterfaceDeclaration(stmt) || ts_.isTypeAliasDeclaration(stmt)) {
			if (stmt.name) push(this.manager.checker.getSymbolAtLocation(stmt.name));
			return;
		}
	}

	_getOrCreateArgumentsVar(): TsVariable {
		let v = this.manager._syntheticArguments.get(this);
		if (!v) {
			v = new TsVariable(this.manager, /* synthetic */ { name: 'arguments', declarations: [], flags: 0 } as any);
			this.manager._syntheticArguments.set(this, v);
		}
		return v;
	}

	get set(): Map<string, TsVariable> {
		if (!this._set) {
			this._set = new Map();
			for (const v of this.variables) this._set.set(v.name, v);
		}
		return this._set;
	}

	get childScopes(): TsScope[] {
		return this._childScopes;
	}

	get references(): TsReference[] {
		this.manager._ensureRefIndex();
		return this.manager._referencesByScope!.get(this) ?? [];
	}

	get implicit(): {
		variables: TsVariable[];
		left: TsReference[];
		leftToBeResolved: TsReference[];
		set: Map<string, TsVariable>;
	} {
		// Only globalScope has meaningful implicit globals — references that
		// escaped resolution and become implicit globals at runtime. Other
		// scopes return an empty shape for compatibility.
		if (this.type === 'global') {
			const through = this.manager.getThroughReferences();
			return {
				variables: [],
				left: through,
				leftToBeResolved: through,
				set: new Map(),
			};
		}
		return { variables: [], left: [], leftToBeResolved: [], set: new Map() };
	}

	get through(): TsReference[] {
		// Only the globalScope holds the unresolved-reference list — other
		// scopes inherit ESLint's "passes through to parent" model only at the
		// top boundary in this implementation. (Most rules that touch through
		// — e.g. no-undef — read it from the global scope anyway.)
		if (this.type === 'global') return this.manager.getThroughReferences();
		return [];
	}
}

export class TsVariable {
	_defs?: TsDefinition[];
	_references?: TsReference[];
	_identifiers?: TSESTree.Identifier[];
	eslintUsed = false;
	eslintExported = false;
	eslintExplicitGlobal = false;
	eslintExplicitGlobalComments = undefined as undefined | unknown[];
	eslintImplicitGlobalSetting = undefined as undefined | string;

	constructor(readonly manager: TsScopeManager, readonly symbol: ts.Symbol) {}

	get name(): string { return this.symbol.name; }

	get scope(): TsScope {
		const decl = this.symbol.declarations?.[0];
		if (!decl) return this.manager.globalScope;
		const ts_ = ts;
		const SK = ts_.SyntaxKind;
		// Walk parents until we hit a scope-creating node.
		for (let cur: ts.Node | undefined = decl; cur; cur = cur.parent) {
			const arr = this.manager.nodeToScope.get(cur);
			if (arr && arr.length > 0) {
				// Pick the innermost non-fn-expr-name scope.
				for (let i = arr.length - 1; i >= 0; --i) {
					if (arr[i].type !== 'function-expression-name') return arr[i];
				}
			}
			if (cur.kind === SK.SourceFile) break;
		}
		return this.manager.globalScope;
	}

	get defs(): TsDefinition[] {
		if (!this._defs) {
			const decls = this.symbol.declarations ?? [];
			this._defs = decls.map(d => new TsDefinition(this.manager, this, d));
		}
		return this._defs;
	}

	get identifiers(): TSESTree.Identifier[] {
		if (!this._identifiers) {
			this._identifiers = this.defs.map(d => d.name).filter(Boolean) as TSESTree.Identifier[];
		}
		return this._identifiers;
	}

	get references(): TsReference[] {
		if (!this._references) {
			this._references = this.manager.getReferencesFor(this.symbol);
		}
		return this._references;
	}

	get writeable(): boolean {
		const decls = this.symbol.declarations ?? [];
		for (const d of decls) {
			const ts_ = ts;
			if (ts_.isVariableDeclaration(d)) {
				const list = d.parent;
				if (ts_.isVariableDeclarationList(list)) {
					if (list.flags & ts_.NodeFlags.Const) return false;
				}
			}
			if (ts_.isImportSpecifier(d) || ts_.isImportClause(d) || ts_.isNamespaceImport(d)) return false;
			if (ts_.isFunctionDeclaration(d) || ts_.isClassDeclaration(d) || ts_.isEnumDeclaration(d)) return false;
		}
		return true;
	}

	get isValueVariable(): boolean {
		const ts_ = ts;
		return (this.symbol.flags & ts_.SymbolFlags.Value) !== 0;
	}

	get isTypeVariable(): boolean {
		const ts_ = ts;
		return (this.symbol.flags & ts_.SymbolFlags.Type) !== 0;
	}
}

export class TsReference {
	_estreeIdent?: TSESTree.Identifier;

	constructor(
		readonly manager: TsScopeManager,
		readonly tsIdentifier: ts.Identifier,
		readonly symbol: ts.Symbol,
	) {}

	get identifier(): TSESTree.Identifier {
		if (this._estreeIdent) return this._estreeIdent;
		const real = this.manager.tsToEstree<TSESTree.Identifier>(this.tsIdentifier);
		if (real) return this._estreeIdent = real;
		// Identifier sits inside a skipped (TS-only) subtree — synthesize a
		// stub that rules can read `.parent.type` etc. on without crashing.
		const { buildSyntheticParent } = require(
			'./skip-type-converter',
		) as typeof import('./skip-type-converter');
		const stub: TSESTree.Identifier = {
			type: 'Identifier',
			name: this.tsIdentifier.text,
			range: [this.tsIdentifier.getStart(), this.tsIdentifier.end],
		} as TSESTree.Identifier;
		if (this.tsIdentifier.parent) {
			(stub as { parent?: object }).parent = buildSyntheticParent(
				this.tsIdentifier.parent,
				this.manager.astMaps.tsNodeToESTreeNodeMap as unknown as WeakMap<ts.Node, object>,
			);
		}
		return this._estreeIdent = stub;
	}

	get from(): TsScope {
		const ts_ = ts;
		const SK = ts_.SyntaxKind;
		for (let cur: ts.Node | undefined = this.tsIdentifier.parent; cur; cur = cur.parent) {
			const arr = this.manager.nodeToScope.get(cur);
			if (arr && arr.length > 0) {
				for (let i = arr.length - 1; i >= 0; --i) {
					if (arr[i].type !== 'function-expression-name') return arr[i];
				}
			}
			if (cur.kind === SK.SourceFile) break;
		}
		return this.manager.globalScope;
	}

	get resolved(): TsVariable | null {
		return this.manager._getOrCreateVariable(this.symbol);
	}

	// Identifier IS the declaration name (binding position), not just a usage
	// of the symbol. Used internally by `init` / `isWrite`.
	get _isBindingIdentifier(): boolean {
		const decls = this.symbol?.declarations ?? [];
		for (const d of decls) {
			if ((d as { name?: ts.Node }).name === this.tsIdentifier) return true;
		}
		return false;
	}

	get init(): boolean | undefined {
		// ESLint's `init` tristate:
		//   - true  → declaration-with-initializer (`let x = expr`)
		//   - false → non-init write (`x = expr`)
		//   - undefined → pure read.
		if (this._isBindingIdentifier) return true;
		return this.isWrite() ? false : undefined;
	}

	isWrite(): boolean {
		const ts_ = ts;
		const id = this.tsIdentifier;
		const parent = id.parent;
		if (this._isBindingIdentifier) return true;
		if (parent && ts_.isBinaryExpression(parent) && parent.left === id) {
			const op = parent.operatorToken.kind;
			return op === ts_.SyntaxKind.EqualsToken
				|| (op >= ts_.SyntaxKind.FirstCompoundAssignment && op <= ts_.SyntaxKind.LastCompoundAssignment);
		}
		if (parent && (ts_.isPrefixUnaryExpression(parent) || ts_.isPostfixUnaryExpression(parent))) {
			const op = parent.operator;
			return op === ts_.SyntaxKind.PlusPlusToken || op === ts_.SyntaxKind.MinusMinusToken;
		}
		return false;
	}

	isRead(): boolean {
		if (this._isBindingIdentifier) return false;
		if (!this.isWrite()) return true;
		const parent = this.tsIdentifier.parent;
		const ts_ = ts;
		// Compound assignments (`+=`, `-=`, etc.) read+write.
		if (parent && ts_.isBinaryExpression(parent) && parent.left === this.tsIdentifier) {
			return parent.operatorToken.kind !== ts_.SyntaxKind.EqualsToken;
		}
		// `x++` / `++x` / `x--` / `--x` read+write.
		if (parent && (ts_.isPrefixUnaryExpression(parent) || ts_.isPostfixUnaryExpression(parent))) {
			const op = parent.operator;
			return op === ts_.SyntaxKind.PlusPlusToken || op === ts_.SyntaxKind.MinusMinusToken;
		}
		return false;
	}

	isWriteOnly(): boolean { return this.isWrite() && !this.isRead(); }
	isReadOnly(): boolean { return this.isRead() && !this.isWrite(); }
	isReadWrite(): boolean { return this.isRead() && this.isWrite(); }

	get writeExpr(): TSESTree.Node | null {
		// For an init reference (`let x = expr`, `function f(b = expr)`, etc.),
		// returns the initializer expression. For an assignment (`x = expr`,
		// `x += expr`), returns the right-hand side. Else null.
		const SK = ts.SyntaxKind;
		const id = this.tsIdentifier;
		const parent = id.parent;
		if (!parent) return null;
		// VariableDeclaration / Parameter init.
		if (
			(parent.kind === SK.VariableDeclaration && (parent as ts.VariableDeclaration).name === id)
			|| (parent.kind === SK.Parameter && (parent as ts.ParameterDeclaration).name === id)
		) {
			const init = (parent as { initializer?: ts.Node }).initializer;
			return init ? this.manager.tsToEstreeOrStub(init) ?? null : null;
		}
		// BindingElement (destructured init): use the enclosing VariableDeclaration's initializer.
		if (parent.kind === SK.BindingElement && (parent as ts.BindingElement).name === id) {
			for (let cur: ts.Node | undefined = parent; cur; cur = cur.parent) {
				if (cur.kind === SK.VariableDeclaration) {
					const init = (cur as ts.VariableDeclaration).initializer;
					return init ? this.manager.tsToEstreeOrStub(init) ?? null : null;
				}
				if (cur.kind === SK.Parameter) {
					const init = (cur as ts.ParameterDeclaration).initializer;
					return init ? this.manager.tsToEstreeOrStub(init) ?? null : null;
				}
			}
			return null;
		}
		// Assignment: x = rhs, x += rhs.
		if (parent.kind === SK.BinaryExpression && (parent as ts.BinaryExpression).left === id) {
			const op = (parent as ts.BinaryExpression).operatorToken.kind;
			if (
				op === SK.EqualsToken
				|| (op >= SK.FirstCompoundAssignment && op <= SK.LastCompoundAssignment)
			) {
				return this.manager.tsToEstreeOrStub((parent as ts.BinaryExpression).right) ?? null;
			}
		}
		return null;
	}

	get isValueReference(): boolean {
		const ts_ = ts;
		for (let cur: ts.Node | undefined = this.tsIdentifier.parent; cur; cur = cur.parent) {
			if (ts_.isTypeNode(cur)) return false;
			if (ts_.isExpression(cur)) return true;
		}
		return true;
	}

	get isTypeReference(): boolean { return !this.isValueReference; }
}

export class TsDefinition {
	constructor(
		readonly manager: TsScopeManager,
		readonly variable: TsVariable,
		readonly tsDeclaration: ts.Node,
	) {}

	get type(): DefinitionType {
		const ts_ = ts;
		const d = this.tsDeclaration;
		if (ts_.isVariableDeclaration(d)) {
			// In TS, catch params are modeled as VariableDeclaration whose parent is
			// CatchClause; ESLint treats those as CatchClauseDefinition.
			if (d.parent && ts_.isCatchClause(d.parent)) return 'CatchClause';
			return 'Variable';
		}
		if (ts_.isParameter(d)) return 'Parameter';
		if (ts_.isFunctionDeclaration(d) || ts_.isFunctionExpression(d) || ts_.isArrowFunction(d)) return 'FunctionName';
		if (ts_.isClassDeclaration(d) || ts_.isClassExpression(d)) return 'ClassName';
		if (
			ts_.isImportSpecifier(d)
			|| ts_.isImportClause(d)
			|| ts_.isNamespaceImport(d)
			|| ts_.isImportEqualsDeclaration(d)
		) return 'ImportBinding';
		if (ts_.isCatchClause(d)) return 'CatchClause';
		if (ts_.isEnumDeclaration(d)) return 'TSEnumName';
		if (ts_.isEnumMember(d)) return 'TSEnumMember';
		if (ts_.isModuleDeclaration(d)) return 'TSModuleName';
		if (ts_.isTypeAliasDeclaration(d) || ts_.isInterfaceDeclaration(d) || ts_.isTypeParameterDeclaration(d)) return 'Type';
		return 'Variable';
	}

	get name(): TSESTree.Identifier | undefined {
		const nameNode = (this.tsDeclaration as { name?: ts.Node }).name;
		if (!nameNode) return undefined;
		return this.manager.tsToEstreeOrStub<TSESTree.Identifier>(nameNode);
	}

	get node(): TSESTree.Node | undefined {
		// For Variable defs, ESLint expects the VariableDeclarator (TS:
		// VariableDeclaration). For destructured names whose declaration is a
		// BindingElement / pattern, walk up until we find the declarator.
		const ts_ = ts;
		let target: ts.Node = this.tsDeclaration;
		while (
			target
			&& (ts_.isBindingElement(target)
				|| ts_.isObjectBindingPattern(target)
				|| ts_.isArrayBindingPattern(target))
		) {
			target = target.parent;
		}
		// Parameter: ESLint expects `node` to be the enclosing function-like.
		if (target && ts_.isParameter(target) && target.parent) {
			target = target.parent;
		}
		// Catch param: TS models as VariableDeclaration under CatchClause; ESLint
		// expects the CatchClause itself as the def's node.
		if (target && ts_.isVariableDeclaration(target) && target.parent && ts_.isCatchClause(target.parent)) {
			target = target.parent;
		}
		return this.manager.tsToEstreeOrStub(target);
	}

	get parent(): TSESTree.Node | undefined {
		// For VariableDeclarator, parent is VariableDeclaration (TS:
		// VariableDeclarationList → parent is VariableStatement).
		const ts_ = ts;
		let target: ts.Node = this.tsDeclaration;
		while (
			target
			&& (ts_.isBindingElement(target)
				|| ts_.isObjectBindingPattern(target)
				|| ts_.isArrayBindingPattern(target))
		) {
			target = target.parent;
		}
		// VariableDeclaration → parent is VariableDeclarationList → parent is
		// VariableStatement (which corresponds to ESTree VariableDeclaration).
		if (target && ts_.isVariableDeclaration(target)) {
			const list = target.parent;
			if (list && ts_.isVariableDeclarationList(list)) {
				return this.manager.tsToEstreeOrStub(list.parent);
			}
		}
		return this.manager.tsToEstreeOrStub(target?.parent);
	}

	get isVariableDefinition(): boolean { return this.type === 'Variable' || this.type === 'Parameter'; }
	get isTypeDefinition(): boolean { return this.type === 'Type'; }
}
