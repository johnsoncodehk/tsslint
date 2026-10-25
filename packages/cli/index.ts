// Patch fs before anything else loads — resolver-heavy plugins (import-x in
// particular) pound on statSync per file and benefit from in-process caching.
require('./lib/fs-cache.js');

// Env vars for downstream packages must be set BEFORE any import that
// transitively loads them — they're read at module-load time, not on use.
process.env.TSSLINT_CLI = '1';
if (process.argv.includes('--debug-estree')) {
	process.env.TSSLINT_DEBUG_ESTREE = '1';
}

import { version as tsVersion } from 'typescript';
import { DiagnosticCategory } from 'typescript/sync';
import path = require('path');
import worker = require('./lib/worker.js');
import cache = require('./lib/cache.js');
import fs = require('fs');
import minimatch = require('minimatch');
import colors = require('./lib/colors.js');
import render = require('./lib/render.js');
import format = require('./lib/format.js');

const HELP = `
Usage: tsslint [options]

Options:
  --project <glob...>           Lint TypeScript/JavaScript projects
  --filter <glob...>            Filter files to lint
  --fix                         Apply automatic fixes
  --force                       Ignore cache (re-lint every file)
  --failures-only               Only print errors and messages (skip warnings and suggestions)
  --debug-estree                After linting, print the actual ESTree node types converted by @tsslint/compat-eslint and their counts
  -h, --help                    Show this help message

Examples:
  # Single project
  tsslint --project tsconfig.json

  # Multiple projects with glob
  tsslint --project packages/*/tsconfig.json

  # Multiple projects with brace expansion
  tsslint --project {tsconfig.json,packages/*/tsconfig.json}

  # With filter and fix
  tsslint --project tsconfig.json --filter "src/**/*.ts" --fix
`;

if (process.argv.includes('--help') || process.argv.includes('-h')) {
	console.log(HELP);
	process.exit(0);
}

const PROJECT_FLAGS = [
	{ flag: '--project' },
] as const;

class Project {
	started = false;
	/**
	 * all file names of the tsconfig, including content-mapped files
	 */
	rawFileNames: readonly string[] = [];
	/**
	 * file names after filter, for linting process
	 */
	fileNames: readonly string[] = [];
	configFile: string | undefined;
	currentFileIndex = 0;
	cacheData: cache.CacheData = cache.emptyCache();
	pendingHeader: string | undefined;

	constructor(
		public tsconfig: string,
	) {
		this.configFile = findConfigFile(path.dirname(tsconfig));
	}

	init(renderer: render.Renderer, filesFilter: string[]) {
		const label = colors.tsColor('TS');
		const relPath = path.relative(process.cwd(), this.tsconfig);

		if (!this.configFile) {
			renderer.info(
				`${label} ${relPath} ${colors.gray('(no tsslint.config.ts)')}`,
			);
			return this;
		}

		this.rawFileNames = worker.getProjectFileNames(this.tsconfig);

		if (!this.rawFileNames.length) {
			renderer.info(`${label} ${colors.gray(relPath)} ${colors.gray('(0)')}`);
			return this;
		}

		if (filesFilter.length) {
			this.fileNames = this.rawFileNames.filter(
				fileName =>
					filesFilter.some(
						filter => minimatch.minimatch(fileName, filter, { dot: true }),
					),
			);
			if (!this.fileNames.length) {
				renderer.info(
					`${label} ${colors.gray(relPath)} ${colors.gray('(0 after filter)')}`,
				);
				return this;
			}
		}
		else {
			this.fileNames = this.rawFileNames;
		}

		const filteredLengthDiff = this.rawFileNames.length - this.fileNames.length;
		this.pendingHeader = `${label} ${relPath} ${
			colors.gray(`(${this.fileNames.length}${filteredLengthDiff ? `, skipped ${filteredLengthDiff}` : ''})`)
		}`;

		// Load the cache unless --force was passed; `worker.setup` drops
		// whatever is no longer valid. See packages/cli/lib/invalidation.ts.
		if (!process.argv.includes('--force')) {
			this.cacheData = cache.loadCache(this.tsconfig, this.configFile, tsVersion);
		}

		return this;
	}
}

