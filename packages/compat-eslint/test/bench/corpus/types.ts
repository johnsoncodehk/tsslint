// Patterns: conditional types with `infer`, import-type expressions
// (single + chained qualifier), interface forward references.
// Hits: conditional-type scope collects InferTypeNode parameters
// (no-undef on TName / I); TSImportType qualifier skipped from free
// references (no-undef on Profiler / Session); use-before-define on
// type forward refs is allowed by ignoreTypeReferences default.

// `infer` type parameter must be in scope of trueType (and any nested
// conditional inside it).
export type ExtractName<T> = T extends { name: infer TName }
	? TName extends string ? TName : never
	: never;

// `UnionToIntersection` style — `infer I` used inline.
export type UnionToIntersection<U> = (U extends any ? (k: U) => void : never) extends ((k: infer I) => void) ? I : never;

// `import("X").Y` — qualifier names exports of imported module, not
// locals. TSImportType visitor must skip the qualifier chain.
type SessionType = import("inspector").Session;
type ProfilerProfile = import("inspector").Profiler.Profile;

export function check(): SessionType | ProfilerProfile {
	return null as any;
}

// Forward reference inside a type — no-use-before-define with
// ignoreTypeReferences default true MUST NOT report.
export interface First {
	readonly nested: Type;
}

export interface Type {
	readonly flag: number;
}
