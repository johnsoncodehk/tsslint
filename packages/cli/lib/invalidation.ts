// Decides which cached lint results are still valid, the way `tsc --incremental`
// decides which files to re-check. A file's result is reused when the file is
// unchanged and none of the names it imports changed their types, so an edit
// inside a function body re-lints only that file.
//
// Each module other files depend on keeps, per export and per top-level
// declaration, a hash of its declaration emit and what it references: the
// declarations and imports the checker resolves its identifiers to, and the
// exports of other modules these name. A name's types changed when its own
// hash changed, or when one it references changed, also across files and
// through cycles; that is, when a hash it reaches changed, as if each name
// hashed the hashes of what it references. References are read from the
// source, not the declaration emit, so they stay valid while a dependency
// changes the emit of an unchanged file, and only once a change can reach
// the module.
//
// What can't be told apart counts as more, never less:
//   - a namespace import, `import =`, `import('./a')` and a module specifier
//     no declaration accounts for reference the whole module
//   - an identifier the checker resolves to nothing references every
//     top-level name of its text
//   - a declaration only the emit has (e.g. `_default`) references what
//     `export default` / `export =` does, or every dep
//   - a JS, JSON, script or UMD file, or one without a single declaration
//     output, is one name referencing the whole of every dep
//   - an unchanged file whose name went stale counts it as changed again
//     on its next edit
//
// A rule can also read another file beyond its declarations (e.g. the body of
// a function it calls). The file's result then also depends on that file's
// full text, and on what that file's own types depend on.
//
// Some changes can affect any file; they re-lint everything:
//   - compiler options, tsconfig files, content mappers, config and rule modules
//   - files added to or removed from the program, or changes under `node_modules`
//   - a changed signature of a script or a UMD module (`export as namespace`)
//   - a changed `declare global` / `declare module '...'` block, or a changed
//     name its blocks use: an import, a declaration of the module itself, or
//     any export of the augmented module
//   - a file starting or stopping to declare globals

import crypto = require('crypto');
import fs = require('fs');
import path = require('path');
import * as ts from 'typescript/ast';
import type { API, Checker, Project } from 'typescript/sync';
import type { CacheData, GraphNode } from './cache.js';

const CHUNK_SIZE = 500;
// Keys in `GraphNode.names` beside export names, which are identifiers or
// string literals; neither can hold `\0`.
const LOCAL = '\0';
const STAR = '\0*';
// The whole module: every export, also through `export *`.
const ALL = '\0\0';
// Stands for a module specifier that did not resolve; always changed.
const UNKNOWN = '';

interface Declaration {
	fileName: string;
	text: string;
}

interface FileInfo {
	deps: string[];
	// Per dep, the export names the file imports from it.
	uses: string[][];
	global: boolean;
	// For a module with `declare global` / `declare module '...'` blocks; a
	// script or a UMD module is global as a whole.
	scope?: Scope;
	// How each module specifier and reference in the file resolved; `null`
	// when it points outside the graph.
	references: Map<string, string | null>;
}

interface Scope {
	// Hash of the blocks' text.
	hash: string;
	// What the blocks use, as references.
	refs: string[];
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
	const infos = analyze(api, project, changed, ownFiles);
	if (
		changed.some(fileName => {
			const node = cache.graph[fileName];
			return !node || node.global !== infos.get(fileName)!.global;
		})
	) {
		return rebuild(infos);
	}

	const previous = new Map<string, GraphNode>();
	let scopeChanged = false;
	for (const fileName of changed) {
		previous.set(fileName, cache.graph[fileName]);
		scopeChanged ||= cache.graph[fileName].scope !== infos.get(fileName)!.scope?.hash;
		setNode(cache, fileName, ownFiles.get(fileName)!, infos.get(fileName)!);
	}
	const importers = updateNames(api, project, cache, ownFiles, infos);

	const changedSet = new Set(changed);
	const graph = createGraph(
		cache,
		previous,
		importers,
		fileNames => readPendingRefs(api, project, cache, ownFiles, infos, fileNames),
	);
	const used = new Map<string, string[]>();
	for (const fileName of Object.keys(cache.files)) {
		const node = cache.graph[fileName];
		if (node && !changedSet.has(fileName)) {
			used.set(fileName, node.deps.flatMap((dep, i) => (node.uses?.[i] ?? [ALL]).map(name => graph.get(dep, name))));
		}
	}
	const globals: string[] = [];
	for (const [fileName, node] of Object.entries(cache.graph)) {
		if (node.global) {
			globals.push(...node.scopeRefs?.map(ref => graph.resolve(fileName, ref)) ?? [graph.get(fileName, ALL)]);
		}
	}
	const changedNames = graph.solve();
	markChanged(cache, previous, changedNames);
	// The graph stays valid; only the results can't be reused.
	if (scopeChanged || globals.some(id => changedNames.has(id))) {
		cache.files = {};
		return;
	}
	const dirty = new Set(changed);
	for (const [fileName, ids] of used) {
		if (ids.some(id => changedNames.has(id))) {
			dirty.add(fileName);
		}
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
		const allInfos = analyze(api, project, all, ownFiles, known);
		for (const fileName of all) {
			setNode(cache, fileName, ownFiles.get(fileName)!, allInfos.get(fileName)!);
		}
		updateNames(api, project, cache, ownFiles, allInfos);
	}
}

