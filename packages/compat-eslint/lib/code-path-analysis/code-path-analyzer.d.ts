declare class CodePathAnalyzer {
	constructor(eventGenerator: {
		emit?: (name: string, args: unknown[]) => void;
		emitter?: { emit(name: string, ...args: unknown[]): void };
		enterNode(node: unknown): void;
		leaveNode(node: unknown): void;
	});
	enterNode(node: unknown): void;
	leaveNode(node: unknown): void;
}

export = CodePathAnalyzer;
