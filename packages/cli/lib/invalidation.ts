// Decides which cached lint results are still valid, the way `tsc --incremental`
// decides which files to re-check. A file's result is reused when the file is
// unchanged and none of the files it depends on changed their declaration
// signature (their `.d.ts` emit), so an edit inside a function body re-lints
// only that file. A changed signature re-lints the direct importers, and keeps
// propagating only while their signatures change too.
//
// A rule can also read another file beyond its declarations (e.g. the body of
// a function it calls). The file's result then also depends on that file's
// full text, and on what that file's own types depend on.
//
// Some changes can affect any file; they re-lint everything:
//   - compiler options, tsconfig files, content mappers, config and rule modules
//   - files added to or removed from the program, or changes under `node_modules`
//   - a changed signature of a file that declares globals or augments modules,
//     or a file starting or stopping to do so

import crypto = require('crypto');
import fs = require('fs');
import path = require('path');
import type { SourceFile } from 'typescript/ast';
import type { API, Program, Project } from 'typescript/sync';
import type { CacheData, GraphNode } from './cache.js';

const CHUNK_SIZE = 500;

interface FileInfo {
	deps: string[];
	global: boolean;
	// How each module specifier and reference in the file resolved; `null`
	// when it points outside the graph.
	references: Map<string, string | null>;
}