function setNode(cache: CacheData, fileName: string, stat: fs.Stats, info: FileInfo) {
	const node: GraphNode = {
		mtime: stat.mtimeMs,
		size: stat.size,
		deps: info.deps,
		uses: info.uses,
		global: info.global,
	};
	if (info.scope) {
		node.scope = info.scope.hash;
		node.scopeRefs = info.scope.refs;
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

// Signatures and names are only kept for files other files depend on, and
// for files that declare globals.
function updateNames(
	api: API,
	project: Project,
	cache: CacheData,
	ownFiles: Map<string, fs.Stats>,
	infos: Map<string, FileInfo>,
) {
	const importers = getImporters(cache);
	const missing: string[] = [];
	for (const [fileName, node] of Object.entries(cache.graph)) {
		if (!importers.has(fileName) && !node.global) {
			delete node.signature;
			delete node.names;
			delete node.pending;
		}
		else if (node.signature === undefined) {
			missing.push(fileName);
		}
	}
	const unanalyzed = missing.filter(fileName => !infos.has(fileName));
	for (const [fileName, info] of analyze(api, project, unanalyzed, ownFiles)) {
		infos.set(fileName, info);
	}
	const entries: [string, Declaration[] | undefined][] = [];
	for (const [fileName, { declaration, signature }] of getDeclarations(api, project, missing)) {
		cache.graph[fileName].signature = signature;
		entries.push([fileName, declaration]);
	}
	for (const [fileName, read] of getNames(api, project, entries, infos, cache)) {
		const node = cache.graph[fileName];
		delete node.pending;
		if (read) {
			node.names = read.names;
			if (read.pending.length) {
				node.pending = read.pending;
			}
		}
		else {
			delete node.names;
		}
	}
	return importers;
}

function getName(names: Record<string, string[]> | undefined, key: string) {
	return names && Object.hasOwn(names, key) ? names[key] : undefined;
}

function isLocal(key: string) {
	return key.startsWith(LOCAL) && key !== STAR && key !== ALL;
}

// The names of all files as one graph, from each name to what it
// references. A file without names (a script, a JS or JSON file, or one
// without a single declaration output) is one node, which references the
// whole of every file it depends on.
//
// A name references names of its own file and of the files it depends on,
// and a name found through `export *` those of the re-exported files. So a
// file's names can only change when a name of the file, of a dep, or of a
// file a dep re-exports changed, or when one references a module specifier
// that did not resolve; the graph only reads the names of such files, and
// reads the references of a file whose names were stored without them
// (`GraphNode.pending`) then. Those can't name an unresolved specifier: the
// source only names those of `file.imports`, which all resolved or point
// outside the graph.
function createGraph(
	cache: CacheData,
	previous: Map<string, GraphNode>,
	importers: Map<string, Set<string>>,
	readRefs: (fileNames: string[]) => void,
) {
	const dependents = new Map<string, string[]>();
	// Per file, each name added so far, by id.
	const added = new Map<string, Map<string, string>>();
	const expanded = new Set<string>();
	const pending: [id: string, fileName: string, key: string][] = [];
	const result = new Set<string>();
	const queue: string[] = [];
	const get = (fileName: string, key: string) => {
		const names = cache.graph[fileName]?.names;
		if (!names || (key.startsWith(LOCAL) && key !== ALL && !getName(names, key))) {
			key = ALL;
		}
		const id = fileName + '\0' + key;
		let ids = added.get(fileName);
		if (!ids) {
			added.set(fileName, ids = new Map());
		}
		if (!ids.has(id)) {
			ids.set(id, key);
			if (expanded.has(fileName)) {
				pending.push([id, fileName, key]);
			}
		}
		return id;
	};
	const resolve = (fileName: string, ref: string, key?: string) => {
		if (ref === UNKNOWN) {
			return UNKNOWN;
		}
		const separator = ref.indexOf('\0');
		if (separator <= 0) {
			return get(fileName, key ?? ref);
		}
		const dep = cache.graph[fileName].deps[+ref.slice(0, separator)];
		return dep === undefined ? UNKNOWN : get(dep, key ?? ref.slice(separator + 1));
	};
	const mark = (id: string) => {
		if (!result.has(id)) {
			result.add(id);
			queue.push(id);
		}
	};
	const link = (from: string, to: string) => {
		let list = dependents.get(to);
		if (!list) {
			dependents.set(to, list = []);
		}
		list.push(from);
		if (result.has(to)) {
			mark(from);
		}
	};
	const expand = (id: string, fileName: string, key: string) => {
		const node = cache.graph[fileName];
		const names = node?.names;
		if (!names) {
			for (const dep of node?.deps ?? []) {
				link(id, get(dep, ALL));
			}
			return;
		}
		const stars = getName(names, STAR)?.slice(1) ?? [];
		if (key === ALL) {
			const keys = new Set([...Object.keys(names), ...Object.keys(previous.get(fileName)?.names ?? {})]);
			for (const name of keys) {
				if (!isLocal(name)) {
					link(id, get(fileName, name));
				}
			}
			for (const ref of stars) {
				link(id, resolve(fileName, ref));
			}
			return;
		}
		const entry = getName(names, key);
		if (entry) {
			if (key !== STAR) {
				for (const ref of entry.slice(1)) {
					link(id, resolve(fileName, ref));
				}
			}
			return;
		}
		// An export not found by its name comes from `export *`, or from
		// the properties of `export =`.
		if (stars.length) {
			link(id, get(fileName, STAR));
			for (const ref of stars) {
				link(id, resolve(fileName, ref, key));
			}
		}
		if (getName(names, 'export=')) {
			link(id, get(fileName, 'export='));
		}
	};
	const expandFile = (fileName: string) => {
		expanded.add(fileName);
		for (const [id, key] of [...added.get(fileName) ?? []]) {
			pending.push([id, fileName, key]);
		}
		const node = cache.graph[fileName];
		for (const key of Object.keys(node?.names ?? {})) {
			get(fileName, key);
		}
		if (node && !node.names && node.signature !== undefined) {
			get(fileName, ALL);
		}
	};
	return {
		get,
		resolve,
		// Every name whose hash or a hash it reaches changed.
		solve() {
			// Per file, the files that re-export it through `export *`.
			const reexporters = new Map<string, string[]>();
			const requested = new Set<string>();
			let unread: string[] = [];
			const request = (fileName: string) => {
				if (!requested.has(fileName)) {
					requested.add(fileName);
					if (cache.graph[fileName]?.pending) {
						unread.push(fileName);
					}
					else {
						expandFile(fileName);
					}
				}
			};
			// A reference to an unresolved specifier is always changed.
			for (const [fileName, node] of Object.entries(cache.graph)) {
				if (!node.names) {
					continue;
				}
				for (const [key, entry] of Object.entries(node.names)) {
					for (let i = 1; i < entry.length; i++) {
						const ref = entry[i];
						const separator = ref.indexOf('\0');
						const dep = separator > 0 ? node.deps[+ref.slice(0, separator)] : undefined;
						if (ref === UNKNOWN || (separator > 0 && dep === undefined)) {
							request(fileName);
						}
						else if (key === STAR && dep !== undefined) {
							let list = reexporters.get(dep);
							if (!list) {
								reexporters.set(dep, list = []);
							}
							list.push(fileName);
						}
					}
				}
			}
			mark(UNKNOWN);
			for (const [fileName, old] of previous) {
				const { names, signature } = cache.graph[fileName];
				if (!names || !old.names) {
					if (names || old.names || signature === undefined || signature !== old.signature) {
						mark(fileName + '\0' + ALL);
					}
				}
				for (const key of new Set([...Object.keys(names ?? {}), ...Object.keys(old.names ?? {})])) {
					if (getName(names, key)?.[0] !== getName(old.names, key)?.[0]) {
						mark(fileName + '\0' + key);
					}
				}
			}
			const reached = new Set<string>();
			const reach = (fileName: string) => {
				const stack = [fileName];
				request(fileName);
				while (stack.length) {
					const file = stack.pop()!;
					if (reached.has(file)) {
						continue;
					}
					reached.add(file);
					for (const importer of importers.get(file) ?? []) {
						request(importer);
					}
					stack.push(...reexporters.get(file) ?? []);
				}
			};
			while (true) {
				while (pending.length || queue.length) {
					if (pending.length) {
						expand(...pending.pop()!);
						continue;
					}
					const id = queue.pop()!;
					const separator = id.indexOf('\0');
					if (separator > 0) {
						reach(id.slice(0, separator));
					}
					for (const dependent of dependents.get(id) ?? []) {
						mark(dependent);
					}
				}
				if (!unread.length) {
					return result;
				}
				const fileNames = unread;
				unread = [];
				readRefs(fileNames);
				for (const fileName of fileNames) {
					expandFile(fileName);
				}
			}
		},
	};
}

// The declaration emit of an unchanged file goes stale when a name it
// references changes. Clear the hashes of such names, so the next edit of
// the file counts them as changed whatever the new emit is.
function markChanged(cache: CacheData, previous: Map<string, GraphNode>, changedNames: Set<string>) {
	for (const [fileName, node] of Object.entries(cache.graph)) {
		if (previous.has(fileName)) {
			continue;
		}
		if (node.names) {
			for (const [key, entry] of Object.entries(node.names)) {
				if (isLocal(key) && changedNames.has(fileName + '\0' + key)) {
					entry[0] = '';
				}
			}
		}
		else if (node.signature !== undefined && changedNames.has(fileName + '\0' + ALL)) {
			node.signature = '';
		}
	}
}

function analyze(
	api: API,
	project: Project,
	fileNames: string[],
	ownFiles: Map<string, fs.Stats>,
	known?: Map<string, FileInfo>,
	// Whether to read what `declare global` / `declare module '...'` blocks
	// use, as `FileInfo.scope`.
	readScopes = true,
) {
	const { program } = project;
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
			.filter((file): file is ts.SourceFile => !!file);
		// An augmented module needs no import.
		const specifiers = files.map(file =>
			[
				...file.imports,
				...file.moduleAugmentations.filter(name => ts.isStringLiteral(name)),
			] as unknown as ts.StringLiteral[]
		);
		const requests = files.flatMap((file, i) => [
			...specifiers[i].map(specifier =>
				program.getResolvedModuleFromModuleSpecifier.gen(specifier as any, file.fileName)
			),
			...file.typeReferenceDirectives.map(ref =>
				program.getResolvedTypeReferenceDirectiveFromTypeReferenceDirective.gen(ref, file.fileName)
			),
		]);
		const resolved = api.batch(...requests) as ({ resolvedFileName: string } | undefined)[];
		let index = 0;
		const targets = files.map((file, i) => {
			const fileTargets: [specifier: string, target: string | undefined][] = [];
			for (const specifier of specifiers[i]) {
				fileTargets.push([specifier.text, resolved[index++]?.resolvedFileName]);
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
		const scoped: [ts.SourceFile, FileInfo][] = [];
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
			const info: FileInfo = {
				deps: [...deps],
				uses: getUses(file, specifiers[i], references, [...deps]),
				global: false,
				references,
			};
			if (!file.fileName.endsWith('.json')) {
				if (!file.externalModuleIndicator || file.statements.some(ts.isNamespaceExportDeclaration)) {
					info.global = true;
				}
				else if (file.moduleAugmentations.length || file.ambientModuleNames.length) {
					info.global = true;
					if (readScopes) {
						scoped.push([file, info]);
					}
				}
			}
			infos.set(file.fileName, info);
		});
		const scopes = getScopes(api, project.checker, scoped.map(([file]) => file));
		scoped.forEach(([file, info], i) => {
			const { hash, specifiers, imports, locals } = scopes[i];
			const refs = new Set<string>();
			const add = (specifier: string, key: string) => {
				if (info.references.get(specifier) !== file.fileName) {
					const ref = encodeRef(file.fileName, info.references, info.deps, specifier, key);
					if (ref !== undefined) {
						refs.add(ref);
					}
				}
			};
			for (const specifier of specifiers) {
				add(specifier, ALL);
			}
			for (const [specifier, names] of imports) {
				for (const name of names) {
					add(specifier, name);
				}
			}
			for (const name of locals) {
				refs.add(LOCAL + name);
			}
			info.scope = { hash, refs: [...refs] };
		});
	}
	return infos;
}

// A reference to `key` of the module a specifier names: an export name or
// `ALL`. `undefined` for a module outside the graph.
function encodeRef(
	fileName: string,
	references: Map<string, string | null>,
	deps: string[],
	specifier: string,
	key: string,
) {
	const target = references.get(specifier);
	if (target === undefined) {
		return UNKNOWN;
	}
	if (target === null) {
		return undefined;
	}
	return target === fileName ? key : `${deps.indexOf(target)}\0${key}`;
}

// What the file imports from each dep. A module specifier outside an
// `import` / `export` statement (e.g. `import('./a')`, an import type or an
// augmented module) and a `/// <reference>` use the whole module.
function getUses(
	file: ts.SourceFile,
	specifiers: ts.StringLiteral[],
	references: Map<string, string | null>,
	deps: string[],
) {
	const used = new Map<string, Set<string>>();
	const use = (specifier: string, name?: string) => {
		const target = references.get(specifier);
		if (!target) {
			return;
		}
		let names = used.get(target);
		if (!names) {
			used.set(target, names = new Set());
		}
		if (name !== undefined) {
			names.add(name);
		}
	};
	const attributed = new Set<ts.Node>();
	for (const statement of file.statements) {
		if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) {
			attributed.add(statement.moduleSpecifier);
			const specifier = statement.moduleSpecifier.text;
			const clause = statement.importClause;
			use(specifier);
			if (clause?.name) {
				use(specifier, 'default');
			}
			const named = clause?.namedBindings;
			if (named && ts.isNamespaceImport(named)) {
				use(specifier, ALL);
			}
			else if (named) {
				for (const element of named.elements) {
					use(specifier, (element.propertyName ?? element.name).text);
				}
			}
		}
		else if (
			ts.isExportDeclaration(statement) && statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier)
		) {
			attributed.add(statement.moduleSpecifier);
			const specifier = statement.moduleSpecifier.text;
			const clause = statement.exportClause;
			if (!clause || ts.isNamespaceExport(clause)) {
				use(specifier, ALL);
			}
			else {
				for (const element of clause.elements) {
					use(specifier, (element.propertyName ?? element.name).text);
				}
			}
		}
	}
	for (const specifier of specifiers) {
		if (!attributed.has(specifier)) {
			use(specifier.text, ALL);
		}
	}
	for (const ref of [...file.typeReferenceDirectives, ...file.referencedFiles]) {
		use(ref.fileName, ALL);
	}
	return deps.map(dep => [...used.get(dep) ?? [ALL]]);
}