(async () => {
	const renderer = render.createRenderer();
	const tsconfigs = new Set<string>();

	function exit(code: number): never {
		renderer.dispose();
		try {
			worker.close();
		}
		catch {}
		process.exit(code);
	}

	function fail(msg: string): never {
		renderer.error(colors.red(msg));
		exit(1);
	}

	let projects: Project[] = [];
	let hasFix = false;
	let allFilesNum = 0;
	let processed = 0;
	let cached = 0;
	let passed = 0;
	let errors = 0;
	let warnings = 0;
	let messages = 0;
	let suggestions = 0;
	let configErrors = 0;
	const failuresOnly = process.argv.includes('--failures-only');

	if (!PROJECT_FLAGS.some(({ flag }) => process.argv.includes(flag))) {
		renderer.dispose();
		console.log(HELP);
		process.exit(1);
	}

	for (const { flag } of PROJECT_FLAGS) {
		if (!process.argv.includes(flag)) {
			continue;
		}
		let foundArg = false;
		const projectsIndex = process.argv.indexOf(flag);
		for (let i = projectsIndex + 1; i < process.argv.length; i++) {
			if (process.argv[i].startsWith('-')) {
				break;
			}
			foundArg = true;
			const searchGlob = process.argv[i];
			const matches = fs.globSync(searchGlob);
			if (!matches.length) {
				fail(`No projects found for ${flag} ${searchGlob}.`);
			}
			for (const tsconfig of matches) {
				tsconfigs.add(resolvePath(tsconfig));
			}
		}
		if (!foundArg) {
			fail(`Missing argument for ${flag}.`);
		}
	}

	function normalizeFilterGlobPath(filterGlob: string) {
		let filterPath = path.resolve(process.cwd(), filterGlob);
		if (fs.statSync(filterPath, { throwIfNoEntry: false })?.isDirectory()) {
			filterPath = path.join(filterPath, '**/*');
		}
		return filterPath.replace(/\\/g, '/');
	}

	const filters: string[] = [];
	const filterArgIndex = process.argv.indexOf('--filter');
	if (filterArgIndex !== -1) {
		const filterGlob = process.argv[filterArgIndex + 1];
		if (!filterGlob || filterGlob.startsWith('-')) {
			fail(`Missing argument for --filter.`);
		}
		filters.push(normalizeFilterGlobPath(filterGlob));
		for (let i = filterArgIndex + 2; i < process.argv.length; i++) {
			const filterGlob = process.argv[i];
			if (filterGlob.startsWith('-')) {
				break;
			}
			filters.push(normalizeFilterGlobPath(filterGlob));
		}
	}

	projects = [...tsconfigs].map(tsconfig => new Project(tsconfig));
	const configured = projects.filter(project => project.configFile).map(project => project.tsconfig);
	if (configured.length) {
		worker.openProjects(configured);
	}
	for (const project of projects) {
		project.init(renderer, filters);
	}

	projects = projects.filter(project => project.configFile && project.fileNames.length);

	for (const project of projects) {
		allFilesNum += project.fileNames.length;
	}

	if (allFilesNum === 0) {
		renderer.info(colors.yellow('No input files.'));
		exit(1);
	}

	await startWorker();

	const summaryLines: string[] = [];

	const counters: string[] = [];
	if (passed) {
		counters.push(colors.green(`${passed} passed`));
	}
	if (errors) {
		counters.push(colors.red(`${errors} ${plural(errors, 'error')}`));
	}
	if (warnings) {
		counters.push(colors.yellow(`${warnings} ${plural(warnings, 'warning')}`));
	}
	if (messages) {
		counters.push(colors.blue(`${messages} ${plural(messages, 'message')}`));
	}
	if (suggestions) {
		counters.push(colors.gray(`${suggestions} ${plural(suggestions, 'suggestion')}`));
	}
	if (configErrors) {
		counters.push(colors.red(`${configErrors} ${plural(configErrors, 'config error')}`));
	}

	const hints: string[] = [];
	if (cached) {
		hints.push(colors.cyan('--force') + colors.gray(' to ignore cache'));
	}
	if (hasFix) {
		hints.push(colors.cyan('--fix') + colors.gray(' to apply fixes'));
	}
	const deprecatedFlag = process.argv.find(arg => arg.endsWith('-projects'));
	if (deprecatedFlag) {
		hints.push(
			colors.cyan(deprecatedFlag.slice(0, -1))
				+ colors.gray(' instead of ')
				+ colors.cyan(deprecatedFlag),
		);
	}

	let line = counters.join(colors.gray(' · '));
	if (hints.length) {
		const hintText = colors.gray('use ') + hints.join(colors.gray(', '));
		line = line
			? line + colors.gray(' (') + hintText + colors.gray(')')
			: hintText;
	}
	if (line) {
		summaryLines.push(line);
	}

	renderer.summary(summaryLines);

	if (process.argv.includes('--debug-estree')) {
		// compat-eslint's lazy-estree publishes a per-`type` counter on
		// globalThis under Symbol.for('@tsslint/compat-eslint:node-type-counts')
		// when TSSLINT_DEBUG_ESTREE=1 (set above before any import). Reading
		// from the shared global side-steps Node's per-package module-
		// resolution: the user's project typically loads compat-eslint
		// from its OWN node_modules, while a `require()` here would land
		// on the CLI's neighbour copy — different module instances,
		// different counters. globalThis closes that gap.
		const COUNTS_KEY = Symbol.for('@tsslint/compat-eslint:node-type-counts');
		const SOURCE_COUNTS_KEY = Symbol.for('@tsslint/compat-eslint:node-type-source-counts');
		const counts = (globalThis as any)[COUNTS_KEY] as Map<string, number> | undefined;
		// Source attribution: each (type, source) pair counted separately.
		// Source enum: leaf-direct (visitor / scope-manager called materialise),
		// leaf-resolve (resolveParent walked into this kind), child (top-down
		// slot getter or wrapper construction), root (parent === null).
		const sourceCounts = (globalThis as any)[SOURCE_COUNTS_KEY] as Map<string, number> | undefined;
		const sorted = counts
			? [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
			: [];
		const total = sorted.reduce((s, [, n]) => s + n, 0);
		const widthName = sorted.reduce((w, [n]) => Math.max(w, n.length), 0);
		renderer.info(
			colors.cyan('estree node types')
				+ colors.gray(` (${sorted.length} kinds, ${total.toLocaleString()} nodes)`),
		);
		const SOURCES = ['leaf-direct', 'leaf-resolve', 'child', 'root'] as const;
		const sourceWidths = SOURCES.map(s => s.length);
		for (const [name, n] of sorted) {
			let line = '  ' + name.padEnd(widthName) + '  ' + colors.gray(n.toLocaleString().padStart(8));
			if (sourceCounts) {
				const parts: string[] = [];
				for (let i = 0; i < SOURCES.length; i++) {
					const s = SOURCES[i];
					const c = sourceCounts.get(name + '|' + s) ?? 0;
					if (c > 0) parts.push(`${s}=${c.toLocaleString()}`);
					sourceWidths[i] = Math.max(sourceWidths[i], s.length);
				}
				if (parts.length) line += colors.gray('  [' + parts.join(', ') + ']');
			}
			renderer.info(line);
		}
		if (!sorted.length) {
			renderer.info(colors.gray('  (no nodes converted — no @tsslint/compat-eslint rules ran)'));
		}
		else if (sourceCounts) {
			// Roll-up: total per source across all kinds.
			const rollup = new Map<string, number>();
			for (const [k, n] of sourceCounts) {
				const src = k.slice(k.lastIndexOf('|') + 1);
				rollup.set(src, (rollup.get(src) ?? 0) + n);
			}
			const rollupParts: string[] = [];
			for (const s of SOURCES) {
				const n = rollup.get(s) ?? 0;
				if (n > 0) rollupParts.push(`${s}=${n.toLocaleString()}`);
			}
			renderer.info(colors.gray('  total by source: ' + rollupParts.join(', ')));
		}
	}

	exit((errors || messages || configErrors) ? 1 : 0);

	async function startWorker() {
		const unfinishedProjects = projects.filter(project => project.currentFileIndex < project.fileNames.length);
		if (!unfinishedProjects.length) {
			return;
		}
		const project = unfinishedProjects.find(project => !project.started);
		if (!project) {
			return;
		}
		project.started = true;

		if (project.pendingHeader) {
			renderer.info(project.pendingHeader);
			project.pendingHeader = undefined;
		}

		const setupResult = await worker.setup(
			project.configFile!,
			project.tsconfig,
			project.cacheData,
		);
		if (setupResult !== true) {
			renderer.diagnostic(formatConfigError(project.configFile!, setupResult));
			configErrors++;
			projects = projects.filter(p => p !== project);
			await startWorker();
			return;
		}

		while (project.currentFileIndex < project.fileNames.length) {
			const fileName = project.fileNames[project.currentFileIndex++];

			if (!fs.statSync(fileName, { throwIfNoEntry: false })) {
				continue;
			}

			if (project.cacheData.files[fileName]) {
				cached++;
			}

			const diagnostics = worker.lint(fileName, process.argv.includes('--fix'));

			if (diagnostics.length) {
				// A cache hit didn't run any rule this session, so its fixes
				// are only known from the cache entry.
				hasFix ||= worker.hasCodeFixes(fileName) || !!project.cacheData.files[fileName]?.hasFix;

				for (const diagnostic of diagnostics) {
					const output = format.formatDiagnostic(diagnostic, worker.getSourceFile(fileName)!, worker.getApi());
					if (output === undefined) {
						continue;
					}

					if (diagnostic.category === DiagnosticCategory.Error) {
						errors++;
						renderer.diagnostic(output);
					}
					else if (diagnostic.category === DiagnosticCategory.Warning) {
						warnings++;
						if (!failuresOnly) {
							renderer.diagnostic(output);
						}
					}
					else if (diagnostic.category === DiagnosticCategory.Message) {
						messages++;
						renderer.diagnostic(output);
					}
					else {
						suggestions++;
						if (!failuresOnly) {
							renderer.diagnostic(output);
						}
					}
				}
			}
			else if (worker.hasRules(fileName)) {
				passed++;
			}
			processed++;
		}

		cache.saveCache(project.tsconfig, project.configFile!, tsVersion, project.cacheData);

		await startWorker();
	}

	function resolvePath(p: string) {
		if (
			!path.isAbsolute(p)
			&& !p.startsWith('./')
			&& !p.startsWith('../')
		) {
			p = `./${p}`;
		}
		try {
			return require.resolve(p, { paths: [process.cwd()] });
		}
		catch {
			fail(`No such file: ${p}.`);
		}
	}
})();

function plural(n: number, word: string) {
	return n === 1 ? word : word + 's';
}

function formatConfigError(configFile: string, errorText: string): string {
	const relConfig = path.relative(process.cwd(), configFile);
	const lines = errorText.split('\n').map(l => l.trimEnd()).filter(l => l);
	const out: string[] = [];
	out.push(colors.cyan(relConfig) + colors.gray(' — ') + colors.red('config failed to load'));
	for (const line of lines) {
		if (line.trimStart().startsWith('at ')) {
			out.push('  ' + colors.gray(line.trim()));
		}
		else {
			out.push(line);
		}
	}
	return out.join('\n');
}

function findConfigFile(dir: string): string | undefined {
	while (true) {
		const configFile = path.join(dir, 'tsslint.config.ts');
		if (fs.statSync(configFile, { throwIfNoEntry: false })?.isFile()) {
			return configFile;
		}
		const parent = path.dirname(dir);
		if (parent === dir) {
			return undefined;
		}
		dir = parent;
	}
}
