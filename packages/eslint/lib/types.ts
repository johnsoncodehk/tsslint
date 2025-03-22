export type S = 'error' | 'warn' | 'suggestion' | 'off' | 0 | 1 | 2;
export type O<T extends any[]> = S | [S, ...options: T];

export interface ESLintRulesConfig {
	[key: string]: O<any[]>;
}
