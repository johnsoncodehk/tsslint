// Patterns extracted from dogfood diffs against TSSLint's own codebase.
// Each is a real production-code shape that TSSLint's parity bench
// didn't surface but ESLint reports on. The divergences are baselined —
// they're real bugs but the cost/reward for fixing each is low (no
// real-world rule failure cascade), so we record them and move on.

// === no-loop-func: object method shorthand closing over a let in a for loop ===
// Pattern from packages/compat-eslint/index.ts:323+ — the rule context
// is built per-iteration with method shorthands that close over a `let`
// reassigned by traversal. ESLint reports each method shorthand;
// TSSLint misses (object-literal method shorthand isn't surfaced as a
// "function created in a loop").
type Ctx = { getAncestors(): unknown[]; markUsed(name: string): void };

export function buildContexts(rules: string[]): Ctx[] {
	const out: Ctx[] = [];
	let currentNode: unknown = null;
	for (const _r of rules) {
		const ctx: Ctx = {
			getAncestors() {
				return [currentNode];
			},
			markUsed(name) {
				void name;
				void currentNode;
			},
		};
		out.push(ctx);
		currentNode = _r;
	}
	return out;
}

// === no-lone-blocks: bare block containing a const declaration ===
// Pattern from packages/compat-eslint/lib/ts-scope-manager.ts:704 — the
// block holds a `const` declaration, so ESLint's no-lone-blocks "marks"
// the block as not-redundant (block-scoped binding makes the block
// meaningful). TSSLint over-reports — the rule's mark-via-VariableDeclaration
// pass doesn't pop the block, suggesting our visit order or
// VariableDeclaration.kind handling differs.
export function refsByKey(refsMap: Map<string, unknown[]>, key: string, raw: unknown): void {
	let arr = refsMap.get(key);
	if (!arr) refsMap.set(key, arr = []);
	{
		const ref = { node: raw };
		arr.push(ref);
		void arr.length;
	}
}

// === prefer-const: `for (let key in obj)` where key is never reassigned ===
// Pattern from packages/cli/lib/worker.ts:190.
export function listKeys(host: Record<string, unknown>): string[] {
	const out: string[] = [];
	for (let key in host) {
		out.push(key);
	}
	return out;
}
