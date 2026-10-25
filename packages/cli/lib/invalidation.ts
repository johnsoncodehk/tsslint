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
//   - a changed signature of a script or a UMD module (`export as namespace`)
//   - a changed `declare global` / `declare module '...'` block, or a changed
//     declaration of a name its blocks use: an import, a declaration of the
//     module itself, or the augmented module
//   - a file starting or stopping to declare globals

import crypto = require('crypto');
import fs = require('fs');
import path = require('path');
import * as ts from 'typescript/ast';
import type { API, Checker, Project } from 'typescript/sync';
import type { CacheData, GraphNode } from './cache.js';

const CHUNK_SIZE = 500;
// Key prefixes in `GraphNode.names` beside export names, which are
// identifiers or string literals; neither can hold `\0`.
const LOCAL = '\0';
const STAR = '\0*';

interface Declaration {
	fileName: string;
	text: string;
}

interface FileInfo {
	deps: string[];
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
	// Module specifiers the blocks name, e.g. the augmented module or an
	// `import('./a')` type.
	specifiers: Set<string>;
	// Export names the blocks use through the imports of each module
	// specifier; `*` for a namespace or `import =` binding.
	imports: Map<string, Set<string>>;
	// Names of the module's own declarations the blocks use.
	locals: Set<string>;
}

// Per name in a declaration emit, what its declarations reach within the
// file, and the module specifiers they name.
interface NameInfo {
	hash: string;
	specifiers: string[];
}

interface DeclarationInfo {
	specifiers: string[];
	names?: Map<string, NameInfo>;
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

	const oldSignatures = new Map<string, string | undefined>();
	let scopeChanged = false;
	for (const fileName of changed) {
		oldSignatures.set(fileName, cache.graph[fileName]?.signature);
		scopeChanged ||= cache.graph[fileName].scope !== infos.get(fileName)!.scope?.hash;
		setNode(cache, fileName, ownFiles.get(fileName)!, infos.get(fileName)!);
	}
	const importers = getImporters(cache);
	const changedSet = new Set(changed);
	const dirty = new Set(changed);
	const signatureChanged = new Set<string>();
	const declarations = new Map<string, Declaration[] | undefined>();
	const signatures = new Map<string, string>();
	// The parsed declaration emit of files whose signature stayed the same,
	// and of files whose names are tracked.
	const read = new Map<string, DeclarationInfo>();