interface Binding {
	// For an import; the export name is `*` for a whole module.
	specifier?: string;
	name: string;
}

interface ScopeUses {
	hash: string;
	// Module specifiers the blocks name, e.g. the augmented module or an
	// `import('./a')` type.
	specifiers: Set<string>;
	// Export names the blocks use through the imports of each module
	// specifier; `ALL` for a namespace or `import =` binding.
	imports: Map<string, Set<string>>;
	// Names of the module's own declarations the blocks use.
	locals: Set<string>;
}

// What the `declare global` / `declare module '...'` blocks of each file
// use, by resolving every identifier in them to its symbol. Identifiers that
// resolve to neither an import nor a declaration of the module are declared
// by the blocks themselves, globally elsewhere, or in the augmented module,
// which `ScopeUses.specifiers` covers.
function getScopes(api: API, checker: Checker, files: ts.SourceFile[]): ScopeUses[] {
	const collected = files.map(collectScope);
	const requests = collected.filter(({ used }) => used.length);
	const resolved = new Map(
		api.batch(...requests.map(({ bindings, used }) => checker.getSymbolAtLocation.gen([...bindings.keys(), ...used])))
			.map((symbols, i) => [requests[i], symbols]),
	);
	return collected.map(scope => {
		const { hash, specifiers, bindings } = scope;
		const result: ScopeUses = { hash, specifiers, imports: new Map(), locals: new Set() };
		const symbols = resolved.get(scope);
		if (!symbols) {
			return result;
		}
		const byId = new Map<number, Binding>();
		// An identifier the checker resolves to nothing may still be a
		// binding, so it uses every binding of its name.
		const byText = new Map<string, Binding[]>();
		[...bindings].forEach(([node, binding], i) => {
			const symbol = symbols[i];
			if (symbol) {
				byId.set(symbol.id, binding);
			}
			let list = byText.get(node.text);
			if (!list) {
				byText.set(node.text, list = []);
			}
			list.push(binding);
		});
		symbols.slice(bindings.size).forEach((symbol, i) => {
			const found = symbol ? [byId.get(symbol.id)] : byText.get(scope.used[i].text) ?? [];
			for (const binding of found) {
				if (!binding) {
					continue;
				}
				if (binding.specifier === undefined) {
					result.locals.add(binding.name);
					continue;
				}
				let names = result.imports.get(binding.specifier);
				if (!names) {
					result.imports.set(binding.specifier, names = new Set());
				}
				names.add(binding.name);
			}
		});
		return result;
	});
}

