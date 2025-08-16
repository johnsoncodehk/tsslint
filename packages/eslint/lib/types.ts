export type S = 'off' | 'error' | 'warn' | 'suggestion' | 'message' | 0 | 1 | 2 | 3;
export type O<T extends any[]> = S | [S, ...options: T];

export interface ESLintRulesConfig {
	[key: string]: O<any[]>;
}
