import ts = require('typescript');
import path = require('path');
import type config = require('@tsslint/config');
import core = require('@tsslint/core');
import cache = require('./lib/cache');
import glob = require('glob');
import url = require('url');
import fs = require('fs');

const _reset = '\x1b[0m';
const purple = (s: string) => '\x1b[35m' + s + _reset;
const darkGray = (s: string) => '\x1b[90m' + s + _reset;
const lightRed = (s: string) => '\x1b[91m' + s + _reset;
const lightGreen = (s: string) => '\x1b[92m' + s + _reset;
const lightYellow = (s: string) => '\x1b[93m' + s + _reset;

(async () => {

	let hasError = false;
	let projectVersion = 0;
	let typeRootsVersion = 0;
	let parsed: ts.ParsedCommandLine;

	const clack = await import('@clack/prompts');
	const snapshots = new Map<string, ts.IScriptSnapshot>();
	const versions = new Map<string, number>();
	const configs = new Map<string, config.Config | config.Config[] | undefined>();
	const languageServiceHost: ts.LanguageServiceHost = {
		...ts.sys,
		useCaseSensitiveFileNames() {
			return ts.sys.useCaseSensitiveFileNames;
		},
		getProjectVersion() {
			return projectVersion.toString();
		},
		getTypeRootsVersion() {
			return typeRootsVersion;
		},
		getCompilationSettings() {
			return parsed.options;
		},
		getScriptFileNames() {
			return parsed.fileNames;
		},
		getScriptVersion(fileName) {
			return versions.get(fileName)?.toString() ?? '0';
		},
		getScriptSnapshot(fileName) {
			if (!snapshots.has(fileName)) {
				snapshots.set(fileName, ts.ScriptSnapshot.fromString(ts.sys.readFile(fileName)!));
			}
			return snapshots.get(fileName);
		},
		getDefaultLibFileName(options) {
			return ts.getDefaultLibFilePath(options);
		},
	};
	const languageService = ts.createLanguageService(languageServiceHost);

	if (process.argv.includes('--project')) {

		const projectIndex = process.argv.indexOf('--project');

		let tsconfig = process.argv[projectIndex + 1];

		if (tsconfig.startsWith('-') || !tsconfig) {
			clack.log.error(lightRed(`Missing argument for --project.`));
		}
		else {
			if (!tsconfig.startsWith('.')) {
				tsconfig = `./${tsconfig}`;
			}
			await projectWorker(tsconfig);
		}
	}
	else if (process.argv.includes('--projects')) {

		const projectsIndex = process.argv.indexOf('--projects');

		for (let i = projectsIndex + 1; i < process.argv.length; i++) {

			if (process.argv[i].startsWith('-')) {
				break;
			}

			const searchGlob = process.argv[i];
			const tsconfigs = glob.sync(searchGlob);

			for (let tsconfig of tsconfigs) {
				if (!tsconfig.startsWith('.')) {
					tsconfig = `./${tsconfig}`;
				}
				await projectWorker(tsconfig, searchGlob);
			}
		}
	}
	else {
		const tsconfig = await askTSConfig();

		await projectWorker(tsconfig);
	}

	process.exit(hasError ? 1 : 0);

	async function projectWorker(tsconfigOption: string, rawOption?: string) {

		const tsconfig = require.resolve(tsconfigOption, { paths: [process.cwd()] });

		if (rawOption) {
			if (rawOption.startsWith('./')) {
				rawOption = rawOption.slice(2);
			}
			tsconfigOption = path.relative(process.cwd(), tsconfig);
			let left = '';
			let right = '';
			while (rawOption.length && tsconfigOption.length) {
				if (rawOption[0] === tsconfigOption[0]) {
					left += rawOption[0];
					rawOption = rawOption.slice(1);
					tsconfigOption = tsconfigOption.slice(1);
				} else {
					break;
				}
			}
			while (rawOption.length && tsconfigOption.length) {
				if (rawOption[rawOption.length - 1] === tsconfigOption[tsconfigOption.length - 1]) {
					right = rawOption[rawOption.length - 1] + right;
					rawOption = rawOption.slice(0, -1);
					tsconfigOption = tsconfigOption.slice(0, -1);
				} else {
					break;
				}
			}
			clack.intro(`${purple('[project]')} ${darkGray(left)}${tsconfigOption}${darkGray(right)}`);
		} else {
			clack.intro(`${purple('[project]')} ${path.relative(process.cwd(), tsconfig)}`);
		}

		parsed = parseCommonLine(tsconfig);
		if (!parsed.fileNames.length) {
			clack.outro(lightYellow('No included files.'));
			return;
		}

		const configFile = ts.findConfigFile(path.dirname(tsconfig), ts.sys.fileExists, 'tsslint.config.ts');
		if (!configFile) {
			clack.outro(lightYellow('No tsslint.config.ts found.'));
			return;
		}

		if (!configs.has(configFile)) {
			configs.set(configFile, undefined);

			const builtConfig = await core.buildConfig(configFile, ts.sys.createHash, clack);

			if (builtConfig) {
				try {
					configs.set(configFile, (await import(url.pathToFileURL(builtConfig).toString())).default);
				} catch (err) {
					if (err instanceof Error) {
						clack.log.error(err.stack ?? err.message);
					} else {
						clack.log.error(String(err));
					}
				}
			}
		}

		const tsslintConfig = configs.get(configFile);
		if (!tsslintConfig) {
			clack.outro(lightYellow('Failed to load tsslint.config.ts.'));
			return;
		}

		projectVersion++;
		typeRootsVersion++;

		const lintCache = process.argv.includes('--force')
			? {}
			: cache.loadCache(configFile, ts.sys.createHash);
		const projectContext: config.ProjectContext = {
			configFile,
			languageService,
			languageServiceHost,
			typescript: ts,
			tsconfig: ts.server.toNormalizedPath(tsconfig),
		};
		const linter = core.createLinter(projectContext, tsslintConfig, 'cli', clack);

		let lintSpinner: ReturnType<typeof clack['spinner']> | undefined = clack.spinner();
		let hasFix = false;
		let excluded = 0;
		let passed = 0;
		let errors = 0;
		let warnings = 0;
		let cached = 0;
		let t = Date.now();

		lintSpinner.start();

		for (let i = 0; i < parsed.fileNames.length; i++) {

			const fileName = parsed.fileNames[i];

			if (Date.now() - t > 100) {
				t = Date.now();
				lintSpinner.message(darkGray(`[${i + 1}/${parsed.fileNames.length}] ${path.relative(process.cwd(), fileName)}`));
				await new Promise(resolve => setTimeout(resolve, 0));
			}

			const fileMtime = fs.statSync(fileName).mtimeMs;
			let fileCache = lintCache[fileName];
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
				lintCache[fileName] = fileCache = [fileMtime, {}, [], [], {}];
			}

			let diagnostics!: ts.DiagnosticWithLocation[];

			if (process.argv.includes('--fix')) {

				let retry = 3;
				let shouldRetry = true;
				let newSnapshot: ts.IScriptSnapshot | undefined;

				while (shouldRetry && retry) {
					shouldRetry = false;
					retry--;
					if (Object.values(fileCache[1]).some(fixes => fixes > 0)) {
						// Reset the cache if there are any fixes applied.
						fileCache[1] = {};
						fileCache[2].length = 0;
						fileCache[3].length = 0;
					}
					diagnostics = linter.lint(fileName, fileCache);
					const fixes = linter.getCodeFixes(fileName, 0, Number.MAX_VALUE, diagnostics, fileCache);
					const textChanges = core.combineCodeFixes(fileName, fixes);
					if (textChanges.length) {
						const oldSnapshot = snapshots.get(fileName)!;
						newSnapshot = core.applyTextChanges(oldSnapshot, textChanges);
						snapshots.set(fileName, newSnapshot);
						versions.set(fileName, (versions.get(fileName) ?? 0) + 1);
						projectVersion++;
						shouldRetry = true;
					}
				}

				if (newSnapshot) {
					ts.sys.writeFile(fileName, newSnapshot.getText(0, newSnapshot.getLength()));
					fileCache[0] = fs.statSync(fileName).mtimeMs;
				}

				if (shouldRetry) {
					diagnostics = linter.lint(fileName, fileCache);
				}
			}
			else {
				diagnostics = linter.lint(fileName, fileCache);
			}

			if (diagnostics.length) {
				hasFix ||= linter.hasCodeFixes(fileName);
				hasError ||= diagnostics.some(diagnostic => diagnostic.category === ts.DiagnosticCategory.Error);

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

					if (lintSpinner) {
						if (diagnostic.category === ts.DiagnosticCategory.Error) {
							errors++;
							lintSpinner.stop(output, 1);
						}
						else if (diagnostic.category === ts.DiagnosticCategory.Warning) {
							warnings++;
							lintSpinner.stop(output, 2);
						}
						else {
							lintSpinner.stop(output);
						}
						lintSpinner = undefined;
					} else {
						if (diagnostic.category === ts.DiagnosticCategory.Error) {
							errors++;
							clack.log.error(output);
						}
						else if (diagnostic.category === ts.DiagnosticCategory.Warning) {
							warnings++;
							clack.log.warning(output);
						}
						else {
							clack.log.info(output);
						}
					}
				}
			} else if (!Object.keys(linter.getRules(fileName, fileCache)).length) {
				excluded++;
			} else {
				passed++;
			}

			if (!lintSpinner) {
				lintSpinner = clack.spinner();
				lintSpinner.start();
			}
		}

		if (cached) {
			lintSpinner.stop(darkGray(`Processed ${parsed.fileNames.length} files with cache. (Use --force to ignore cache.)`));
		} else {
			lintSpinner.stop(darkGray(`Processed ${parsed.fileNames.length} files.`));
		}

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

		cache.saveCache(configFile, lintCache, ts.sys.createHash);
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
		return ts.parseJsonSourceFileConfigFileContent(jsonConfigFile, ts.sys, path.dirname(tsconfig), {}, tsconfig);
	}
})();