export function invalidate(
	api: API,
	project: Project,
	cache: CacheData,
	configModulesKey: string,
	fileHashes: Map<string, string>,
) {
	const program = project.program;
	const ownFiles = new Map<string, fs.Stats>();
	const globalHash = crypto.createHash('sha256');
	globalHash.update(JSON.stringify(program.getCompilerOptions()));
	globalHash.update(`\0${configModulesKey}`);
	for (const configFile of program.getConfigFileNames()) {
		globalHash.update(`\0${configFile}\0${readFile(configFile)}`);
		updateContentMappersHash(api, globalHash, configFile);
	}
	for (const fileName of [...program.getSourceFileNames()].sort()) {
		const stat = fs.statSync(fileName, { throwIfNoEntry: false });
		if (fileName.includes('/node_modules/')) {
			globalHash.update(`\0${fileName}\0${stat?.mtimeMs ?? -1}\0${stat?.size ?? -1}`);
		}
		else {
			// Bundled lib files have no on-disk path; the TS version in the
			// cache path covers them.
			globalHash.update(`\0${fileName}`);
			if (stat) {
				ownFiles.set(fileName, stat);
			}
		}
	}
	const globalKey = globalHash.digest('hex');

	const changed: string[] = [];
	for (const [fileName, stat] of ownFiles) {
		const node = cache.graph[fileName];
		if (!node || node.mtime !== stat.mtimeMs || node.size !== stat.size) {
			changed.push(fileName);
		}
	}

	if (cache.globalKey !== globalKey) {
		return rebuild();
	}
	if (!changed.length) {
		return;
	}
	const infos = analyze(api, program, changed, ownFiles);
	if (
		changed.some(fileName => {
			const node = cache.graph[fileName];
			return !node || node.global !== infos.get(fileName)!.global;
		})
	) {
		return rebuild(infos);
	}

	const oldSignatures = new Map<string, string | undefined>();
	for (const fileName of changed) {
		oldSignatures.set(fileName, cache.graph[fileName]?.signature);
		setNode(cache, fileName, ownFiles.get(fileName)!, infos.get(fileName)!);
	}
	const importers = getImporters(cache);
	const changedSet = new Set(changed);
	const dirty = new Set(changed);
	const signatureChanged = new Set<string>();
	const declarations = new Map<string, string | undefined>();
	const signatures = new Map<string, string>();

	let queue = changed;
	while (queue.length) {
		const wave = [...new Set(queue)].filter(fileName => !signatureChanged.has(fileName));
		queue = [];
		const unanalyzed = wave.filter(fileName => !infos.has(fileName));
		if (unanalyzed.length) {
			for (const [fileName, info] of analyze(api, program, unanalyzed, ownFiles)) {
				infos.set(fileName, info);
			}
		}
		const unemitted = wave.filter(fileName => !signatures.has(fileName));
		for (const [fileName, declaration] of getDeclarations(api, program, unemitted)) {
			declarations.set(fileName, declaration.declaration);
			signatures.set(fileName, declaration.signature);
			if (!changedSet.has(fileName)) {
				oldSignatures.set(fileName, cache.graph[fileName].signature);
			}
		}
		// A file in this wave can reference another one that turns out to
		// change, so repeat until nothing new changes.
		let progress = true;
		while (progress) {
			progress = false;
			for (const fileName of wave) {
				if (signatureChanged.has(fileName) || !hasSignatureChanged(fileName)) {
					continue;
				}
				signatureChanged.add(fileName);
				progress = true;
				for (const importer of importers.get(fileName) ?? []) {
					dirty.add(importer);
					if (!signatureChanged.has(importer)) {
						queue.push(importer);
					}
				}
			}
		}
	}

	for (const [fileName, signature] of signatures) {
		cache.graph[fileName].signature = signature;
	}
	updateMissingSignatures(api, program, cache, importers);
	// The graph stays valid; only the results can't be reused.
	if ([...signatureChanged].some(fileName => cache.graph[fileName].global)) {
		cache.files = {};
		return;
	}
	// A file read for its syntax only matters through its text and its
	// types, not through what its own rules read.
	const retyped = new Set(dirty);
	for (const [fileName, entry] of Object.entries(cache.files)) {
		if (dirty.has(fileName)) {
			continue;
		}
		for (const [touched, textHash] of Object.entries(entry.touched)) {
			if (changedSet.has(touched) ? hashFile(touched, fileHashes) !== textHash : retyped.has(touched)) {
				dirty.add(fileName);
				break;
			}
		}
	}
	for (const fileName of dirty) {
		delete cache.files[fileName];
	}

	function rebuild(known?: Map<string, FileInfo>) {
		cache.globalKey = globalKey;
		cache.files = {};
		cache.graph = {};
		const all = [...ownFiles.keys()];
		const allInfos = analyze(api, program, all, ownFiles, known);
		for (const fileName of all) {
			setNode(cache, fileName, ownFiles.get(fileName)!, allInfos.get(fileName)!);
		}
		updateMissingSignatures(api, program, cache);
	}

	function hasSignatureChanged(fileName: string) {
		const oldSignature = oldSignatures.get(fileName);
		if (oldSignature === undefined || oldSignature !== signatures.get(fileName)) {
			return true;
		}
		const declaration = declarations.get(fileName);
		if (declaration === undefined) {
			// No declaration emit to compare: its types may still change
			// through a dependency.
			return !changedSet.has(fileName);
		}
		// The text can stay the same while the types it names change, e.g.
		// `typeof import("./a").f` after `f`'s return type changed in `a`.
		const references = infos.get(fileName)!.references;
		for (const specifier of getReferencedSpecifiers(declaration)) {
			const target = references.get(specifier);
			if (target === undefined || (target !== null && signatureChanged.has(target))) {
				return true;
			}
		}
		return false;
	}
}

function setNode(cache: CacheData, fileName: string, stat: fs.Stats, info: FileInfo) {
	const node: GraphNode = { mtime: stat.mtimeMs, size: stat.size, deps: info.deps, global: info.global };
	const signature = cache.graph[fileName]?.signature;
	if (signature !== undefined) {
		node.signature = signature;
	}
	cache.graph[fileName] = node;
}

function getImporters(cache: CacheData) {
	const importers = new Map<string, Set<string>>();
	for (const [fileName, node] of Object.entries(cache.graph)) {
		for (const dep of node.deps) {
			let set = importers.get(dep);
			if (!set) {
				importers.set(dep, set = new Set());
			}
			set.add(fileName);
		}
	}
	return importers;
}

