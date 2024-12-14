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

(async () => {
	class Project {
		tsconfig: string;
		workers: ReturnType<typeof worker.create>[] = [];
		fileNames: string[] = [];
		options: ts.CompilerOptions = {};
		configFile: string | undefined;
		currentFileIndex = 0;
		builtConfig: string | undefined;
		cache: cache.CacheData = {};

		constructor(tsconfigOption: string) {
			try {
				this.tsconfig = require.resolve(tsconfigOption, { paths: [process.cwd()] });
			} catch {
				console.error(lightRed(`No such file: ${tsconfigOption}`));
				process.exit(1);
			}
			this.configFile = ts.findConfigFile(path.dirname(this.tsconfig), ts.sys.fileExists, 'tsslint.config.ts');

			if (!this.configFile) {
				log(`${purple('[project]')} ${path.relative(process.cwd(), this.tsconfig)} ${darkGray('(No tsslint.config.ts found)')}`);
				return;
			}

			const commonLine = parseCommonLine(this.tsconfig);
			this.fileNames = commonLine.fileNames;
			this.options = commonLine.options;

			if (!this.fileNames.length) {
				log(`${purple('[project]')} ${path.relative(process.cwd(), this.tsconfig)} ${darkGray('(No included files)')}`);
				return;
			}

			log(`${purple('[project]')} ${path.relative(process.cwd(), this.tsconfig)} ${darkGray(`(${this.fileNames.length})`)}`);

			if (!process.argv.includes('--force')) {
				this.cache = cache.loadCache(this.tsconfig, this.configFile, ts.sys.createHash);
			}
		}
	}

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

	spinner.start();

	if (process.argv.includes('--project')) {
		const projectIndex = process.argv.indexOf('--project');
		let tsconfig = process.argv[projectIndex + 1];
		if (!tsconfig || tsconfig.startsWith('-')) {
			console.error(lightRed(`Missing argument for --project.`));
			process.exit(1);
		}
		if (!tsconfig.startsWith('.')) {
			tsconfig = `./${tsconfig}`;
		}
		projects.push(new Project(tsconfig));
	}
	else if (process.argv.includes('--projects')) {
		const projectsIndex = process.argv.indexOf('--projects');
		let foundArg = false;
		for (let i = projectsIndex + 1; i < process.argv.length; i++) {
			if (process.argv[i].startsWith('-')) {
				break;
			}
			foundArg = true;
			const searchGlob = process.argv[i];
			const tsconfigs = glob.sync(searchGlob);
			for (let tsconfig of tsconfigs) {
				if (!tsconfig.startsWith('.')) {
					tsconfig = `./${tsconfig}`;
				}
				projects.push(new Project(tsconfig));
			}
		}
		if (!foundArg) {
			console.error(lightRed(`Missing argument for --projects.`));
			process.exit(1);
		}
	}
	else {
		const tsconfig = await askTSConfig();
		projects.push(new Project(tsconfig));
	}

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
					fileCache[2].length = 0;
					fileCache[3].length = 0;
					fileCache[4] = {};
				}
				else {
					cached++;
				}
			}
			else {
				project.cache[fileName] = fileCache = [fileMtime, {}, [], [], {}];
			}

			let diagnostics!: ts.DiagnosticWithLocation[];

			if (process.argv.includes('--fix')) {
				diagnostics = await linterWorker.lintAndFix(fileName, fileCache);
			} else {
				diagnostics = await linterWorker.lint(fileName, fileCache);
			}

			if (diagnostics.length) {
				hasFix ||= await linterWorker.hasCodeFixes(fileName);

				for (const diagnostic of diagnostics) {
					if (diagnostic.category === ts.DiagnosticCategory.Suggestion) {
						continue;
					}

					let output = ts.formatDiagnosticsWithColorAndContext([diagnostic], {
						getCurrentDirectory: ts.sys.getCurrentDirectory,
						getCanonicalFileName: ts.sys.useCaseSensitiveFileNames ? x => x : x => x.toLowerCase(),
						getNewLine: () => ts.sys.newLine,
					});
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
			} else if (!(await linterWorker.hasRules(fileName, fileCache[4]))) {
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

	async function askTSConfig() {
		const presetConfig = ts.findConfigFile(process.cwd(), ts.sys.fileExists);

		let shortTsconfig = presetConfig ? path.relative(process.cwd(), presetConfig) : undefined;
		if (!shortTsconfig?.startsWith('.')) {
			shortTsconfig = `./${shortTsconfig}`;
		}

		return await clack.text({
			message: 'Select the project. (Use --project or --projects to skip this prompt.)',
			placeholder: shortTsconfig ? `${shortTsconfig} (${parseCommonLine(presetConfig!).fileNames.length} files)` : 'No tsconfig.json/jsconfig.json found, please enter the path to the tsconfig.json/jsconfig.json file.',
			defaultValue: shortTsconfig,
			validate(value) {
				value ||= shortTsconfig;
				try {
					require.resolve(value, { paths: [process.cwd()] });
				} catch {
					return 'No such file.';
				}
			},
		}) as string;
	}

	function parseCommonLine(tsconfig: string) {
		const jsonConfigFile = ts.readJsonConfigFile(tsconfig, ts.sys.readFile);
		const plugins = languagePlugins.load(tsconfig);
		const extraFileExtensions = plugins.flatMap(plugin => plugin.typescript?.extraFileExtensions ?? []).flat();
		return ts.parseJsonSourceFileConfigFileContent(jsonConfigFile, ts.sys, path.dirname(tsconfig), {}, tsconfig, undefined, extraFileExtensions);
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
			spinner.message(`[${processed + processFiles.size}/${allFilesNum}] ${path.relative(process.cwd(), fileName)}`);
		} else {
			spinner.message(`[${processed + processFiles.size}/${allFilesNum}] Processing ${processFiles.size} files`);
		}
	}

	function log(msg: string, code?: number) {
		spinner.stop(msg, code);
		spinner = clack.spinner();
		spinner.start();
	}
})();
