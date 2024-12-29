import ts = require('typescript');
import path = require('path');
import core = require('@tsslint/core');
import cache = require('./lib/cache.js');
import worker = require('./lib/worker.js');
import glob = require('glob');
import fs = require('fs');
import os = require('os');
import languagePlugins = require('./lib/languagePlugins.js');

const _reset = '\x1b[0m';
const purple = (s: string) => '\x1b[35m' + s + _reset;
const darkGray = (s: string) => '\x1b[90m' + s + _reset;
const lightRed = (s: string) => '\x1b[91m' + s + _reset;
const lightGreen = (s: string) => '\x1b[92m' + s + _reset;
const lightYellow = (s: string) => '\x1b[93m' + s + _reset;

// https://talyian.github.io/ansicolors/
const tsColor = (s: string) => '\x1b[34m' + s + _reset;
const vueColor = (s: string) => '\x1b[32m' + s + _reset;
const mdxColor = (s: string) => '\x1b[33m' + s + _reset;
const astroColor = (s: string) => '\x1b[38;5;209m' + s + _reset;

let threads = 1;

if (process.argv.includes('--threads')) {
	const threadsIndex = process.argv.indexOf('--threads');
	const threadsArg = process.argv[threadsIndex + 1];
	if (!threadsArg || threadsArg.startsWith('-')) {
		console.error(lightRed(`Missing argument for --threads.`));
		process.exit(1);
	}
	threads = Math.min(os.availableParallelism(), Number(threadsArg));
}

class Project {
	tsconfig: string;
	workers: ReturnType<typeof worker.create>[] = [];
	fileNames: string[] = [];
	options: ts.CompilerOptions = {};
	configFile: string | undefined;
	currentFileIndex = 0;
	builtConfig: string | undefined;
	cache: cache.CacheData = {};

	constructor(
		tsconfigOption: string,
		public languages: string[]
	) {
		try {
			this.tsconfig = require.resolve(tsconfigOption, { paths: [process.cwd()] });
		} catch {
			console.error(lightRed(`No such file: ${tsconfigOption}`));
			process.exit(1);
		}

	}

	async init(
		// @ts-expect-error
		clack: typeof import('@clack/prompts')
	) {
		this.configFile = ts.findConfigFile(path.dirname(this.tsconfig), ts.sys.fileExists, 'tsslint.config.ts');

		const labels: string[] = [];

		if (this.languages.length === 0) {
			labels.push(tsColor('TS'));
		} else {
			if (this.languages.includes('vue')) {
				labels.push(vueColor('Vue'));
			}
			if (this.languages.includes('mdx')) {
				labels.push(mdxColor('MDX'));
			}
			if (this.languages.includes('astro')) {
				labels.push(astroColor('Astro'));
			}
		}

		const label = labels.join(darkGray(' | '));

		if (!this.configFile) {
			clack.log.error(`${label} ${path.relative(process.cwd(), this.tsconfig)} ${darkGray('(No tsslint.config.ts found)')}`);
			return this;
		}

		const commonLine = await parseCommonLine(this.tsconfig, this.languages);

		this.fileNames = commonLine.fileNames;
		this.options = commonLine.options;

		if (!this.fileNames.length) {
			clack.log.warn(`${label} ${path.relative(process.cwd(), this.tsconfig)} ${darkGray('(No included files)')}`);
			return this;
		}

		clack.log.info(`${label} ${path.relative(process.cwd(), this.tsconfig)} ${darkGray(`(${this.fileNames.length})`)}`);

		if (!process.argv.includes('--force')) {
			this.cache = cache.loadCache(this.tsconfig, this.configFile, ts.sys.createHash);
		}

		return this;
	}
}

