// Predictive batch type prefetch for the tsgo backend.
//
// During prepareFile, walk the file AST and batch-resolve types that
// enabled rules are likely to request — before the sync rule loop.
// Fills the same WeakMap caches wrapChecker reads.
//
// When a PrefetchPlan is supplied (from compat-eslint selector hints),
// only the flagged buckets run. Syntactic-only files skip prefetch RPC.

import type { RpcProfile } from './tsgo-rpc-profile.js';

type Node = import('@typescript/native-preview/unstable/ast', { with: { 'resolution-mode': 'import' } }).Node;
type Project = InstanceType<
	typeof import('@typescript/native-preview/unstable/sync', { with: { 'resolution-mode': 'import' } })['Project']
>;

export interface PrefetchPlan {
	memberAccess: boolean;
	typeAssertions: boolean;
	symbolFallback: boolean;
	contextualCalls: boolean;
	propertiesOfType: boolean;
}

export const EMPTY_PREFETCH_PLAN: PrefetchPlan = {
	memberAccess: false,
	typeAssertions: false,
	symbolFallback: false,
	contextualCalls: false,
	propertiesOfType: false,
};

export type TypePrefetchCaches = {
	nodeTypeCache: WeakMap<Node, import('typescript').Type | null>;
	typeFromTypeNodeCache: WeakMap<Node, import('typescript').Type | null>;
	indexInfosCache?: WeakMap<object, unknown | null>;
	propertiesOfTypeCache?: WeakMap<object, unknown | null>;
	contextualTypeCache?: WeakMap<Node, import('typescript').Type | null>;
	nodeToSymbol?: WeakMap<Node, unknown>;
};

export type TypePrefetchDeps = {
	astSyntaxKind: Record<string, number>;
	fixupType: (t: unknown) => unknown;
	rpcCall: <T>(method: string, fn: () => T) => T;
	rpc?: RpcProfile;
	caches: TypePrefetchCaches;
};

function isSymbolFallbackIdentifier(node: Node, SK: Record<string, number>): boolean {
	if (node.kind !== SK.Identifier) return false;
	const parent = node.parent as Node | undefined;
	if (!parent) return false;
	const pk = parent.kind;
	if (pk === SK.ImportSpecifier || pk === SK.ExportSpecifier) {
		const spec = parent as unknown as { name?: Node; propertyName?: Node };
		return spec.name === node || spec.propertyName === node;
	}
	if (pk === SK.ImportClause) {
		const clause = parent as unknown as { name?: Node };
		return clause.name === node;
	}
	if (pk === SK.NamespaceImport) {
		const ns = parent as unknown as { name?: Node };
		return ns.name === node;
	}
	return false;
}