// Signatures are only compared for files other files depend on, and for
// files that declare globals.
function updateMissingSignatures(
	api: API,
	program: Program,
	cache: CacheData,
	importers = getImporters(cache),
) {
	const missing: string[] = [];
	for (const [fileName, node] of Object.entries(cache.graph)) {
		if (!importers.has(fileName) && !node.global) {
			delete node.signature;
		}
		else if (node.signature === undefined) {
			missing.push(fileName);
		}
	}
	for (const [fileName, { signature }] of getDeclarations(api, program, missing)) {
		cache.graph[fileName].signature = signature;
	}
}

function analyze(
	api: API,
	program: Program,
	fileNames: string[],
	ownFiles: Map<string, fs.Stats>,
	known?: Map<string, FileInfo>,
) {
	const infos = new Map<string, FileInfo>();
	const pending: string[] = [];
	for (const fileName of fileNames) {
		const info = known?.get(fileName);
		if (info) {
			infos.set(fileName, info);
		}
		else {
			pending.push(fileName);
		}
	}
	for (let i = 0; i < pending.length; i += CHUNK_SIZE) {
		const files = api.batch(...pending.slice(i, i + CHUNK_SIZE).map(fileName => program.getSourceFile.gen(fileName)))
			.filter((file): file is SourceFile => !!file);
		const requests = files.flatMap(file => [
			...file.imports.map(specifier =>
				program.getResolvedModuleFromModuleSpecifier.gen(specifier as any, file.fileName)
			),
			...file.typeReferenceDirectives.map(ref =>
				program.getResolvedTypeReferenceDirectiveFromTypeReferenceDirective.gen(ref, file.fileName)
			),
		]);
		const resolved = api.batch(...requests) as ({ resolvedFileName: string } | undefined)[];
		let index = 0;
		const targets = files.map(file => {
			const fileTargets: [specifier: string, target: string | undefined][] = [];
			for (const specifier of file.imports) {
				fileTargets.push([(specifier as unknown as { text: string }).text, resolved[index++]?.resolvedFileName]);
			}
			for (const ref of file.typeReferenceDirectives) {
				fileTargets.push([ref.fileName, resolved[index++]?.resolvedFileName]);
			}
			const dir = path.dirname(file.fileName);
			for (const ref of file.referencedFiles) {
				const base = path.resolve(dir, ref.fileName);
				fileTargets.push([
					ref.fileName,
					[base, base + '.ts', base + '.tsx', base + '.d.ts'].find(f => fs.existsSync(f)),
				]);
			}
			return fileTargets;
		});
		// A resolution can spell a program file differently than the program
		// does (e.g. through a symlinked directory); the program's own lookup
		// gives its name.
		const unknown = [
			...new Set(
				targets.flat()
					.map(([, target]) => target)
					.filter((target): target is string =>
						target !== undefined && !ownFiles.has(target) && !target.includes('/node_modules/')
					),
			),
		];
		const programNames = new Map<string, string | undefined>();
		api.batch(...unknown.map(target => program.getSourceFile.gen(target))).forEach((file, i) => {
			programNames.set(unknown[i], file?.fileName);
		});
		files.forEach((file, i) => {
			const deps = new Set<string>();
			const references = new Map<string, string | null>();
			for (const [specifier, target] of targets[i]) {
				const name = target !== undefined && programNames.has(target) ? programNames.get(target) : target;
				const dep = name !== undefined && ownFiles.has(name) ? name : null;
				if (dep !== null && dep !== file.fileName) {
					deps.add(dep);
				}
				// The same specifier can resolve differently per resolution
				// mode; keep any in-graph target.
				if (!references.get(specifier)) {
					references.set(specifier, dep);
				}
			}
			infos.set(file.fileName, {
				deps: [...deps],
				global: !file.fileName.endsWith('.json') && (
					!file.externalModuleIndicator
					|| file.moduleAugmentations.length > 0
					|| file.ambientModuleNames.length > 0
				),
				references,
			});
		});
	}
	return infos;
}