	let queue = changed;
	while (queue.length) {
		const wave = [...new Set(queue)].filter(fileName => !signatureChanged.has(fileName));
		queue = [];
		const unanalyzed = wave.filter(fileName => !infos.has(fileName));
		if (unanalyzed.length) {
			for (const [fileName, info] of analyze(api, project, unanalyzed, ownFiles)) {
				infos.set(fileName, info);
			}
		}
		const unemitted = wave.filter(fileName => !signatures.has(fileName));
		for (const [fileName, declaration] of getDeclarations(api, project, unemitted)) {
			declarations.set(fileName, declaration.declaration);
			signatures.set(fileName, declaration.signature);
			if (!changedSet.has(fileName)) {
				oldSignatures.set(fileName, cache.graph[fileName].signature);
			}
		}
		const unread = wave.filter(fileName =>
			!read.has(fileName)
			&& declarations.get(fileName) !== undefined
			&& (oldSignatures.get(fileName) === signatures.get(fileName) || cache.graph[fileName].names)
		);
		const entries = unread.map(fileName => [fileName, declarations.get(fileName)!] as const);
		for (const [fileName, info] of readDeclarations(api, entries, fileName => !!cache.graph[fileName].names)) {
			read.set(fileName, info);
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
	const named = getNamed(infos);
	const oldNames = new Map<string, Record<string, string> | undefined>();
	const naming = [...declarations.keys()].filter(fileName => named.has(fileName) || cache.graph[fileName].names);
	const unnamed = naming.filter(fileName => declarations.get(fileName) !== undefined && !read.get(fileName)?.names);
	const entries = unnamed.map(fileName => [fileName, declarations.get(fileName)!] as const);
	for (const [fileName, info] of readDeclarations(api, entries, () => true)) {
		read.set(fileName, info);
	}
	for (const fileName of naming) {
		oldNames.set(fileName, cache.graph[fileName].names);
		setNames(cache.graph[fileName], read.get(fileName)?.names);
	}
	updateMissingSignatures(api, project, cache, importers, named);
	// The graph stays valid; only the results can't be reused.
	if (
		scopeChanged || [...signatureChanged].some(fileName => cache.graph[fileName].global && reachesGlobals(fileName))
	) {
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
		const allInfos = analyze(api, project, all, ownFiles, known);
		for (const fileName of all) {
			setNode(cache, fileName, ownFiles.get(fileName)!, allInfos.get(fileName)!);
		}
		updateMissingSignatures(api, project, cache, getImporters(cache), getNamed(allInfos));
	}

	// Whether a global file's changed signature reaches what it declares
	// globally. Its blocks are unchanged here; what they use can still
	// change, through an import or a declaration of the module itself.
	function reachesGlobals(fileName: string) {
		const { scope, references } = infos.get(fileName)!;
		if (!scope) {
			return true;
		}
		for (const [specifier, target] of references) {
			if (target === null || target === fileName || !signatureChanged.has(target)) {
				continue;
			}
			if (scope.specifiers.has(specifier)) {
				return true;
			}
			for (const name of scope.imports.get(specifier) ?? []) {
				if (hasNameChanged(target, name, false)) {
					return true;
				}
			}
		}
		for (const name of scope.locals) {
			if (hasNameChanged(fileName, name, true)) {
				return true;
			}
		}
		return false;
	}

	// Whether the declarations a name reaches in a file's declaration emit
	// changed, or what they name from other files. A name that can't be
	// found in either emit counts as changed.
	function hasNameChanged(fileName: string, name: string, local: boolean) {
		if (name === '*') {
			return true;
		}
		const names = read.get(fileName)?.names;
		const old = oldNames.get(fileName);
		const info = findName(key => names?.get(key), name, local);
		if (!info || info.hash !== findName(key => old?.[key], name, local)) {
			return true;
		}
		const references = infos.get(fileName)!.references;
		return info.specifiers.some(specifier => {
			const target = references.get(specifier);
			return target === undefined || (target !== null && signatureChanged.has(target));
		});
	}

	function hasSignatureChanged(fileName: string) {
		const oldSignature = oldSignatures.get(fileName);
		if (oldSignature === undefined || oldSignature !== signatures.get(fileName)) {
			return true;
		}
		const specifiers = read.get(fileName)?.specifiers;
		if (specifiers === undefined) {
			// No declaration emit to compare: its types may still change
			// through a dependency.
			return !changedSet.has(fileName);
		}
		// The text can stay the same while the types it names change, e.g.
		// `typeof import("./a").f` after `f`'s return type changed in `a`.
		const references = infos.get(fileName)!.references;
		for (const specifier of specifiers) {
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
	if (info.scope) {
		node.scope = info.scope.hash;
	}
	const { signature, names } = cache.graph[fileName] ?? {};
	if (signature !== undefined) {
		node.signature = signature;
	}
	if (names !== undefined) {
		node.names = names;
	}
	cache.graph[fileName] = node;
}

function setNames(node: GraphNode, names: Map<string, NameInfo> | undefined) {
	if (names) {
		node.names = Object.fromEntries([...names].map(([name, info]) => [name, info.hash]));
	}
	else {
		delete node.names;
	}
}

// An export not found by its name can be a declaration of a declaration
// file without exports, or come from `export * from`.
function findName<T>(get: (key: string) => T | undefined, name: string, local: boolean) {
	return local ? get(LOCAL + name) : get(name) ?? get(LOCAL + name) ?? get(STAR);
}

// Files whose names the blocks of a global module use: the targets of their
// imports, and the module itself for its own declarations.
function getNamed(infos: Map<string, FileInfo>) {
	const named = new Set<string>();
	for (const [fileName, { scope, references }] of infos) {
		if (!scope) {
			continue;
		}
		if (scope.locals.size) {
			named.add(fileName);
		}
		for (const [specifier, names] of scope.imports) {
			const target = references.get(specifier);
			if (target && [...names].some(name => name !== '*')) {
				named.add(target);
			}
		}
	}
	return named;
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
// files that declare globals; names only for the files in `named`.
function updateMissingSignatures(
	api: API,
	project: Project,
	cache: CacheData,
	importers: Map<string, Set<string>>,
	named: Set<string>,
) {
	const missing: string[] = [];
	for (const [fileName, node] of Object.entries(cache.graph)) {
		if (!importers.has(fileName) && !node.global) {
			delete node.signature;
			delete node.names;
		}
		else if (node.signature === undefined || (named.has(fileName) && !node.names)) {
			missing.push(fileName);
		}
	}
	const declarations = getDeclarations(api, project, missing);
	const entries: [string, Declaration[]][] = [];
	for (const [fileName, { declaration, signature }] of declarations) {
		cache.graph[fileName].signature ??= signature;
		if (named.has(fileName) && declaration) {
			entries.push([fileName, declaration]);
		}
	}
	for (const [fileName, { names }] of readDeclarations(api, entries, () => true)) {
		setNames(cache.graph[fileName], names);
	}
}

function analyze(
	api: API,
	project: Project,
	fileNames: string[],
	ownFiles: Map<string, fs.Stats>,
	known?: Map<string, FileInfo>,
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
			] as unknown as { text: string }[]
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
			const info: FileInfo = { deps: [...deps], global: false, references };
			if (!file.fileName.endsWith('.json')) {
				if (!file.externalModuleIndicator || file.statements.some(ts.isNamespaceExportDeclaration)) {
					info.global = true;
				}
				else if (file.moduleAugmentations.length || file.ambientModuleNames.length) {
					info.global = true;
					scoped.push([file, info]);
				}
			}
			infos.set(file.fileName, info);
		});
		const scopes = getScopes(api, project.checker, scoped.map(([file]) => file));
		scoped.forEach(([, info], i) => info.scope = scopes[i]);
	}
	return infos;
}

interface Binding {
	// For an import; the export name is `*` for a whole module.
	specifier?: string;
	name: string;
}

// What the `declare global` / `declare module '...'` blocks of each file
// use, by resolving every identifier in them to its symbol. Identifiers that
// resolve to neither an import nor a declaration of the module are declared
// by the blocks themselves, globally elsewhere, or in the augmented module,
// which `Scope.specifiers` covers.
function getScopes(api: API, checker: Checker, files: ts.SourceFile[]): Scope[] {
	const collected = files.map(collectScope);
	const requests = collected.filter(({ used }) => used.length);
	const resolved = new Map(
		api.batch(...requests.map(({ bindings, used }) => checker.getSymbolAtLocation.gen([...bindings.keys(), ...used])))
			.map((symbols, i) => [requests[i], symbols]),
	);
	return collected.map(scope => {
		const { hash, specifiers, bindings } = scope;
		const result: Scope = { hash, specifiers, imports: new Map(), locals: new Set() };
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
	// A `var` in a nested statement is also a declaration of the module.
	const visitDeclarations = (node: ts.Node): void => {
		if (
			(ts.isVariableDeclaration(node) || ts.isBindingElement(node) || ts.isFunctionDeclaration(node)
				|| ts.isClassDeclaration(node) || ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node)
				|| ts.isEnumDeclaration(node) || ts.isModuleDeclaration(node))
			&& node.name && ts.isIdentifier(node.name)
		) {
			bindings.set(node.name, { name: node.name.text });
		}
		if (!ts.isFunctionLikeDeclaration(node) && !ts.isClassLikeDeclaration(node) && !ts.isModuleDeclaration(node)) {
			node.forEachChild(visitDeclarations);
		}
	};
	for (const statement of file.statements) {
		if (ts.isModuleDeclaration(statement) && (ts.isStringLiteral(statement.name) || statement.name.text === 'global')) {
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
				bindings.set(named.name, { specifier, name: '*' });
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
					? { specifier: reference.expression.text, name: '*' }
					: { name: statement.name.text },
			);
		}
		else {
			visitDeclarations(statement);
		}
	}
	return { hash: hash(text), specifiers, bindings, used };
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

// Parses the declaration emit of each file and reads the module specifiers
// it names, keyed like `FileInfo.references`, and for `withNames` files
// its names. A file with more than one output gets none.
function readDeclarations(
	api: API,
	entries: readonly (readonly [fileName: string, declaration: Declaration[]])[],
	withNames: (fileName: string) => boolean,
) {
	const result = new Map<string, DeclarationInfo>();
	const outputs = entries.flatMap(([fileName, declaration]) =>
		declaration.map(output => ({ fileName, output, names: declaration.length === 1 && withNames(fileName) }))
	);
	for (let i = 0; i < outputs.length; i += CHUNK_SIZE) {
		const chunk = outputs.slice(i, i + CHUNK_SIZE);
		const leases = api.batch(...chunk.map(({ output }) => api.createSourceFile.gen(output.fileName, output.text)));
		try {
			leases.forEach(({ sourceFile: file }, j) => {
				const { fileName, names } = chunk[j];
				let entry = result.get(fileName);
				if (!entry) {
					result.set(fileName, entry = { specifiers: [] });
				}
				entry.specifiers.push(...getReferencedSpecifiers(file));
				if (names) {
					entry.names = getNames(file);
				}
			});
		}
		finally {
			api.batch(...leases.map(lease => lease.dispose.gen()));
		}
	}
	return result;
}

function getReferencedSpecifiers(file: ts.SourceFile) {
	return [
		...file.imports.map(specifier => (specifier as ts.StringLiteral).text),
		// Names inside an augmentation resolve in the augmented module.
		...file.moduleAugmentations.flatMap(name => ts.isStringLiteral(name) ? [name.text] : []),
		...file.typeReferenceDirectives.map(ref => ref.fileName),
		...file.referencedFiles.map(ref => ref.fileName),
	];
}

// For each export, each top-level declaration, and `export *` together:
// a hash of the statements it reaches through the names they mention, and
// the module specifiers those statements name. Names are matched by text,
// so a property or a parameter named like a declaration only reaches more.
// Augmentation blocks are left out; their changes and what they use are
// checked for the file itself.
function getNames(file: ts.SourceFile) {
	const declared = new Map<string, ts.Statement[]>();
	const exported = new Map<string, ts.Statement[]>();
	const stars: ts.Statement[] = [];
	const localExports: [name: string, local: string, statement: ts.Statement][] = [];
	// e.g. a side-effect import; reached from every name.
	const shared: ts.Statement[] = [];
	const add = (map: Map<string, ts.Statement[]>, name: string, statement: ts.Statement) => {
		let statements = map.get(name);
		if (!statements) {
			map.set(name, statements = []);
		}
		statements.push(statement);
	};
	const addBindings = (name: ts.BindingName | undefined, statement: ts.Statement, isExported: boolean) => {
		if (!name) {
			return;
		}
		if (ts.isIdentifier(name)) {
			add(declared, name.text, statement);
			if (isExported) {
				add(exported, name.text, statement);
			}
			return;
		}
		for (const element of name.elements) {
			if (!ts.isOmittedExpression(element)) {
				addBindings(element.name, statement, isExported);
			}
		}
	};
	for (const statement of file.statements) {
		const modifiers = (statement as { modifiers?: ts.NodeArray<ts.ModifierLike> }).modifiers;
		const isExported = !!modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword);
		const isDefault = !!modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.DefaultKeyword);
		if (ts.isModuleDeclaration(statement) && (ts.isStringLiteral(statement.name) || statement.name.text === 'global')) {
			continue;
		}
		if (ts.isImportDeclaration(statement)) {
			const clause = statement.importClause;
			if (!clause) {
				shared.push(statement);
				continue;
			}
			if (clause.name) {
				add(declared, clause.name.text, statement);
			}
			const named = clause.namedBindings;
			if (named && ts.isNamespaceImport(named)) {
				add(declared, named.name.text, statement);
			}
			else if (named) {
				for (const element of named.elements) {
					add(declared, element.name.text, statement);
				}
			}
		}
		else if (ts.isImportEqualsDeclaration(statement)) {
			addBindings(statement.name, statement, isExported);
		}
		else if (ts.isVariableStatement(statement)) {
			for (const declaration of statement.declarationList.declarations) {
				addBindings(declaration.name, statement, isExported);
			}
		}
		else if (
			ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement) || ts.isInterfaceDeclaration(statement)
			|| ts.isTypeAliasDeclaration(statement) || ts.isEnumDeclaration(statement) || ts.isModuleDeclaration(statement)
		) {
			if (statement.name && ts.isIdentifier(statement.name)) {
				add(declared, statement.name.text, statement);
			}
			if (isExported) {
				const name = isDefault ? 'default' : statement.name && ts.isIdentifier(statement.name) && statement.name.text;
				if (name) {
					add(exported, name, statement);
				}
			}
		}
		else if (ts.isExportDeclaration(statement)) {
			const clause = statement.exportClause;
			if (!clause) {
				stars.push(statement);
			}
			else if (ts.isNamespaceExport(clause)) {
				add(exported, clause.name.text, statement);
			}
			else {
				for (const element of clause.elements) {
					if (statement.moduleSpecifier) {
						add(exported, element.name.text, statement);
					}
					else {
						localExports.push([element.name.text, (element.propertyName ?? element.name).text, statement]);
					}
				}
			}
		}
		else if (ts.isExportAssignment(statement)) {
			add(exported, statement.isExportEquals ? 'export=' : 'default', statement);
		}
		else {
			shared.push(statement);
		}
	}
	// `export { a as b }` reaches what `a` does.
	for (const [name, local, statement] of localExports) {
		for (const declaration of declared.get(local) ?? [statement]) {
			add(exported, name, declaration);
		}
	}

	const fileSpecifiers = [
		...file.typeReferenceDirectives.map(ref => ref.fileName),
		...file.referencedFiles.map(ref => ref.fileName),
	];
	const mentions = new Map<ts.Statement, { names: Set<string>; specifiers: string[] }>();
	const getMentions = (statement: ts.Statement) => {
		let result = mentions.get(statement);
		if (result) {
			return result;
		}
		const names = new Set<string>();
		const specifiers: string[] = [];
		const visit = (node: ts.Node): void => {
			if (ts.isIdentifier(node)) {
				names.add(node.text);
			}
			else if (
				(ts.isImportDeclaration(node) || ts.isExportDeclaration(node))
				&& node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)
			) {
				specifiers.push(node.moduleSpecifier.text);
			}
			else if (ts.isExternalModuleReference(node) && ts.isStringLiteral(node.expression)) {
				specifiers.push(node.expression.text);
			}
			else if (
				ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) && ts.isStringLiteral(node.argument.literal)
			) {
				specifiers.push(node.argument.literal.text);
			}
			node.forEachChild(visit);
		};
		visit(statement);
		mentions.set(statement, result = { names, specifiers });
		return result;
	};
	const reach = (statements: ts.Statement[]): NameInfo => {
		const seen = new Set<ts.Statement>();
		const queue = [...statements, ...shared];
		while (queue.length) {
			const statement = queue.pop()!;
			if (seen.has(statement)) {
				continue;
			}
			seen.add(statement);
			for (const name of getMentions(statement).names) {
				queue.push(...declared.get(name) ?? []);
			}
		}
		const reached = [...seen].sort((a, b) => a.pos - b.pos);
		return {
			hash: hash(reached.map(statement => file.text.slice(statement.pos, statement.end)).join('\0')),
			specifiers: [...new Set([...fileSpecifiers, ...reached.flatMap(statement => getMentions(statement).specifiers)])],
		};
	};

	const names = new Map<string, NameInfo>();
	for (const [name, statements] of exported) {
		names.set(name, reach(statements));
	}
	for (const [name, statements] of declared) {
		names.set(LOCAL + name, reach(statements));
	}
	if (stars.length) {
		names.set(STAR, reach(stars));
	}
	return names;
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
