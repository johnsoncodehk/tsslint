// Records which program files a rule reads while it lints a file, so a cached
// result can depend on them. Declaration-level information (symbols, types,
// signatures) is covered by declaration signatures; this tracks the ways a rule
// can see another file's implementation:
//   - a declaration node, which is only reachable through `NodeHandle.resolve`
//     (symbol, signature and index info declarations, references)
//   - a source file from `program.getSourceFile` / `getSourceFileByPath`
//   - diagnostics or emit of other files from the program
//   - checker queries by file and position

import type { Node } from 'typescript/ast';
import { resolveFileName } from 'typescript/proto';
import { type Checker, NodeHandle, type Program } from 'typescript/sync';

type DocumentIdentifier = Parameters<Program['getSourceFile']>[0];
type Method = ((...args: any[]) => any) & { gen(...args: any[]): Generator<any, any, any> };
type Track = (args: any[], result: any, target: any) => void;

let touched: Set<string> | undefined;

export function collectTouchedFiles(run: () => void): Set<string> {
	const previous = touched;
	const files = touched = new Set();
	try {
		run();
	}
	finally {
		touched = previous;
	}
	return files;
}

const resolveGetter = Object.getOwnPropertyDescriptor(NodeHandle.prototype, 'resolve')!.get!;
Object.defineProperty(NodeHandle.prototype, 'resolve', {
	configurable: true,
	get(this: NodeHandle) {
		// The original getter defines `resolve` on the instance; replace it.
		const resolve = trackMethod(resolveGetter.call(this), (_args, node: Node | undefined) => {
			if (node) {
				touched?.add(node.getSourceFile().fileName);
			}
		});
		Object.defineProperty(this, 'resolve', { configurable: true, value: resolve });
		return resolve;
	},
});

const touchResult: Track = (_args, file: { fileName: string } | undefined) => {
	if (file) {
		touched?.add(file.fileName);
	}
};
const touchFirstArg: Track = args => touchDocuments(args[0]);
const touchFilesOrAll: Track = (args, _result, program: Program) => {
	if (args[0] === undefined) {
		touchProgram(program);
	}
	else {
		touchDocuments(args[0]);
	}
};
const touchAll: Track = (_args, _result, program: Program) => touchProgram(program);

const programTracks: Partial<Record<keyof Program, Track>> = {
	getSourceFile: touchResult,
	getSourceFileByPath: touchResult,
	getSyntacticDiagnostics: touchFilesOrAll,
	getBindDiagnostics: touchFilesOrAll,
	getSemanticDiagnostics: touchFilesOrAll,
	getSuggestionDiagnostics: touchFilesOrAll,
	getDeclarationDiagnostics: touchFilesOrAll,
	getGlobalDiagnostics: touchAll,
	getJavaScriptEmit: touchFirstArg,
	getDeclarationEmit: touchFirstArg,
	emit: touchAll,
	emitToString: touchAll,
};
const checkerTracks: Partial<Record<keyof Checker, Track>> = {
	getSymbolAtPosition: touchFirstArg,
	getTypeAtPosition: touchFirstArg,
	getReferencesToSymbolInFile: touchFirstArg,
};

const trackedPrograms = new WeakMap<Program, Program>();
const trackedCheckers = new WeakMap<Checker, Checker>();

export function trackProgram(program: Program): Program {
	let tracked = trackedPrograms.get(program);
	if (!tracked) {
		trackedPrograms.set(program, tracked = trackObject(program, programTracks, program));
	}
	return tracked;
}

export function trackChecker(checker: Checker, program: Program): Checker {
	let tracked = trackedCheckers.get(checker);
	if (!tracked) {
		trackedCheckers.set(checker, tracked = trackObject(checker, checkerTracks, program));
	}
	return tracked;
}

function trackObject<T extends object>(object: T, tracks: Partial<Record<keyof T, Track>>, program: Program): T {
	const methods = new Map<PropertyKey, unknown>();
	return new Proxy(object, {
		get(target, key) {
			const value: unknown = Reflect.get(target, key, target);
			if (typeof value !== 'function') {
				return value;
			}
			let method = methods.get(key);
			if (!method) {
				const track = tracks[key as keyof T];
				// API methods with a `gen` form are closures over their owner.
				method = track
					? trackMethod(value as Method, (args, result) => track(args, result, program))
					: 'gen' in value
					? value
					: value.bind(target);
				methods.set(key, method);
			}
			return method;
		},
	});
}

function trackMethod(method: Method, track: (args: any[], result: any) => void): Method {
	return Object.assign((...args: any[]) => {
		const result = method(...args);
		track(args, result);
		return result;
	}, {
		*gen(...args: any[]) {
			const result = yield* method.gen(...args);
			track(args, result);
			return result;
		},
	});
}

function touchProgram(program: Program) {
	if (!touched) {
		return;
	}
	for (const fileName of program.getSourceFileNames()) {
		touched.add(fileName);
	}
}

function touchDocuments(documents: DocumentIdentifier | readonly DocumentIdentifier[]) {
	if (!touched) {
		return;
	}
	for (const document of Array.isArray(documents) ? documents : [documents]) {
		touched.add(resolveFileName(document));
	}
}