function collectScope(file: ts.SourceFile) {
	let text = '';
	const specifiers = new Set<string>();
	const used: ts.Identifier[] = [];
	// The module's imports and declarations outside the blocks, by name node.
	const bindings = new Map<ts.Identifier, Binding>();
	const visitBlock = (node: ts.Node): void => {
		if (ts.isIdentifier(node)) {
			used.push(node);
		}
		else if (ts.isModuleDeclaration(node) && ts.isStringLiteral(node.name)) {
			specifiers.add(node.name.text);
		}
		else if (
			ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) && ts.isStringLiteral(node.argument.literal)
		) {
			specifiers.add(node.argument.literal.text);
		}
		node.forEachChild(visitBlock);
	};
	for (const statement of file.statements) {
		if (isBlock(statement)) {
			text += file.text.slice(statement.pos, statement.end) + '\0';
			visitBlock(statement);
		}
		else if (ts.isImportDeclaration(statement)) {
			const clause = statement.importClause;
			if (!clause || !ts.isStringLiteral(statement.moduleSpecifier)) {
				continue;
			}
			const specifier = statement.moduleSpecifier.text;
			if (clause.name) {
				bindings.set(clause.name, { specifier, name: 'default' });
			}
			const named = clause.namedBindings;
			if (named && ts.isNamespaceImport(named)) {
				bindings.set(named.name, { specifier, name: ALL });
			}
			else if (named) {
				for (const element of named.elements) {
					bindings.set(element.name, { specifier, name: (element.propertyName ?? element.name).text });
				}
			}
		}
		else if (ts.isImportEqualsDeclaration(statement)) {
			const reference = statement.moduleReference;
			bindings.set(
				statement.name,
				ts.isExternalModuleReference(reference) && ts.isStringLiteral(reference.expression)
					? { specifier: reference.expression.text, name: ALL }
					: { name: statement.name.text },
			);
		}
		else {
			visitDeclarations(statement, name => bindings.set(name, { name: name.text }));
		}
	}
	return { hash: hash(text), specifiers, bindings, used };
}

