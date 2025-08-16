import ts = require('typescript');
import path = require('path');
import core = require('@tsslint/core');
import cache = require('./lib/cache.js');
import worker = require('./lib/worker.js');
import glob = require('glob');
import fs = require('fs');
import os = require('os');
import languagePlugins = require('./lib/languagePlugins.js');

process.env.TSSLINT_CLI = '1';

const _reset = '\x1b[0m';
const purple = (s: string) => '\x1b[35m' + s + _reset;
const cyan = (s: string) => '\x1b[36m' + s + _reset;
const darkGray = (s: string) => '\x1b[90m' + s + _reset;
const lightRed = (s: string) => '\x1b[91m' + s + _reset;
const lightGreen = (s: string) => '\x1b[92m' + s + _reset;
const lightYellow = (s: string) => '\x1b[93m' + s + _reset;
const lightBlue = (s: string) => '\x1b[94m' + s + _reset;

// https://talyian.github.io/ansicolors/
const tsColor = (s: string) => '\x1b[34m' + s + _reset;
const tsMacroColor = (s: string) => '\x1b[38;5;135m' + s + _reset;
const vueColor = (s: string) => '\x1b[32m' + s + _reset;
const vueVineColor = (s: string) => '\x1b[38;5;48m' + s + _reset;
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
	workers: ReturnType<typeof worker.create>[] = [];
	fileNames: string[] = [];
	options: ts.CompilerOptions = {};
	configFile: string | undefined;
	currentFileIndex = 0;
	builtConfig: string | undefined;
	cache: cache.CacheData = {};

	constructor(
		public tsconfig: string,
		public languages: string[]
	) { }

	async init(
		// @ts-expect-error
		clack: typeof import('@clack/prompts')
	) {
		this.configFile = ts.findConfigFile(path.dirname(this.tsconfig), ts.sys.fileExists, 'tsslint.config.ts');

		const labels: string[] = [];

		if (this.languages.length === 0) {
			labels.push(tsColor('TS'));
		} else {
			if (this.languages.includes('ts-macro')) {
				labels.push(tsMacroColor('TS Macro'));
			}
			if (this.languages.includes('vue')) {
				labels.push(vueColor('Vue'));
			}
			if (this.languages.includes('vue-vine')) {
				labels.push(vueVineColor('Vue Vine'));
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
	const tsconfigAndLanguages = new Map<string, string[]>();
	const isTTY = process.stdout.isTTY;

	let projects: Project[] = [];
	let spinner = isTTY ? clack.spinner() : undefined;
	let spinnerStopingWarn = false;
	let hasFix = false;
	let allFilesNum = 0;
	let processed = 0;
	let excluded = 0;
	let passed = 0;
	let errors = 0;
	let warnings = 0;
	let messages = 0;
	let cached = 0;

	if (isTTY) {
		const write = process.stdout.write.bind(process.stdout);
		process.stdout.write = (...args) => {
			if (spinnerStopingWarn && typeof args[0] === 'string') {
				args[0] = args[0].replace('▲', lightYellow('▲'));
			}
			// @ts-ignore
			return write(...args);
		};
	}

	if (
		![
			'--project',
			'--projects',
			'--vue-project',
			'--vue-projects',
			'--vue-vine-project',
			'--vue-vine-projects',
			'--mdx-project',
			'--mdx-projects',
			'--astro-project',
			'--astro-projects',
			'--ts-macro-project',
			'--ts-macro-projects',
		].some(flag => process.argv.includes(flag))
	) {
		const language = await clack.select({
			message: 'Select framework',
			initialValue: undefined,
			options: [{
				label: 'Vanilla JS/TS',
				value: undefined,
			}, {
				label: 'TS Macro',
				value: 'ts-macro',
			}, {
				label: 'Vue',
				value: 'vue',
			}, {
				label: 'Vue Vine',
				value: 'vue-vine',
			}, {
				label: 'MDX',
				value: 'mdx',
			}, {
				label: 'Astro',
				value: 'astro',
			}],
		});

		if (clack.isCancel(language)) {
			process.exit(1);
		}

		const tsconfigOptions = glob.sync('**/{tsconfig.json,tsconfig.*.json,jsconfig.json}');

		let options = await Promise.all(
			tsconfigOptions.map(async tsconfigOption => {
				const tsconfig = require.resolve(
					tsconfigOption.startsWith('.') ? tsconfigOption : `./${tsconfigOption}`,
					{ paths: [process.cwd()] }
				);
				try {
					const commonLine = await parseCommonLine(tsconfig, language ? [language] : []);
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

		if (options.some(option => !option!.label.endsWith('(0)'))) {
			options = options.filter(option => !option!.label.endsWith('(0)'));
		}

		if (!options.length) {
			clack.log.error(lightRed('No projects found.'));
			process.exit(1);
		}

		const selectedTsconfigs = await clack.multiselect({
			message: 'Select one or multiple projects',
			initialValues: [options[0]!.value],
			// @ts-expect-error
			options,
		});

		if (clack.isCancel(selectedTsconfigs)) {
			process.exit(1);
		}

		let command = 'tsslint';

		if (!language) {
			command += ' --project ' + selectedTsconfigs.join(' ');
		} else {
			command += ` --${language}-project ` + selectedTsconfigs.join(' ');
		}

		clack.log.info(`${darkGray('Command:')} ${purple(command)}`);

		for (let tsconfig of selectedTsconfigs) {
			tsconfig = resolvePath(tsconfig);
			tsconfigAndLanguages.set(tsconfig, language ? [language] : []);
		}
	} else {
		const options = [
			{
				projectFlags: ['--project', '--projects'],
				language: undefined,
			},
			{
				projectFlags: ['--vue-project', '--vue-projects'],
				language: 'vue',
			},
			{
				projectFlags: ['--vue-vine-project', '--vue-vine-projects'],
				language: 'vue-vine',
			},
			{
				projectFlags: ['--mdx-project', '--mdx-projects'],
				projectsFlag: '--mdx-projects',
				language: 'mdx',
			},
			{
				projectFlags: ['--astro-project', '--astro-projects'],
				language: 'astro',
			},
			{
				projectFlags: ['--ts-macro-project', '--ts-macro-projects'],
				language: 'ts-macro',
			},
		];
		for (const { projectFlags, language } of options) {
			const projectFlag = projectFlags.find(flag => process.argv.includes(flag));
			if (!projectFlag) {
				continue;
			}
			let foundArg = false;
			const projectsIndex = process.argv.indexOf(projectFlag);
			for (let i = projectsIndex + 1; i < process.argv.length; i++) {
				if (process.argv[i].startsWith('-')) {
					break;
				}
				foundArg = true;
				const searchGlob = process.argv[i];
				const tsconfigs = glob.sync(searchGlob);
				if (!tsconfigs.length) {
					clack.log.error(lightRed(`No projects found for ${projectFlag} ${searchGlob}.`));
					process.exit(1);
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
				clack.log.error(lightRed(`Missing argument for ${projectFlag}.`));
				process.exit(1);
			}
		}
	}

	for (const [tsconfig, languages] of tsconfigAndLanguages) {
		projects.push(await new Project(tsconfig, languages).init(clack));
	}

	spinner?.start();

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
		(spinner?.stop ?? clack.log.message)(lightYellow('No input files.'));
		process.exit(1);
	}

	if (isTTY || threads >= 2) {
		await Promise.all(new Array(threads).fill(0).map(() => {
			return startWorker(worker.create());
		}));
	} else {
		await startWorker(worker.createLocal() as any);
	}

	(spinner?.stop ?? clack.log.message)(
		cached
			? darkGray(`Processed ${processed} files with cache. (Use `) + cyan(`--force`) + darkGray(` to ignore cache.)`)
			: darkGray(`Processed ${processed} files.`)
	);

	const projectsFlag = process.argv.find(arg => arg.endsWith('-projects'));
	if (projectsFlag) {
		clack.log.warn(
			darkGray(`Please use `)
			+ cyan(`${projectsFlag.slice(0, -1)}`)
			+ darkGray(` instead of `)
			+ cyan(`${projectsFlag}`)
			+ darkGray(` starting from version 1.5.0.`)
		);
	}

	const data = [
		[passed, 'passed', lightGreen] as const,
		[errors, 'errors', lightRed] as const,
		[warnings, 'warnings', lightYellow] as const,
		[messages, 'messages', lightBlue] as const,
		[excluded, 'excluded', darkGray] as const,
	];
	const hasFailed = !!(errors || warnings || messages);

	let summary = data
		.filter(([count]) => count)
		.map(([count, label, color]) => color(`${count} ${label}`))
		.join(darkGray(' | '));

	if (hasFix) {
		summary += darkGray(` (Use `) + cyan(`--fix`) + darkGray(` to apply automatic fixes.)`);
	} else if (hasFailed) {
		summary += darkGray(` (No fixes available.)`);
	}

	clack.outro(summary);
	process.exit(hasFailed ? 1 : 0);

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
			project.options,
		);
		if (!setupSuccess) {
			projects = projects.filter(p => p !== project);
			startWorker(linterWorker);
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

			let diagnostics = await linterWorker.lint(
				fileName,
				process.argv.includes('--fix'),
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
					else if (diagnostic.category === ts.DiagnosticCategory.Message) {
						messages++;
						log(output);
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

			removeProcessFile(
				fileName,
				project.currentFileIndex < project.fileNames.length
					? project.fileNames[project.currentFileIndex]
					: undefined
			);
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

	function removeProcessFile(fileName: string, nextFileName?: string) {
		processFiles.delete(fileName);
		updateSpinner(nextFileName);
	}

	function updateSpinner(nextFileName?: string) {
		let msg: string | undefined;
		if (processFiles.size === 0) {
			if (nextFileName) {
				msg = darkGray(`[${processed + processFiles.size}/${allFilesNum}] ${path.relative(process.cwd(), nextFileName)}`);
			}
		}
		else if (processFiles.size === 1) {
			msg = darkGray(`[${processed + processFiles.size}/${allFilesNum}] ${path.relative(process.cwd(), [...processFiles][0])}`);
		} else {
			msg = darkGray(`[${processed + processFiles.size}/${allFilesNum}] Processing ${processFiles.size} files`);
		}
		if (!spinner && isTTY) {
			spinner = clack.spinner();
			spinner.start(msg);
		} else {
			spinner?.message(msg);
		}
	}

	function log(msg: string, code?: number) {
		if (spinner) {
			spinnerStopingWarn = code === 2;
			spinner.stop(msg, code);
			spinnerStopingWarn = false;
			spinner = undefined;
		} else {
			if (code === 1) {
				clack.log.error(msg);
			} else if (code === 2) {
				clack.log.warn(msg);
			} else if (code === 3) {
				clack.log.message(msg);
			} else {
				clack.log.step(msg);
			}
		}
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
		} catch {
			clack.log.error(lightRed(`No such file: ${p}`));
			process.exit(1);
		}
	}
})();

async function parseCommonLine(tsconfig: string, languages: string[]) {
	const jsonConfigFile = ts.readJsonConfigFile(tsconfig, ts.sys.readFile);
	const plugins = await languagePlugins.load(tsconfig, languages);
	const extraFileExtensions = plugins.flatMap(plugin => plugin.typescript?.extraFileExtensions ?? []).flat();
	return ts.parseJsonSourceFileConfigFileContent(jsonConfigFile, ts.sys, path.dirname(tsconfig), {}, tsconfig, undefined, extraFileExtensions);
}