export function batchPrefetchTypes(
	project: Project,
	sf: Node,
	fileName: string,
	deps: TypePrefetchDeps,
	plan: PrefetchPlan = EMPTY_PREFETCH_PLAN,
): {
	typeAtPosition: number;
	typeFromTypeNode: number;
	indexInfos: number;
	symbolsAtPosition: number;
	contextualTypes: number;
	propertiesOfType: number;
} {
	const empty = {
		typeAtPosition: 0,
		typeFromTypeNode: 0,
		indexInfos: 0,
		symbolsAtPosition: 0,
		contextualTypes: 0,
		propertiesOfType: 0,
	};
	if (!plan.memberAccess && !plan.typeAssertions && !plan.symbolFallback
		&& !plan.contextualCalls && !plan.propertiesOfType) {
		return empty;
	}

	const SK = deps.astSyntaxKind;
	const { caches, fixupType, rpcCall } = deps;

	const memberAccessNodes: Node[] = [];
	const typeAnnotationNodes: Node[] = [];
	const symbolFallbackNodes: Node[] = [];
	const contextualNodes: Node[] = [];
	const seenTypeNodes = new Set<Node>();

	const visit = (node: Node) => {
		const k = node.kind;
		if (plan.memberAccess
			&& (k === SK.PropertyAccessExpression || k === SK.ElementAccessExpression)) {
			memberAccessNodes.push(node);
		}
		if (plan.symbolFallback && isSymbolFallbackIdentifier(node, SK)) {
			symbolFallbackNodes.push(node);
		}
		if (plan.contextualCalls
			&& (k === SK.CallExpression || k === SK.ArrowFunctionExpression)) {
			contextualNodes.push(node);
		}
		if (plan.typeAssertions) {
			if (
				(k === SK.AsExpression || k === SK.TypeAssertionExpression || k === SK.SatisfiesExpression)
				&& (node as unknown as { type?: Node }).type
			) {
				const typeNode = (node as unknown as { type: Node }).type;
				if (!seenTypeNodes.has(typeNode)) {
					seenTypeNodes.add(typeNode);
					typeAnnotationNodes.push(typeNode);
				}
			}
		}
		node.forEachChild(visit);
	};
	visit(sf);

	let typeAtPosition = 0;
	let typeFromTypeNode = 0;
	let indexInfos = 0;
	let symbolsAtPosition = 0;
	let contextualTypes = 0;
	let propertiesOfType = 0;

	const warmTypeCaches = (raw: unknown) => {
		if (!raw || typeof raw !== 'object') return;
		const key = raw as object;
		if (caches.indexInfosCache && !caches.indexInfosCache.has(key)) {
			try {
				const infos = rpcCall('getIndexInfosOfType', () =>
					project.checker.getIndexInfosOfType(raw as any));
				caches.indexInfosCache.set(key, infos ?? null);
				indexInfos++;
			}
			catch { /* lazy fallback */ }
		}
	};

	const seenTypes = new Set<object>();

	if (memberAccessNodes.length > 0) {
		try {
			const positions = memberAccessNodes.map(n => n.end);
			const types = rpcCall('getTypesAtPositions(batch)', () =>
				project.checker.getTypeAtPosition(fileName, positions)) as unknown as unknown[];
			for (let j = 0; j < memberAccessNodes.length; j++) {
				const node = memberAccessNodes[j];
				if (caches.nodeTypeCache.has(node)) continue;
				const raw = types[j];
				if (raw) fixupType(raw);
				caches.nodeTypeCache.set(node, raw ? raw as unknown as import('typescript').Type : null);
				typeAtPosition++;
				if (raw && typeof raw === 'object') {
					const key = raw as object;
					if (!seenTypes.has(key)) {
						seenTypes.add(key);
						warmTypeCaches(raw);
					}
				}
			}
		}
		catch { /* lazy fallback at lint time */ }
	}

	for (const typeNode of typeAnnotationNodes) {
		if (caches.typeFromTypeNodeCache.has(typeNode)) continue;
		try {
			const raw = rpcCall('getTypeFromTypeNode', () =>
				project.checker.getTypeFromTypeNode(typeNode as any));
			if (raw) fixupType(raw);
			caches.typeFromTypeNodeCache.set(
				typeNode,
				raw ? raw as unknown as import('typescript').Type : null,
			);
			typeFromTypeNode++;
		}
		catch { /* lazy fallback */ }
	}

	if (plan.symbolFallback && symbolFallbackNodes.length > 0 && caches.nodeToSymbol) {
		try {
			const positions = symbolFallbackNodes.map(n => n.end);
			const syms = rpcCall('getSymbolsAtPositions(batch)', () =>
				project.checker.getSymbolAtPosition(fileName, positions)) as unknown as unknown[];
			for (let j = 0; j < symbolFallbackNodes.length; j++) {
				const node = symbolFallbackNodes[j];
				if (caches.nodeToSymbol.has(node)) continue;
				caches.nodeToSymbol.set(node, syms[j] ?? undefined);
				symbolsAtPosition++;
			}
		}
		catch { /* lazy fallback at lint time */ }
	}

	if (plan.contextualCalls && contextualNodes.length > 0 && caches.contextualTypeCache) {
		for (const node of contextualNodes) {
			if (caches.contextualTypeCache.has(node)) continue;
			try {
				const raw = rpcCall('getContextualType', () =>
					project.checker.getContextualType(node as any));
				if (raw) fixupType(raw);
				caches.contextualTypeCache.set(
					node,
					raw ? raw as unknown as import('typescript').Type : null,
				);
				contextualTypes++;
			}
			catch { /* lazy fallback */ }
		}
	}

	return {
		typeAtPosition,
		typeFromTypeNode,
		indexInfos,
		symbolsAtPosition,
		contextualTypes,
		propertiesOfType,
	};
}