function isBlock(statement: ts.Statement): statement is ts.ModuleDeclaration {
	return ts.isModuleDeclaration(statement) && (ts.isStringLiteral(statement.name) || statement.name.text === 'global');
}

// The declarations of a statement that belong to the module's scope; a
// `var` in a nested statement is also one.
function visitDeclarations(node: ts.Node, declare: (name: ts.Identifier) => void): void {
	if (
		(ts.isVariableDeclaration(node) || ts.isBindingElement(node) || ts.isFunctionDeclaration(node)
			|| ts.isClassDeclaration(node) || ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node)
			|| ts.isEnumDeclaration(node) || ts.isModuleDeclaration(node))
		&& node.name && ts.isIdentifier(node.name)
	) {
		declare(node.name);
	}
	if (!ts.isFunctionLikeDeclaration(node) && !ts.isClassLikeDeclaration(node) && !ts.isModuleDeclaration(node)) {
		node.forEachChild(child => visitDeclarations(child, declare));
	}
}

// The declaration emit of each file, and its signature: a hash of the
// declaration, or of the text when the file has none to compare.
function getDeclarations(api: API, project: Project, fileNames: string[]) {
	const { program } = project;
	const result = new Map<string, { declaration: Declaration[] | undefined; signature: string }>();
	for (let i = 0; i < fileNames.length; i += CHUNK_SIZE) {
		const files = api.batch(...fileNames.slice(i, i + CHUNK_SIZE).map(fileName => program.getSourceFile.gen(fileName)))
			.filter((file): file is ts.SourceFile => !!file);
		const emitted = files.filter(file => !file.isDeclarationFile);
		const outputs = new Map<string, Declaration[]>();
		const collect = (outputFiles: ReturnType<typeof program.getDeclarationEmit>['outputFiles']) => {
			for (const [outputName, output] of outputFiles) {
				if (output.sourceFileName === undefined || outputName.endsWith('.map')) {
					continue;
				}
				let declaration = outputs.get(output.sourceFileName);
				if (!declaration) {
					outputs.set(output.sourceFileName, declaration = []);
				}
				declaration.push({ fileName: outputName, text: output.text });
			}
		};
		if (emitted.length) {
			collect(program.getDeclarationEmit(emitted.map(file => file.fileName)).outputFiles);
		}
		// The program emits no declarations for a file it reached through
		// `node_modules`, e.g. a workspace package or a referenced project's
		// source behind a symlink. As root files of a program with the same
		// options and references they get the declarations this program sees.
		const unemitted = emitted.filter(file => !outputs.has(file.fileName)).map(file => file.fileName);
		if (unemitted.length) {
			const roots = api.createProgram(unemitted, program.getCompilerOptions() as any, {
				projectReferences: project.parsedCommandLine.projectReferences,
			});
			try {
				collect(roots.getDeclarationEmit(unemitted).outputFiles);
			}
			finally {
				roots.dispose();
			}
		}
		for (const file of files) {
			const declaration = file.isDeclarationFile
				? [{ fileName: file.fileName, text: file.text }]
				: outputs.get(file.fileName)?.sort((a, b) => a.text < b.text ? -1 : a.text > b.text ? 1 : 0);
			const text = declaration?.map(output => output.text).join('\0') ?? file.text;
			result.set(file.fileName, { declaration, signature: hash(text) });
		}
	}
	return result;
}

// Identifiers of a source declaration that can reference a top-level name,
// and the module specifiers it names.
interface Unit {
	nodes: ts.Identifier[];
	// Names referenced without the checker's help, e.g. `{ a }`.
	names: Set<string>;
	specifiers: [specifier: string, key: string][];
}

interface Names {
	names: Record<string, string[]>;
	// Keys of declarations stored without their references.
	pending: string[];
}

// The names of each module: per export, per top-level declaration and import,
// and for `export *`. A declaration's hash is its text in the declaration
// emit; what it references is resolved by the checker in the source. Files
// whose exports can't be read this way get none (see `createGraph`). What
// declarations reference is read when the graph first needs it.
function getNames(
	api: API,
	project: Project,
	entries: [fileName: string, declaration: Declaration[] | undefined][],
	infos: Map<string, FileInfo>,
	cache: CacheData,
) {
	const { program } = project;
	const result = new Map<string, Names | undefined>();
	const named = entries.filter(([fileName, declaration]) => {
		const info = infos.get(fileName);
		const named = declaration?.length === 1 && !!info && !(info.global && !info.scope)
			&& !/\.(?:[cm]?jsx?|json)$/.test(fileName);
		if (!named) {
			result.set(fileName, undefined);
		}
		return named;
	});
	for (let i = 0; i < named.length; i += CHUNK_SIZE) {
		const chunk = named.slice(i, i + CHUNK_SIZE);
		const files = api.batch(...chunk.map(([fileName]) => program.getSourceFile.gen(fileName)));
		const outputs = chunk.map(([, declaration], j) => files[j]?.isDeclarationFile ? undefined : declaration![0]);
		const parsed = outputs.flatMap(output => output ? [output] : []);
		const leases = api.batch(...parsed.map(output => api.createSourceFile.gen(output.fileName, output.text)));
		try {
			const emits = new Map(parsed.map((output, j) => [output, leases[j].sourceFile]));
			chunk.forEach(([fileName], j) => {
				const file = files[j];
				const emit = outputs[j] ? emits.get(outputs[j]) : file;
				if (!file || !emit) {
					result.set(fileName, undefined);
					return;
				}
				result.set(
					fileName,
					readNames(fileName, emit, collectSource(file), infos.get(fileName)!, cache.graph[fileName].deps),
				);
			});
		}
		finally {
			api.batch(...leases.map(lease => lease.dispose.gen()));
		}
	}
	return result;
}

