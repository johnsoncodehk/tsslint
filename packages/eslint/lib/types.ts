type S = 'error' | 'warn' | 'suggestion' | 'off';
type O<T extends any[]> = S | [S, ...options: T];

export interface ESLintRulesConfig {
	[key: string]: O<any[]>;
}
