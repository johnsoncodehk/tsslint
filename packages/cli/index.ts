import ts = require('typescript');
import path = require('path');
import type config = require('@tsslint/config');
import core = require('@tsslint/core');
import glob = require('glob');

(async () => {

	let hasError = false;
	let projectVersion = 0;
	let typeRootsVersion = 0;
	let parsed: ts.ParsedCommandLine;

	const { log, text } = await import('@clack/prompts');
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
		const tsconfig = process.argv[projectIndex + 1];
		await projectWorker(tsconfig);
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
				await projectWorker(tsconfig);
			}
		}
	}
	else {
		await projectWorker();
	}

	process.exit(hasError ? 1 : 0);

	async function projectWorker(tsconfigOption?: string) {

		const tsconfig = await getTsconfigPath(tsconfigOption);
		const configFile = ts.findConfigFile(path.dirname(tsconfig), ts.sys.fileExists, 'tsslint.config.ts');

		log.step(`Project: ${path.relative(process.cwd(), tsconfig)} (${parseCommonLine(tsconfig).fileNames.length} files)`);

		if (!configFile) {
			log.error('No tsslint.config.ts file found!');
			return;
		}

		if (!configs.has(configFile)) {
			try {
				configs.set(configFile, await core.buildConfigFile(configFile, ts.sys.createHash, {
					log: log.info,
					warn: log.warn,
					error: log.error,
				}));
			} catch (err) {
				configs.set(configFile, undefined);
				console.error(err);
			}
		}
		const tsslintConfig = configs.get(configFile);
		if (!tsslintConfig) {
			return;
		}

		parsed = parseCommonLine(tsconfig);
		if (!parsed.fileNames) {
			throw new Error('No input files found in tsconfig!');
		}
		projectVersion++;
		typeRootsVersion++;

		const linter = core.createLinter({
			configFile,
			languageService,
			languageServiceHost,
			typescript: ts,
			tsconfig,
		}, tsslintConfig, false);

		let hasFix = false;

		for (const fileName of parsed.fileNames) {
			if (process.argv.includes('--fix')) {

				let retry = 3;
				let shouldRetry = true;
				let newSnapshot: ts.IScriptSnapshot | undefined;

				while (shouldRetry && retry) {
					shouldRetry = false;
					retry--;
					const diagnostics = linter.lint(fileName);
					const fixes = linter.getCodeFixes(fileName, 0, Number.MAX_VALUE, diagnostics);
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
				}
			}
			else {
				const diagnostics = linter.lint(fileName);
				for (const diagnostic of diagnostics) {
					let output = ts.formatDiagnosticsWithColorAndContext([diagnostic], {
						getCurrentDirectory: ts.sys.getCurrentDirectory,
						getCanonicalFileName: ts.sys.useCaseSensitiveFileNames ? x => x : x => x.toLowerCase(),
						getNewLine: () => ts.sys.newLine,
					});
					output = output.replace(`TS${diagnostic.code}`, `TSSLint(${diagnostic.code})`);
					if (diagnostic.category === ts.DiagnosticCategory.Error) {
						log.error(output);
					}
					else if (diagnostic.category === ts.DiagnosticCategory.Warning) {
						log.warn(output);
					}
					else {
						log.info(output);
					}
				}
				if (diagnostics.length) {
					hasFix ||= linter.hasCodeFixes(fileName);
					hasError ||= diagnostics.some(diagnostic => diagnostic.category === ts.DiagnosticCategory.Error);
				}
			}
		}

		if (hasFix) {
			log.info(`Use --fix to apply fixes.`);
		}
	}

	async function getTsconfigPath(tsconfig?: string) {
		if (!tsconfig) {
			tsconfig = ts.findConfigFile(process.cwd(), ts.sys.fileExists);
			let shortTsconfig = tsconfig ? path.relative(process.cwd(), tsconfig) : undefined;
			if (!shortTsconfig?.startsWith('.')) {
				shortTsconfig = `./${shortTsconfig}`;
			}
			tsconfig = await text({
				message: 'Select the tsconfig project. (Use --project or --projects to skip this prompt.)',
				placeholder: shortTsconfig ? `${shortTsconfig} (${parseCommonLine(tsconfig!).fileNames.length} files)` : 'No tsconfig.json/jsconfig.json found, please enter the path to the tsconfig.json/jsconfig.json file.',
				defaultValue: shortTsconfig,
				validate(value) {
					value ||= shortTsconfig;
					try {
						require.resolve(value, { paths: [process.cwd()] });
					} catch {
						return `File not found!`;
					}
				},
			}) as string;
		}
		tsconfig = require.resolve(tsconfig, { paths: [process.cwd()] });
		return tsconfig;
	}

	function parseCommonLine(tsconfig: string) {
		const jsonConfigFile = ts.readJsonConfigFile(tsconfig, ts.sys.readFile);
		return ts.parseJsonSourceFileConfigFileContent(jsonConfigFile, ts.sys, path.dirname(tsconfig), {}, tsconfig);
	}
})();