// Reads what the pending declarations of each file reference. The file is
// unchanged since its names were read.
function readPendingRefs(
	api: API,
	project: Project,
	cache: CacheData,
	ownFiles: Map<string, fs.Stats>,
	infos: Map<string, FileInfo>,
	fileNames: string[],
) {
	const { program, checker } = project;
	const unanalyzed = fileNames.filter(fileName => !infos.has(fileName));
	for (const [fileName, info] of analyze(api, project, unanalyzed, ownFiles, undefined, false)) {
		infos.set(fileName, info);
	}
	for (let i = 0; i < fileNames.length; i += CHUNK_SIZE) {
		const chunk = fileNames.slice(i, i + CHUNK_SIZE);
		const files = api.batch(...chunk.map(fileName => program.getSourceFile.gen(fileName)));
		const sources = files.map(file => file && collectSource(file));
		resolveSources(api, checker, sources);
		chunk.forEach((fileName, j) => {
			const node = cache.graph[fileName];
			const source = sources[j];
			const info = infos.get(fileName);
			if (source && info) {
				readRefs(fileName, source, info, node.deps, node.names!, node.pending!);
			}
			else {
				for (const key of node.pending!) {
					node.names![key] = [node.names![key][0], ...node.deps.map((_, i) => `${i}\0${ALL}`)];
				}
			}
			delete node.pending;
		});
	}
}

// The top-level declarations and imports of a module's source, and the
// identifiers of each declaration that can reference one of them. Function
// bodies with a return type and initializers with a type don't reach the
// declared types, so they are skipped.
function collectSource(file: ts.SourceFile) {
	const units = new Map<string, Unit[]>();
	const imports = new Map<string, [specifier: string, name: string]>();
	const bindings: ts.Identifier[] = [];
	const attributed = new Set<ts.Node>();
	const newUnit = (): Unit => ({ nodes: [], names: new Set(), specifiers: [] });
	// Other statements, e.g. `f.x = 1`, which adds to `f`'s declaration.
	const shared = newUnit();
	let assignment: Unit | undefined;
	const walks: [ts.Node, Unit][] = [];
	const declare = (name: string, unit: Unit, node?: ts.Identifier) => {
		if (node) {
			bindings.push(node);
		}
		let list = units.get(name);
		if (!list) {
			units.set(name, list = []);
		}
		list.push(unit);
	};
	const declareBindings = (name: ts.BindingName, unit: Unit) => {
		if (ts.isIdentifier(name)) {
			declare(name.text, unit, name);
			return;
		}
		for (const element of name.elements) {
			if (!ts.isOmittedExpression(element) && element.name) {
				declareBindings(element.name, unit);
			}
		}
	};
	for (const statement of file.statements) {
		if (isBlock(statement) || ts.isNamespaceExportDeclaration(statement)) {
			continue;
		}
		if (ts.isImportDeclaration(statement)) {
			attributed.add(statement.moduleSpecifier);
			const clause = statement.importClause;
			if (!clause || !ts.isStringLiteral(statement.moduleSpecifier)) {
				continue;
			}
			const specifier = statement.moduleSpecifier.text;
			if (clause.name) {
				bindings.push(clause.name);
				imports.set(clause.name.text, [specifier, 'default']);
			}
			const namedBindings = clause.namedBindings;
			if (namedBindings && ts.isNamespaceImport(namedBindings)) {
				bindings.push(namedBindings.name);
				imports.set(namedBindings.name.text, [specifier, ALL]);
			}
			else if (namedBindings) {
				for (const element of namedBindings.elements) {
					bindings.push(element.name);
					imports.set(element.name.text, [specifier, (element.propertyName ?? element.name).text]);
				}
			}
		}
		else if (ts.isImportEqualsDeclaration(statement)) {
			const reference = statement.moduleReference;
			if (ts.isExternalModuleReference(reference)) {
				attributed.add(reference.expression);
				bindings.push(statement.name);
				if (ts.isStringLiteral(reference.expression)) {
					imports.set(statement.name.text, [reference.expression.text, ALL]);
				}
			}
			else {
				const unit = newUnit();
				declare(statement.name.text, unit, statement.name);
				walks.push([reference, unit]);
			}
		}
		else if (ts.isExportDeclaration(statement)) {
			if (statement.moduleSpecifier) {
				attributed.add(statement.moduleSpecifier);
			}
		}
		else if (ts.isExportAssignment(statement)) {
			// `export default a` is read from the declaration emit.
			if (!ts.isIdentifier(statement.expression)) {
				walks.push([statement.expression, assignment ??= newUnit()]);
			}
		}
		else if (ts.isVariableStatement(statement)) {
			for (const declaration of statement.declarationList.declarations) {
				const unit = newUnit();
				declareBindings(declaration.name, unit);
				walks.push([declaration, unit]);
			}
		}
		else if (
			ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement) || ts.isInterfaceDeclaration(statement)
			|| ts.isTypeAliasDeclaration(statement) || ts.isEnumDeclaration(statement) || ts.isModuleDeclaration(statement)
		) {
			const unit = newUnit();
			const name = statement.name && ts.isIdentifier(statement.name) ? statement.name : undefined;
			declare(name?.text ?? 'default', unit, name);
			walks.push([statement, unit]);
		}
		else {
			visitDeclarations(statement, name => declare(name.text, shared, name));
			walks.push([statement, shared]);
		}
	}

	return { file, units, imports, shared, assignment, attributed, bindings, walks, nodes: [] as ts.Identifier[] };
}

type Source = ReturnType<typeof collectSource>;

// Turns the declarations of a source into the identifiers that can reference
// a top-level name, and resolves them.
function resolveSources(api: API, checker: Checker, sources: (Source | undefined)[]) {
	const requests: [Source, [ts.Identifier, Unit][]][] = [];
	for (const source of sources) {
		if (source) {
			const candidates = walkSource(source);
			if (source.nodes.length) {
				requests.push([source, candidates]);
			}
		}
	}
	api.batch(...requests.map(([source]) => checker.getSymbolAtLocation.gen(source.nodes))).forEach((symbols, i) => {
		resolveUnits(...requests[i], symbols);
	});
}

