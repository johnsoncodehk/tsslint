// RPC / memo counters for tsgo shim profiling. Enable with TSSLINT_TIME_TSGO=1.

export type RpcProfile = {
	record(method: string, ms: number): void;
	memoHit(method: string): void;
	printSummary(label: string): void;
	reset(): void;
};

type Entry = { calls: number; ms: number; memoHits: number };

export function isTsgoRpcProfileEnabled(): boolean {
	return process.env.TSSLINT_TIME_TSGO === '1';
}

export function createRpcProfile(): RpcProfile {
	const stats = new Map<string, Entry>();

	const entry = (method: string): Entry => {
		let e = stats.get(method);
		if (!e) {
			e = { calls: 0, ms: 0, memoHits: 0 };
			stats.set(method, e);
		}
		return e;
	};

	return {
		record(method, ms) {
			const e = entry(method);
			e.calls++;
			e.ms += ms;
		},
		memoHit(method) {
			entry(method).memoHits++;
		},
		printSummary(label) {
			if (stats.size === 0) return;
			const rows = [...stats.entries()]
				.map(([method, e]) => ({
					method,
					...e,
					avg: e.calls ? e.ms / e.calls : 0,
				}))
				.sort((a, b) => b.ms - a.ms);
			const totalCalls = rows.reduce((n, r) => n + r.calls, 0);
			const totalMs = rows.reduce((n, r) => n + r.ms, 0);
			const totalMemo = rows.reduce((n, r) => n + r.memoHits, 0);
			console.error(
				`[tsgo-rpc] ${label}: ${totalCalls} rpc (${totalMs.toFixed(0)}ms)`
				+ (totalMemo ? `, ${totalMemo} memo hits` : ''),
			);
			for (const r of rows.slice(0, 20)) {
				const memo = r.memoHits ? `, memo=${r.memoHits}` : '';
				console.error(
					`[tsgo-rpc]   ${r.method}: calls=${r.calls} `
					+ `ms=${r.ms.toFixed(1)} avg=${r.avg.toFixed(2)}${memo}`,
				);
			}
			if (rows.length > 20) {
				console.error(`[tsgo-rpc]   ... +${rows.length - 20} more methods`);
			}
		},
		reset() {
			stats.clear();
		},
	};
}

/** Memo table: undefined results stored as null. Per-file Map — cleared after each lint. */
export function memoGet<K, V>(
	cache: Map<K, V | null>,
	key: K,
	compute: () => V | undefined,
	onHit?: () => void,
): V | undefined {
	if (cache.has(key)) {
		onHit?.();
		const v = cache.get(key)!;
		return v === null ? undefined : v;
	}
	const v = compute();
	cache.set(key, v === undefined ? null : v);
	return v;
}

export function memoGet2<K1, K2, V>(
	cache: Map<K1, Map<K2, V | null>>,
	k1: K1,
	k2: K2,
	compute: () => V | undefined,
	onHit?: () => void,
): V | undefined {
	let inner = cache.get(k1);
	if (!inner) {
		inner = new Map();
		cache.set(k1, inner);
	}
	return memoGet(inner, k2, compute, onHit);
}
