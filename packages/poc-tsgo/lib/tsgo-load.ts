// Resolve @typescript/native-preview subpaths across export layouts:
//   legacy:  @typescript/native-preview/sync
//   current: @typescript/native-preview/unstable/sync

const SYNC_CANDIDATES = ['unstable/sync', 'sync'] as const;
const AST_CANDIDATES = ['unstable/ast', 'ast'] as const;
const AST_FACTORY_CANDIDATES = ['unstable/ast/factory', 'ast/factory'] as const;

export type TsgoModules = {
	sync: typeof import('@typescript/native-preview/unstable/sync', { with: { 'resolution-mode': 'import' } });
	ast: typeof import('@typescript/native-preview/unstable/ast', { with: { 'resolution-mode': 'import' } });
	astFactory: typeof import('@typescript/native-preview/unstable/ast/factory', { with: { 'resolution-mode': 'import' } });
	/** Which export layout was resolved. */
	layout: 'unstable' | 'legacy';
};

let cached: TsgoModules | undefined;

function resolveSubpath(candidates: readonly string[]): string {
	for (const sub of candidates) {
		try {
			require.resolve(`@typescript/native-preview/${sub}`);
			return sub;
		}
		catch {
			// try next
		}
	}
	throw new Error('@typescript/native-preview not installed or unsupported export layout');
}

export function hasNativePreview(): boolean {
	try {
		resolveSubpath(SYNC_CANDIDATES);
		return true;
	}
	catch {
		return false;
	}
}

export function loadTsgoModules(): TsgoModules {
	if (cached) return cached;
	const syncSub = resolveSubpath(SYNC_CANDIDATES);
	const astSub = resolveSubpath(AST_CANDIDATES);
	const factorySub = resolveSubpath(AST_FACTORY_CANDIDATES);
	cached = {
		sync: require(`@typescript/native-preview/${syncSub}`),
		ast: require(`@typescript/native-preview/${astSub}`),
		astFactory: require(`@typescript/native-preview/${factorySub}`),
		layout: syncSub.startsWith('unstable/') ? 'unstable' : 'legacy',
	};
	return cached;
}
