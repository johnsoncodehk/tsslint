// Predictive batch type prefetch for the tsgo backend.
//
// During prepareFile, walk the file AST and batch-resolve types that
// enabled rules are likely to request — before the sync rule loop.
// Fills the same per-file Map caches wrapChecker reads (cleared in releaseFile).
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

/** tsgo RPC symbols carry a numeric id; JS-side bind symbols do not. */
const BATCH_CHUNK = 256;

function isTsgoSymbol(sym: unknown): sym is { id: number } {
	return Boolean(sym && typeof sym === 'object' && typeof (sym as { id?: unknown }).id === 'number');
}

function chunk<T>(items: readonly T[], size: number): T[][] {
	const out: T[][] = [];
	for (let i = 0; i < items.length; i += size) {
		out.push(items.slice(i, i + size));
	}
	return out;
}

export type TypePrefetchCaches = {
	nodeTypeCache: Map<Node, import('typescript').Type | null>;
	typeFromTypeNodeCache: Map<Node, import('typescript').Type | null>;
	indexInfosCache?: Map<object, unknown | null>;
	propertiesOfTypeCache?: Map<object, unknown | null>;
	contextualTypeCache?: Map<Node, import('typescript').Type | null>;
	nodeToSymbol?: Map<Node, unknown>;
	typeOfSymbolCache?: Map<object, import('typescript').Type | null>;
	resolvedSignatureCache?: Map<Node, import('typescript').Signature | null>;
};

export type TypePrefetchDeps = {
	astSyntaxKind: Record<string, number>;
	fixupType: (t: unknown) => unknown;
	rpcCall: <T>(method: string, fn: () => T) => T;
	rpc?: RpcProfile;
	caches: TypePrefetchCaches;
	/** In-process bind resolver — skip RPC for identifiers it can answer. */
	jsSymbolResolver?: {
		resolveIdentifier(
			tsgoNode: { kind: number; pos: number; end: number },
			fileName: string,
			text: string,
		): unknown | undefined;
	};
	fileText?: string;
};

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
	typesOfSymbols: number;
	typeAtLocations: number;
} {
	const empty = {
		typeAtPosition: 0,
		typeFromTypeNode: 0,
		indexInfos: 0,
		symbolsAtPosition: 0,
		contextualTypes: 0,
		propertiesOfType: 0,
		typesOfSymbols: 0,
		typeAtLocations: 0,
	};
	if (!plan.memberAccess && !plan.typeAssertions && !plan.symbolFallback
		&& !plan.contextualCalls && !plan.propertiesOfType) {
		return empty;
	}

	const SK = deps.astSyntaxKind;
	const { caches, fixupType, rpcCall } = deps;
	const tsgoSymbolsForTypeBatch = new Set<{ id: number }>();

	const memberAccessNodes: Node[] = [];
	const typeAnnotationNodes: Node[] = [];
	const contextualNodes: Node[] = [];
	const callLikeNodes: Node[] = [];
	const unresolvedSymbolNodes: Node[] = [];
	const seenTypeNodes = new Set<Node>();

	const visit = (node: Node) => {
		const k = node.kind;
		if (plan.memberAccess
			&& (k === SK.PropertyAccessExpression || k === SK.ElementAccessExpression)) {
			memberAccessNodes.push(node);
		}
		if (plan.contextualCalls || plan.memberAccess) {
			if (k === SK.CallExpression || k === SK.NewExpression) {
				callLikeNodes.push(node);
			}
		}
		if (plan.contextualCalls
			&& (k === SK.CallExpression || k === SK.ArrowFunctionExpression)) {
			contextualNodes.push(node);
		}
		if (plan.symbolFallback && k === SK.Identifier && caches.nodeToSymbol
			&& deps.jsSymbolResolver && deps.fileText && !caches.nodeToSymbol.has(node)) {
			const pos = (node as unknown as { pos?: number }).pos ?? node.end;
			const local = deps.jsSymbolResolver.resolveIdentifier(
				{ kind: node.kind, pos, end: node.end },
				fileName,
				deps.fileText,
			);
			if (local) {
				caches.nodeToSymbol.set(node, local);
			}
			else {
				unresolvedSymbolNodes.push(node);
			}
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
	let typesOfSymbols = 0;
	let typeAtLocations = 0;

	// Symbol batch first — JS bind, then position batch for misses.
	if (plan.symbolFallback && caches.nodeToSymbol) {
		for (const nodes of chunk(unresolvedSymbolNodes, BATCH_CHUNK)) {
			if (nodes.length === 0) continue;
			try {
				const positions = nodes.map(n => n.end);
				const syms = rpcCall('getSymbolsAtPositions(batch)', () =>
					project.checker.getSymbolAtPosition(fileName, positions)) as unknown as unknown[];
				for (let j = 0; j < nodes.length; j++) {
					const node = nodes[j];
					if (caches.nodeToSymbol!.has(node)) continue;
					const sym = syms[j];
					caches.nodeToSymbol!.set(node, sym ?? undefined);
					symbolsAtPosition++;
					if (isTsgoSymbol(sym)) tsgoSymbolsForTypeBatch.add(sym);
				}
			}
			catch { /* lazy fallback at lint time */ }
		}
	}

	// Call/New batch getTypeAtLocation — bypasses computeGetTypeAtLocation's
	// multi-RPC signature dance for the hottest node kinds.
	if ((plan.contextualCalls || plan.memberAccess) && callLikeNodes.length > 0) {
		for (const nodes of chunk(callLikeNodes, BATCH_CHUNK)) {
			const pending = nodes.filter(n => !caches.nodeTypeCache.has(n));
			if (pending.length === 0) continue;
			try {
				const types = rpcCall('getTypeAtLocations(batch)', () =>
					project.checker.getTypeAtLocation(pending)) as unknown as unknown[];
				for (let j = 0; j < pending.length; j++) {
					const node = pending[j];
					const raw = types[j];
					if (raw) fixupType(raw);
					caches.nodeTypeCache.set(
						node,
						raw ? raw as unknown as import('typescript').Type : null,
					);
					typeAtLocations++;
				}
			}
			catch { /* lazy fallback at lint time */ }
		}
	}

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

	if (caches.typeOfSymbolCache && tsgoSymbolsForTypeBatch.size > 0) {
		const pending = [...tsgoSymbolsForTypeBatch].filter(
			s => !caches.typeOfSymbolCache!.has(s as object),
		);
		for (const symbols of chunk(pending, BATCH_CHUNK)) {
			if (symbols.length === 0) continue;
			try {
				const types = rpcCall('getTypesOfSymbols(batch)', () =>
					project.checker.getTypeOfSymbol(symbols as any)) as unknown as unknown[];
				for (let j = 0; j < symbols.length; j++) {
					const sym = symbols[j];
					if (caches.typeOfSymbolCache!.has(sym as object)) continue;
					const raw = types[j];
					if (raw) fixupType(raw);
					caches.typeOfSymbolCache!.set(
						sym as object,
						raw ? raw as unknown as import('typescript').Type : null,
					);
					typesOfSymbols++;
				}
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
		typesOfSymbols,
		typeAtLocations,
	};
}
