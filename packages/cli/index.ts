// Patch fs before anything else loads — resolver-heavy plugins (import-x in
// particular) pound on statSync per file and benefit from in-process caching.
require('./lib/fs-cache.js');

import ts = require('typescript');
import path = require('path');
import cache = require('./lib/cache.js');
import worker = require('./lib/worker.js');
import fs = require('fs');
import minimatch = require('minimatch');
import languagePlugins = require('./lib/languagePlugins.js');
import colors = require('./lib/colors.js');
import render = require('./lib/render.js');

process.env.TSSLINT_CLI = '1';

const HELP = `
Usage: tsslint [options]

Options:
  --project <glob...>           Lint TypeScript/JavaScript projects
  --vue-project <glob...>       Lint Vue projects
  --vue-vine-project <glob...>  Lint Vue Vine projects
  --mdx-project <glob...>       Lint MDX projects
  --astro-project <glob...>     Lint Astro projects
  --ts-macro-project <glob...>  Lint TS Macro projects
  --filter <glob...>            Filter files to lint
  --fix                         Apply automatic fixes
  --force                       Ignore cache
  --failures-only               Only print errors and messages (skip warnings and suggestions)
  -h, --help                    Show this help message

Examples:
  # Single project
  tsslint --project tsconfig.json

  # Multiple projects with glob
  tsslint --project packages/*/tsconfig.json

  # Multiple projects with brace expansion
  tsslint --project {tsconfig.json,packages/*/tsconfig.json}

  # Mixed framework projects
  tsslint --project packages/*/tsconfig.json --vue-project apps/web/tsconfig.json

  # With filter and fix
  tsslint --project tsconfig.json --filter "src/**/*.ts" --fix
`;

if (process.argv.includes('--help') || process.argv.includes('-h')) {
	console.log(HELP);
	process.exit(0);
}

const PROJECT_FLAGS = [
	{ flag: '--project', language: undefined },
	{ flag: '--vue-project', language: 'vue' },
	{ flag: '--vue-vine-project', language: 'vue-vine' },
	{ flag: '--mdx-project', language: 'mdx' },
	{ flag: '--astro-project', language: 'astro' },
	{ flag: '--ts-macro-project', language: 'ts-macro' },
] as const;

const LANGUAGE_LABELS = [
	{ key: 'ts-macro', label: 'TS Macro', color: colors.tsMacroColor },
	{ key: 'vue', label: 'Vue', color: colors.vueColor },
	{ key: 'vue-vine', label: 'Vue Vine', color: colors.vueVineColor },
	{ key: 'mdx', label: 'MDX', color: colors.mdxColor },
	{ key: 'astro', label: 'Astro', color: colors.astroColor },
] as const;

class Project {
	worker: ReturnType<typeof worker.create> | undefined;
	/**
	 * file names for passing to ts language service host (getScriptFileNames)
	 */
	rawFileNames: string[] = [];
	/**
	 * file names after filter, for linting process
	 */
	fileNames: string[] = [];
	options: ts.CompilerOptions = {};
	configFile: string | undefined;
	currentFileIndex = 0;
	cache: cache.CacheData = {};
	pendingHeader: string | undefined;

	constructor(
		public tsconfig: string,
		public languages: string[],
	) {}

	async init(renderer: render.Renderer, filesFilter: string[]) {
		this.configFile = ts.findConfigFile(path.dirname(this.tsconfig), ts.sys.fileExists, 'tsslint.config.ts');

		const labels: string[] = [];

		if (this.languages.length === 0) {
			labels.push(colors.tsColor('TS'));
		}
		else {
			for (const { key, label, color } of LANGUAGE_LABELS) {
				if (this.languages.includes(key)) {
					labels.push(color(label));
				}
			}
		}

		const label = labels.join(colors.gray(' | '));
		const relPath = path.relative(process.cwd(), this.tsconfig);

		if (!this.configFile) {
			renderer.info(
				`${label} ${relPath} ${colors.gray('(no tsslint.config.ts)')}`,
			);
			return this;
		}

		const commonLine = await parseCommonLine(this.tsconfig, this.languages);

		this.rawFileNames = commonLine.fileNames;
		this.options = commonLine.options;

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

		if (!process.argv.includes('--force')) {
			this.cache = cache.loadCache(this.tsconfig, this.configFile, this.languages, ts.sys.createHash);
		}

		return this;
	}
}