(async () => {
	const builtConfigs = new Map<string, Promise<string | undefined>>();
	const clack = await import('@clack/prompts');
	const processFiles = new Set<string>();

	let projects: Project[] = [];
	let spinner = clack.spinner();
	let lastSpinnerUpdate = Date.now();
	let hasFix = false;
	let allFilesNum = 0;
	let processed = 0;
	let excluded = 0;
	let passed = 0;
	let errors = 0;
	let warnings = 0;
	let cached = 0;

	const tsconfigAndLanguages = new Map<string, string[]>();

	if (
		!process.argv.includes('--project')
		&& !process.argv.includes('--projects')
		&& !process.argv.includes('--vue-project')
		&& !process.argv.includes('--vue-projects')
		&& !process.argv.includes('--mdx-project')
		&& !process.argv.includes('--mdx-projects')
		&& !process.argv.includes('--astro-project')
		&& !process.argv.includes('--astro-projects')
	) {
		const languages = await clack.multiselect({
			required: false,
			message: 'Select frameworks (optional)',
			options: [{
				label: 'Vue',
				value: 'vue',
			}, {
				label: 'MDX',
				value: 'mdx',
			}, {
				label: 'Astro',
				value: 'astro',
			}],
		}) as string[];

		if (clack.isCancel(languages)) {
			process.exit(1);
		}

		const tsconfigOptions = glob.sync('**/{tsconfig.json,jsconfig.json}');

		let options = await Promise.all(
			tsconfigOptions.map(async tsconfigOption => {
				const tsconfig = require.resolve(
					tsconfigOption.startsWith('.') ? tsconfigOption : `./${tsconfigOption}`,
					{ paths: [process.cwd()] }
				);
				try {
					const commonLine = await parseCommonLine(tsconfig, languages);
					return {
						label: path.relative(process.cwd(), tsconfig) + ` (${commonLine.fileNames.length})`,
						value: tsconfigOption,
					};
				} catch {
					return undefined;
				}
			})
		);

		options = options.filter(option => !!option);

		if (!options.length) {
			clack.log.error(lightRed('No projects found.'));
			process.exit(1);
		}

		const selectedTsconfigs = await clack.multiselect({
			message: 'Select one or multiple projects',
			// @ts-expect-error
			options,
		});

		if (clack.isCancel(selectedTsconfigs)) {
			process.exit(1);
		}

		let command = 'tsslint';

		if (!languages.length) {
			if (selectedTsconfigs.length === 1) {
				command += ' --project ' + selectedTsconfigs[0];
			} else {
				command += ' --projects ' + selectedTsconfigs.join(' ');
			}
		} else {
			for (const language of languages) {
				if (selectedTsconfigs.length === 1) {
					command += ` --${language}-project ` + selectedTsconfigs[0];
				} else {
					command += ` --${language}-projects ` + selectedTsconfigs.join(' ');
				}
			}
		}

		clack.log.info(`Running: ${purple(command)}`);

		for (let tsconfig of selectedTsconfigs) {
			if (!tsconfig.startsWith('.')) {
				tsconfig = `./${tsconfig}`;
			}
			tsconfigAndLanguages.set(tsconfig, languages);
		}
	} else {
		const options = [
			{
				projectFlag: '--project',
				projectsFlag: '--projects',
				language: undefined,
			},
			{
				projectFlag: '--vue-project',
				projectsFlag: '--vue-projects',
				language: 'vue',
			},
			{
				projectFlag: '--mdx-project',
				projectsFlag: '--mdx-projects',
				language: 'mdx',
			},
			{
				projectFlag: '--astro-project',
				projectsFlag: '--astro-projects',
				language: 'astro',
			},
		];
		for (const { projectFlag, projectsFlag, language } of options) {
			if (process.argv.includes(projectFlag)) {
				const projectIndex = process.argv.indexOf(projectFlag);
				let tsconfig = process.argv[projectIndex + 1];
				if (!tsconfig || tsconfig.startsWith('-')) {
					clack.log.error(lightRed(`Missing argument for ${projectFlag}.`));
					process.exit(1);
				}
				if (!tsconfig.startsWith('.')) {
					tsconfig = `./${tsconfig}`;
				}
				if (!tsconfigAndLanguages.has(tsconfig)) {
					tsconfigAndLanguages.set(tsconfig, []);
				}
				if (language) {
					tsconfigAndLanguages.get(tsconfig)!.push(language);
				}
			}
			if (process.argv.includes(projectsFlag)) {
				const projectsIndex = process.argv.indexOf(projectsFlag);
				let foundArg = false;
				for (let i = projectsIndex + 1; i < process.argv.length; i++) {
					if (process.argv[i].startsWith('-')) {
						break;
					}
					foundArg = true;
					const searchGlob = process.argv[i];
					const tsconfigs = glob.sync(searchGlob);
					if (!tsconfigs.length) {
						clack.log.error(lightRed(`No projects found for ${projectsFlag} ${searchGlob}.`));
						process.exit(1);
					}
					for (let tsconfig of tsconfigs) {
						if (!tsconfig.startsWith('.')) {
							tsconfig = `./${tsconfig}`;
						}
						if (!tsconfigAndLanguages.has(tsconfig)) {
							tsconfigAndLanguages.set(tsconfig, []);
						}
						if (language) {
							tsconfigAndLanguages.get(tsconfig)!.push(language);
						}
					}
				}
				if (!foundArg) {
					clack.log.error(lightRed(`Missing argument for ${projectsFlag}.`));
					process.exit(1);
				}
			}
		}
	}

	for (const [tsconfig, languages] of tsconfigAndLanguages) {
		projects.push(await new Project(tsconfig, languages).init(clack));
	}

	spinner.start();

	projects = projects.filter(project => !!project.configFile);
	projects = projects.filter(project => !!project.fileNames.length);
	for (const project of projects) {
		project.builtConfig = await getBuiltConfig(project.configFile!);
	}
	projects = projects.filter(project => !!project.builtConfig);
	for (const project of projects) {
		allFilesNum += project.fileNames.length;
	}

	if (allFilesNum === 0) {
		spinner.stop(lightYellow('No input files.'));
		process.exit(1);
	}

	if (threads === 1) {
		await startWorker(worker.createLocal() as any);
	} else {
		await Promise.all(new Array(threads).fill(0).map(() => {
			return startWorker(worker.create());
		}));
	}

	spinner.stop(
		darkGray(
			cached
				? `Processed ${processed} files with cache. (Use --force to ignore cache.)`
				: `Processed ${processed} files.`
		)
	);

	const data = [
		[passed, 'passed', lightGreen] as const,
		[errors, 'errors', lightRed] as const,
		[warnings, 'warnings', lightYellow] as const,
		[excluded, 'excluded', darkGray] as const,
	];

	let summary = data
		.filter(([count]) => count)
		.map(([count, label, color]) => color(`${count} ${label}`))
		.join(darkGray(' | '));

	if (hasFix) {
		summary += darkGray(` (Use --fix to apply automatic fixes.)`);
	} else if (errors || warnings) {
		summary += darkGray(` (No fixes available.)`);
	}

	clack.outro(summary);
	process.exit(errors ? 1 : 0);

	async function startWorker(linterWorker: ReturnType<typeof worker.create>) {
		const unfinishedProjects = projects.filter(project => project.currentFileIndex < project.fileNames.length);
		if (!unfinishedProjects.length) {
			return;
		}
		// Select a project that has not has a worker yet
		let project = unfinishedProjects.find(project => !project.workers.length);
		if (!project) {
			// Choose a project with the most files left per worker
			project = unfinishedProjects.sort((a, b) => {
				const aFilesPerWorker = (a.fileNames.length - a.currentFileIndex) / a.workers.length;
				const bFilesPerWorker = (b.fileNames.length - b.currentFileIndex) / b.workers.length;
				return bFilesPerWorker - aFilesPerWorker;
			})[0];
		}
		project.workers.push(linterWorker);

		const setupSuccess = await linterWorker.setup(
			project.tsconfig,
			project.languages,
			project.configFile!,
			project.builtConfig!,
			project.fileNames,
			project.options
		);
		if (!setupSuccess) {
			projects = projects.filter(p => p !== project);
			startWorker(linterWorker);
			return;
		}

		while (project.currentFileIndex < project.fileNames.length) {
			const i = project.currentFileIndex++;
			const fileName = project.fileNames[i];
			const fileMtime = fs.statSync(fileName).mtimeMs;

			addProcessFile(fileName);

			if (Date.now() - lastSpinnerUpdate > 100) {
				lastSpinnerUpdate = Date.now();
				await new Promise(resolve => setTimeout(resolve, 0));
			}

			let fileCache = project.cache[fileName];
			if (fileCache) {
				if (fileCache[0] !== fileMtime) {
					fileCache[0] = fileMtime;
					fileCache[1] = {};
					fileCache[2] = {};
				}
				else {
					cached++;
				}
			}
			else {
				project.cache[fileName] = fileCache = [fileMtime, {}, {}];
			}

			let diagnostics = await linterWorker.lint(
				fileName,
				process.argv.includes('--fix'),
				process.argv.includes('--format')
					? {} // TODO
					: undefined,
				fileCache
			);

			diagnostics = diagnostics.filter(diagnostic => diagnostic.category !== ts.DiagnosticCategory.Suggestion);

			if (diagnostics.length) {
				hasFix ||= await linterWorker.hasCodeFixes(fileName);

				for (const diagnostic of diagnostics) {
					hasFix ||= !!fileCache[1][diagnostic.code]?.[0];

					let output = ts.formatDiagnosticsWithColorAndContext([diagnostic], {
						getCurrentDirectory: ts.sys.getCurrentDirectory,
						getCanonicalFileName: ts.sys.useCaseSensitiveFileNames ? x => x : x => x.toLowerCase(),
						getNewLine: () => ts.sys.newLine,
					});
					output = output.trimEnd();
					output = output.replace(`TS${diagnostic.code}`, String(diagnostic.code));

					if (diagnostic.category === ts.DiagnosticCategory.Error) {
						errors++;
						log(output, 1);
					}
					else if (diagnostic.category === ts.DiagnosticCategory.Warning) {
						warnings++;
						log(output, 2);
					}
					else {
						log(output);
					}
				}
			} else if (!(await linterWorker.hasRules(fileName, fileCache[2]))) {
				excluded++;
			} else {
				passed++;
			}
			processed++;

			removeProcessFile(fileName);
		}

		cache.saveCache(project.tsconfig, project.configFile!, project.cache, ts.sys.createHash);

		await startWorker(linterWorker);
	}

	async function getBuiltConfig(configFile: string) {
		if (!builtConfigs.has(configFile)) {
			builtConfigs.set(configFile, core.buildConfig(configFile, ts.sys.createHash, spinner, (s, code) => log(darkGray(s), code)));
		}
		return await builtConfigs.get(configFile);
	}

	function addProcessFile(fileName: string) {
		processFiles.add(fileName);
		updateSpinner();
	}

	function removeProcessFile(fileName: string) {
		processFiles.delete(fileName);
		updateSpinner();
	}

	function updateSpinner() {
		if (processFiles.size === 1) {
			const fileName = processFiles.values().next().value!;
			spinner.message(darkGray(`[${processed + processFiles.size}/${allFilesNum}] ${path.relative(process.cwd(), fileName)}`));
		} else {
			spinner.message(darkGray(`[${processed + processFiles.size}/${allFilesNum}] Processing ${processFiles.size} files`));
		}
	}

	function log(msg: string, code?: number) {
		spinner.stop(msg, code);
		spinner = clack.spinner();
		spinner.start();
	}
})();

async function parseCommonLine(tsconfig: string, languages: string[]) {
	const jsonConfigFile = ts.readJsonConfigFile(tsconfig, ts.sys.readFile);
	const plugins = await languagePlugins.load(tsconfig, languages);
	const extraFileExtensions = plugins.flatMap(plugin => plugin.typescript?.extraFileExtensions ?? []).flat();
	return ts.parseJsonSourceFileConfigFileContent(jsonConfigFile, ts.sys, path.dirname(tsconfig), {}, tsconfig, undefined, extraFileExtensions);
}
