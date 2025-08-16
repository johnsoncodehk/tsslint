export type O<T extends any[]> = boolean | [boolean, ...options: T];

export interface ESLintRulesConfig {
	[key: string]: O<any[]>;
}