function walkSource(source: Source) {
	const { units, imports, bindings, attributed, walks } = source;
	const topLevel = new Set([...units.keys(), ...imports.keys()]);
	const candidates: [ts.Identifier, Unit][] = [];
	const walk = (node: ts.Node, unit: Unit): void => {
		if (ts.isIdentifier(node)) {
			if (topLevel.has(node.text)) {
				const parent = node.parent as ts.Node & { name?: ts.Node; propertyName?: ts.Node; label?: ts.Node };
				if (ts.isShorthandPropertyAssignment(parent) || ts.isExportSpecifier(parent)) {
					// The checker resolves these to the property or the export.
					if (ts.isShorthandPropertyAssignment(parent) || node === (parent.propertyName ?? parent.name)) {
						unit.names.add(node.text);
					}
				}
				else if (parent.name !== node && parent.propertyName !== node && parent.label !== node) {
					candidates.push([node, unit]);
				}
			}
			return;
		}
		if (
			ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) && ts.isStringLiteral(node.argument.literal)
		) {
			attributed.add(node.argument.literal);
			let qualifier = node.qualifier;
			while (qualifier && ts.isQualifiedName(qualifier)) {
				qualifier = qualifier.left;
			}
			unit.specifiers.push([node.argument.literal.text, qualifier?.text ?? ALL]);
			node.typeArguments?.forEach(child => walk(child, unit));
			return;
		}
		if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
			const argument = node.arguments[0];
			if (argument && ts.isStringLiteral(argument)) {
				attributed.add(argument);
				unit.specifiers.push([argument.text, ALL]);
			}
		}
		if (ts.isPropertyAccessExpression(node)) {
			walk(node.expression, unit);
			return;
		}
		if (ts.isQualifiedName(node)) {
			walk(node.left, unit);
			return;
		}
		let skipped: ts.Node | undefined;
		if (ts.isFunctionLikeDeclaration(node) && (node.type || ts.isSetAccessorDeclaration(node))) {
			skipped = node.body;
		}
		else if (
			(ts.isVariableDeclaration(node) || ts.isPropertyDeclaration(node) || ts.isParameterDeclaration(node))
			&& node.type
		) {
			skipped = node.initializer;
		}
		node.forEachChild(child => {
			if (child !== skipped) {
				walk(child, unit);
			}
		});
	};
	for (const [node, unit] of walks) {
		walk(node, unit);
	}
	for (const [node, unit] of candidates) {
		unit.nodes.push(node);
	}
	source.nodes = [...bindings, ...candidates.map(([node]) => node)];
	return candidates;
}

// Turns the identifiers of each unit into the names they resolve to. One the
// checker resolves to nothing, or whose name's declarations it doesn't
// resolve, counts as every top-level name of its text.
function resolveUnits(
	source: Source,
	candidates: [ts.Identifier, Unit][],
	symbols: readonly ({ id: number } | undefined)[],
) {
	const byId = new Map<number, string>();
	const unresolved = new Set<string>();
	source.bindings.forEach((node, i) => {
		const symbol = symbols[i];
		if (symbol) {
			byId.set(symbol.id, node.text);
		}
		else {
			unresolved.add(node.text);
		}
	});
	candidates.forEach(([node, unit], i) => {
		const symbol = symbols[source.bindings.length + i];
		const name = symbol && byId.get(symbol.id);
		if (name !== undefined) {
			unit.names.add(name);
		}
		else if (!symbol || unresolved.has(node.text)) {
			unit.names.add(node.text);
		}
	});
}