// The declaration emit of each file, and its signature: a hash of the
// declaration, or of the text when the file has none to compare.
function getDeclarations(api: API, program: Program, fileNames: string[]) {
	const result = new Map<string, { declaration: string | undefined; signature: string }>();
	for (let i = 0; i < fileNames.length; i += CHUNK_SIZE) {
		const files = api.batch(...fileNames.slice(i, i + CHUNK_SIZE).map(fileName => program.getSourceFile.gen(fileName)))
			.filter((file): file is SourceFile => !!file);
		const emitted = files.filter(file => !file.isDeclarationFile);
		const outputs = new Map<string, string[]>();
		if (emitted.length) {
			for (const [outputName, output] of program.getDeclarationEmit(emitted.map(file => file.fileName)).outputFiles) {
				if (output.sourceFileName === undefined || outputName.endsWith('.map')) {
					continue;
				}
				let texts = outputs.get(output.sourceFileName);
				if (!texts) {
					outputs.set(output.sourceFileName, texts = []);
				}
				texts.push(output.text);
			}
		}
		for (const file of files) {
			const declaration = file.isDeclarationFile ? file.text : outputs.get(file.fileName)?.sort().join('\0');
			result.set(file.fileName, { declaration, signature: hash(declaration ?? file.text) });
		}
	}
	return result;
}

const SPECIFIER_PATTERNS = [
	/\bfrom\s*['"]([^'"\n]+)['"]/g,
	// A side-effect import starts a statement; elsewhere `import` followed by
	// a quote can be a string, e.g. `with { 'resolution-mode': 'import' }`.
	/^\s*import\s*['"]([^'"\n]+)['"]/gm,
	/\bimport\s*\(\s*['"]([^'"\n]+)['"]\s*\)/g,
	/\brequire\s*\(\s*['"]([^'"\n]+)['"]\s*\)/g,
	/\/\/\/\s*<reference\s+(?:path|types)\s*=\s*['"]([^'"\n]+)['"]/g,
];

// Over-matching (e.g. inside a string literal type) only re-lints more.
function* getReferencedSpecifiers(declaration: string) {
	for (const pattern of SPECIFIER_PATTERNS) {
		for (const match of declaration.matchAll(pattern)) {
			yield match[1];
		}
	}
}

function updateContentMappersHash(api: API, hash: crypto.Hash, configFile: string) {
	const config = api.readConfigFile(configFile).config as { contentMappers?: unknown } | undefined;
	if (!Array.isArray(config?.contentMappers)) {
		return;
	}
	for (const mapper of config.contentMappers) {
		const name = (mapper as { package?: unknown } | undefined)?.package;
		if (typeof name !== 'string') {
			continue;
		}
		let packageJsonPath: string;
		try {
			packageJsonPath = require.resolve(`${name}/package.json`, { paths: [path.dirname(configFile)] });
		}
		catch {
			hash.update(`\0${name}\0missing`);
			continue;
		}
		const packageJson = readFile(packageJsonPath);
		hash.update(`\0${packageJsonPath}\0${packageJson}`);
		// Files the mapper runs, e.g. `"exec": ["node", "server.js"]`.
		let exec: unknown;
		try {
			exec = JSON.parse(packageJson)?.typescript?.contentMapper?.exec;
		}
		catch {}
		if (!Array.isArray(exec)) {
			continue;
		}
		for (const arg of exec) {
			if (typeof arg !== 'string') {
				continue;
			}
			const fileName = path.resolve(path.dirname(packageJsonPath), arg);
			const stat = fs.statSync(fileName, { throwIfNoEntry: false });
			if (stat?.isFile()) {
				hash.update(`\0${fileName}\0${stat.mtimeMs}\0${stat.size}`);
			}
		}
	}
}

export function hashFile(fileName: string, hashes: Map<string, string>) {
	let fileHash = hashes.get(fileName);
	if (fileHash === undefined) {
		hashes.set(fileName, fileHash = hash(readFile(fileName)));
	}
	return fileHash;
}

function readFile(fileName: string) {
	try {
		return fs.readFileSync(fileName, 'utf8');
	}
	catch {
		return '';
	}
}

function hash(text: string) {
	return crypto.createHash('sha256').update(text).digest('hex');
}