const formatHost: ts.FormatDiagnosticsHost = {
	getCurrentDirectory: ts.sys.getCurrentDirectory,
	getCanonicalFileName: ts.sys.useCaseSensitiveFileNames ? x => x : x => x.toLowerCase(),
	getNewLine: () => ts.sys.newLine,
};

(async () => {
	const renderer = render.createRenderer();
	const processFiles = new Set<string>();
	const tsconfigAndLanguages = new Map<string, string[]>();

	function fail(msg: string): never {
		renderer.error(colors.red(msg));
		renderer.dispose();
		process.exit(1);
	}

	let projects: Project[] = [];
	let hasFix = false;
	let allFilesNum = 0;
	let processed = 0;
	let passed = 0;
	let errors = 0;
	let warnings = 0;
	let messages = 0;
	let suggestions = 0;
	let cached = 0;
	let configErrors = 0;
	const failuresOnly = process.argv.includes('--failures-only');

	if (!PROJECT_FLAGS.some(({ flag }) => process.argv.includes(flag))) {
		renderer.dispose();
		console.log(HELP);
		process.exit(1);
	}

	for (const { flag, language } of PROJECT_FLAGS) {
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
			const tsconfigs = fs.globSync(searchGlob);
			if (!tsconfigs.length) {
				fail(`No projects found for ${flag} ${searchGlob}.`);
			}
			for (let tsconfig of tsconfigs) {
				tsconfig = resolvePath(tsconfig);
				if (!tsconfigAndLanguages.has(tsconfig)) {
					tsconfigAndLanguages.set(tsconfig, []);
				}
				if (language) {
					tsconfigAndLanguages.get(tsconfig)!.push(language);
				}
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
		return ts.server.toNormalizedPath(filterPath);
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

	for (const [tsconfig, languages] of tsconfigAndLanguages) {
		projects.push(await new Project(tsconfig, languages).init(renderer, filters));
	}

	projects = projects.filter(project => project.configFile && project.fileNames.length);

	for (const project of projects) {
		allFilesNum += project.fileNames.length;
	}

	if (allFilesNum === 0) {
		renderer.info(colors.yellow('No input files.'));
		renderer.dispose();
		process.exit(1);
	}

	if (process.stdout.isTTY) {
		await startWorker(worker.create());
	}
	else {
		await startWorker(worker.createLocal() as any);
	}

	renderer.status();

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
	renderer.dispose();

	process.exit((errors || messages || configErrors) ? 1 : 0);

	async function startWorker(linterWorker: ReturnType<typeof worker.create>) {
		const unfinishedProjects = projects.filter(project => project.currentFileIndex < project.fileNames.length);
		if (!unfinishedProjects.length) {
			return;
		}
		const project = unfinishedProjects.find(project => !project.worker);
		if (!project) {
			return;
		}
		project.worker = linterWorker;

		if (project.pendingHeader) {
			renderer.info(project.pendingHeader);
			project.pendingHeader = undefined;
		}

		const setupResult = await linterWorker.setup(
			project.tsconfig,
			project.languages,
			project.configFile!,
			project.rawFileNames,
			project.options,
		);
		if (setupResult !== true) {
			renderer.diagnostic(formatConfigError(project.configFile!, setupResult));
			configErrors++;
			projects = projects.filter(p => p !== project);
			await startWorker(linterWorker);
			return;
		}

		while (project.currentFileIndex < project.fileNames.length) {
			const fileName = project.fileNames[project.currentFileIndex++];
			addProcessFile(fileName);

			const fileStat = fs.statSync(fileName, { throwIfNoEntry: false });
			if (!fileStat) {
				continue;
			}

			let fileCache = project.cache[fileName];
			if (fileCache) {
				if (fileCache[0] !== fileStat.mtimeMs) {
					fileCache[0] = fileStat.mtimeMs;
					fileCache[1] = {};
					fileCache[2] = {};
				}
				else {
					cached++;
				}
			}
			else {
				project.cache[fileName] = fileCache = [fileStat.mtimeMs, {}, {}];
			}

			const diagnostics = await linterWorker.lint(
				fileName,
				process.argv.includes('--fix'),
				fileCache,
			);

			if (diagnostics.length) {
				hasFix ||= await linterWorker.hasCodeFixes(fileName);

				for (const diagnostic of diagnostics) {
					hasFix ||= !!fileCache[1][diagnostic.code]?.[0];

					let output: string;

					if (diagnostic.category === ts.DiagnosticCategory.Suggestion) {
						output = ts.formatDiagnosticsWithColorAndContext([{
							...diagnostic,
							category: ts.DiagnosticCategory.Message,
						}], formatHost);
						output = output.replace(/\[94mmessage/, '[90msuggestion');
						output = output.replace(/\[94m/g, '[90m');
					}
					else {
						output = ts.formatDiagnosticsWithColorAndContext([diagnostic], formatHost);
					}

					output = output.trimEnd();

					if (typeof diagnostic.code === 'string') {
						output = output.replace(`TS${diagnostic.code}`, diagnostic.code);
					}

					if (diagnostic.category === ts.DiagnosticCategory.Error) {
						errors++;
						renderer.diagnostic(output);
					}
					else if (diagnostic.category === ts.DiagnosticCategory.Warning) {
						warnings++;
						if (!failuresOnly) {
							renderer.diagnostic(output);
						}
					}
					else if (diagnostic.category === ts.DiagnosticCategory.Message) {
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
			else if (await linterWorker.hasRules(fileName, fileCache[2])) {
				passed++;
			}
			processed++;

			removeProcessFile(
				fileName,
				project.currentFileIndex < project.fileNames.length
					? project.fileNames[project.currentFileIndex]
					: undefined,
			);
		}

		cache.saveCache(project.tsconfig, project.configFile!, project.languages, project.cache, ts.sys.createHash);

		await startWorker(linterWorker);
	}

	function addProcessFile(fileName: string) {
		processFiles.add(fileName);
		updateStatus();
	}

	function removeProcessFile(fileName: string, nextFileName?: string) {
		processFiles.delete(fileName);
		updateStatus(nextFileName);
	}

	function updateStatus(nextFileName?: string) {
		let msg: string | undefined;
		if (processFiles.size === 0) {
			if (nextFileName) {
				msg = colors.gray(
					`[${processed + processFiles.size}/${allFilesNum}] ${path.relative(process.cwd(), nextFileName)}`,
				);
			}
		}
		else if (processFiles.size === 1) {
			msg = colors.gray(
				`[${processed + processFiles.size}/${allFilesNum}] ${path.relative(process.cwd(), [...processFiles][0])}`,
			);
		}
		else {
			msg = colors.gray(`[${processed + processFiles.size}/${allFilesNum}] Processing ${processFiles.size} files`);
		}
		renderer.status(msg);
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

async function parseCommonLine(tsconfig: string, languages: string[]) {
	const jsonConfigFile = ts.readJsonConfigFile(tsconfig, ts.sys.readFile);
	const plugins = await languagePlugins.load(tsconfig, languages);
	const extraFileExtensions = plugins.flatMap(plugin => plugin.typescript?.extraFileExtensions ?? []).flat();
	return ts.parseJsonSourceFileConfigFileContent(
		jsonConfigFile,
		ts.sys,
		path.dirname(tsconfig),
		{},
		tsconfig,
		undefined,
		extraFileExtensions,
	);
}