// The names of a module with their hashes, and what its exports, imports
// and `export *` reference. Declarations get their references from
// `readRefs`; their keys are returned as pending.
function readNames(
	fileName: string,
	emit: ts.SourceFile,
	source: Source,
	info: FileInfo,
	deps: string[],
): Names {
	const encode = (specifier: string, key: string) => encodeRef(fileName, info.references, deps, specifier, key);
	// A key that names the same target in any run, unlike the dep index.
	const describe = (specifier: string, key: string) => `${info.references.get(specifier) ?? '?' + specifier}\0${key}`;

	const texts = new Map<string, string[]>();
	const exports = new Map<string, Set<string>>();
	const stars: string[] = [];
	const imports = new Map(source.imports);
	const addText = (name: string, text: string) => {
		let list = texts.get(name);
		if (!list) {
			texts.set(name, list = []);
		}
		list.push(text);
	};
	const addExport = (name: string, ...refs: (string | undefined)[]) => {
		let set = exports.get(name);
		if (!set) {
			exports.set(name, set = new Set());
		}
		for (const ref of refs) {
			if (ref !== undefined) {
				set.add(ref);
			}
		}
	};
	for (const statement of emit.statements) {
		const modifiers = (statement as { modifiers?: ts.NodeArray<ts.ModifierLike> }).modifiers;
		const isExported = !!modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword);
		const isDefault = !!modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.DefaultKeyword);
		const text = emit.text.slice(statement.pos, statement.end);
		if (isBlock(statement)) {
			continue;
		}
		if (ts.isImportDeclaration(statement)) {
			const clause = statement.importClause;
			if (!clause || !ts.isStringLiteral(statement.moduleSpecifier)) {
				continue;
			}
			const specifier = statement.moduleSpecifier.text;
			if (clause.name && !imports.has(clause.name.text)) {
				imports.set(clause.name.text, [specifier, 'default']);
			}
			const namedBindings = clause.namedBindings;
			if (namedBindings && ts.isNamespaceImport(namedBindings)) {
				if (!imports.has(namedBindings.name.text)) {
					imports.set(namedBindings.name.text, [specifier, ALL]);
				}
			}
			else if (namedBindings) {
				for (const element of namedBindings.elements) {
					if (!imports.has(element.name.text)) {
						imports.set(element.name.text, [specifier, (element.propertyName ?? element.name).text]);
					}
				}
			}
		}
		else if (ts.isImportEqualsDeclaration(statement)) {
			const reference = statement.moduleReference;
			if (ts.isExternalModuleReference(reference)) {
				if (ts.isStringLiteral(reference.expression) && !imports.has(statement.name.text)) {
					imports.set(statement.name.text, [reference.expression.text, ALL]);
				}
			}
			else {
				addText(statement.name.text, text);
			}
			if (isExported) {
				addExport(statement.name.text, LOCAL + statement.name.text);
			}
		}
		else if (ts.isVariableStatement(statement)) {
			const list = statement.declarationList.declarations;
			const prefix = list.length ? emit.text.slice(statement.pos, list[0].pos) : '';
			for (const declaration of list) {
				const names: string[] = [];
				const collect = (name: ts.BindingName) => {
					if (ts.isIdentifier(name)) {
						names.push(name.text);
						return;
					}
					for (const element of name.elements) {
						if (!ts.isOmittedExpression(element) && element.name) {
							collect(element.name);
						}
					}
				};
				collect(declaration.name);
				for (const name of names) {
					addText(name, prefix + emit.text.slice(declaration.pos, declaration.end));
					if (isExported) {
						addExport(name, LOCAL + name);
					}
				}
			}
		}
		else if (
			ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement) || ts.isInterfaceDeclaration(statement)
			|| ts.isTypeAliasDeclaration(statement) || ts.isEnumDeclaration(statement) || ts.isModuleDeclaration(statement)
		) {
			const name = statement.name && ts.isIdentifier(statement.name) ? statement.name.text : 'default';
			addText(name, text);
			if (isExported) {
				addExport(isDefault ? 'default' : name, LOCAL + name);
			}
		}
		else if (ts.isExportDeclaration(statement)) {
			const specifier = statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier)
				? statement.moduleSpecifier.text
				: undefined;
			const clause = statement.exportClause;
			if (!clause) {
				if (specifier !== undefined) {
					stars.push(specifier);
				}
			}
			else if (ts.isNamespaceExport(clause)) {
				if (specifier !== undefined) {
					addExport(clause.name.text, encode(specifier, ALL));
				}
			}
			else {
				for (const element of clause.elements) {
					const local = (element.propertyName ?? element.name).text;
					addExport(element.name.text, specifier === undefined ? LOCAL + local : encode(specifier, local));
				}
			}
		}
		else if (ts.isExportAssignment(statement)) {
			const name = statement.isExportEquals ? 'export=' : 'default';
			if (ts.isIdentifier(statement.expression)) {
				addExport(name, LOCAL + statement.expression.text);
			}
			else {
				addText(name, text);
				addExport(name, LOCAL + name);
			}
		}
	}

	const names = new Map<string, string[]>();
	const pending: string[] = [];
	for (const name of new Set([...texts.keys(), ...source.units.keys()])) {
		if (!imports.has(name)) {
			names.set(LOCAL + name, [hash(texts.get(name)?.join('\0') ?? '')]);
			pending.push(LOCAL + name);
		}
	}
	for (const [name, [specifier, key]] of imports) {
		const ref = encode(specifier, key);
		names.set(LOCAL + name, [hash(describe(specifier, key)), ...ref === undefined ? [] : [ref]]);
	}
	for (const [name, refs] of exports) {
		// Refs within the file are the same in any run.
		const describeRef = (ref: string) => {
			const separator = ref.indexOf('\0');
			return separator <= 0 ? ref : `${deps[+ref.slice(0, separator)]}\0${ref.slice(separator + 1)}`;
		};
		names.set(name, [hash([...refs].map(describeRef).sort().join('\0')), ...refs]);
	}
	if (stars.length) {
		const refs = stars.map(specifier => encode(specifier, ALL)).filter(ref => ref !== undefined);
		names.set(STAR, [hash(stars.map(specifier => describe(specifier, ALL)).sort().join('\0')), ...new Set(refs)]);
	}
	return { names: Object.fromEntries(names), pending };
}

// What each of the given declarations of a module references, from its
// resolved source.
function readRefs(
	fileName: string,
	source: Source,
	info: FileInfo,
	deps: string[],
	names: Record<string, string[]>,
	keys: string[],
) {
	const { file } = source;
	const encode = (specifier: string, key: string) => encodeRef(fileName, info.references, deps, specifier, key);
	const addUnit = (unit: Unit, refs: Set<string>) => {
		for (const name of unit.names) {
			refs.add(LOCAL + name);
		}
		for (const [specifier, key] of unit.specifiers) {
			const ref = encode(specifier, key);
			if (ref !== undefined) {
				refs.add(ref);
			}
		}
	};
	// What every declaration references: the other statements, and module
	// specifiers and references no declaration accounts for.
	const shared = new Set<string>();
	addUnit(source.shared, shared);
	for (const ref of [...file.typeReferenceDirectives, ...file.referencedFiles]) {
		const encoded = encode(ref.fileName, ALL);
		if (encoded !== undefined) {
			shared.add(encoded);
		}
	}
	for (const specifier of file.imports as unknown as ts.StringLiteral[]) {
		if (!source.attributed.has(specifier)) {
			const ref = encode(specifier.text, ALL);
			if (ref !== undefined) {
				shared.add(ref);
			}
		}
	}
	// A declaration the emit adds, e.g. `_default` for `export default f()`,
	// references what `export default` / `export =` does, or, without
	// one, every dep.
	const emitted = new Set<string>();
	if (source.assignment) {
		addUnit(source.assignment, emitted);
	}
	else {
		deps.forEach((_, i) => emitted.add(`${i}\0${ALL}`));
	}
	for (const key of keys) {
		const refs = new Set(shared);
		const units = source.units.get(key.slice(LOCAL.length));
		if (units) {
			for (const unit of units) {
				addUnit(unit, refs);
			}
		}
		else {
			for (const ref of emitted) {
				refs.add(ref);
			}
		}
		refs.delete(key);
		names[key] = [names[key][0], ...refs];
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

// 96 bits; the cache keeps one per name.
function hash(text: string) {
	return crypto.createHash('sha256').update(text).digest('base64url').slice(0, 16);
}
