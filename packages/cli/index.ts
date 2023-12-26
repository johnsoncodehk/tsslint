import ts = require('typescript');
import path = require('path');
import config = require('@tsslint/config');
import core = require('@tsslint/core');
import glob = require('glob');

(async () => {

	let errors = 0;
	let projectVersion = 0;
	let typeRootsVersion = 0;
	let parsed: ts.ParsedCommandLine;

	const { log, text } = await import('@clack/prompts');
	const snapshots = new Map<string, ts.IScriptSnapshot>();
	const versions = new Map<string, number>();
	const configs = new Map<string, config.Config | undefined>();
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
		errors += await projectWorker(tsconfig);
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
				errors += await projectWorker(tsconfig);
			}
		}
	}
	else {
		errors += await projectWorker();
	}

	process.exit(errors ? 1 : 0);

	async function projectWorker(tsconfigOption?: string) {

		const tsconfig = await getTsconfigPath(tsconfigOption);

		log.info(`tsconfig path: ${tsconfig} (${parseCommonLine(tsconfig).fileNames.length} input files)`);

		const configFile = ts.findConfigFile(path.dirname(tsconfig), ts.sys.fileExists, 'tsslint.config.ts');
		if (!configFile) {
			throw new Error('No tsslint.config.ts file found!');
		}
		log.info(`config path: ${configFile}`);

		if (!configs.has(configFile)) {
			configs.set(configFile, await config.buildConfigFile(configFile));
		}
		const tsslintConfig = configs.get(configFile)!;

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

		let errors = 0;
		let warnings = 0;

		for (const fileName of parsed.fileNames) {
			if (process.argv.includes('--fix')) {

				let retry = 3;
				let shouldRetry = true;
				let newSnapshot: ts.IScriptSnapshot | undefined;

				while (shouldRetry && retry) {
					shouldRetry = false;
					retry--;
					const diagnostics = linter.lint(fileName);
					const fixes = linter.getFixes(fileName, 0, Number.MAX_VALUE, diagnostics);
					const changes = fixes
						.map(fix => fix.changes)
						.flat()
						.filter(change => change.fileName === fileName && change.textChanges.length)
						.sort((a, b) => b.textChanges[0].span.start - a.textChanges[0].span.start);
					let lastChangeAt = Number.MAX_VALUE;
					if (changes.length) {
						const oldSnapshot = snapshots.get(fileName)!;
						let text = oldSnapshot.getText(0, oldSnapshot.getLength());
						for (const change of changes) {
							const textChanges = [...change.textChanges].sort((a, b) => b.span.start - a.span.start);
							const lastChange = textChanges[0];
							const firstChange = textChanges[textChanges.length - 1];
							if (lastChangeAt >= lastChange.span.start + lastChange.span.length) {
								lastChangeAt = firstChange.span.start;
								for (const change of textChanges) {
									text = text.slice(0, change.span.start) + change.newText + text.slice(change.span.start + change.span.length);
								}
							}
						}
						newSnapshot = ts.ScriptSnapshot.fromString(text);
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
				const sourceFile = languageService.getProgram()?.getSourceFile(fileName);
				if (!sourceFile) {
					throw new Error(`No source file found for ${fileName}`);
				}
				const diagnostics = linter.lint(fileName);
				const output = ts.formatDiagnosticsWithColorAndContext(diagnostics, {
					getCurrentDirectory: ts.sys.getCurrentDirectory,
					getCanonicalFileName: ts.sys.useCaseSensitiveFileNames ? x => x : x => x.toLowerCase(),
					getNewLine: () => ts.sys.newLine,
				});
				if (output) {
					log.info(output);
				}
				errors += diagnostics.filter(diag => diag.category === ts.DiagnosticCategory.Error).length;
				warnings += diagnostics.filter(diag => diag.category === ts.DiagnosticCategory.Warning).length;
			}
		}

		if (errors || warnings) {
			log.info(`Use --fix to apply fixes.`);
		}

		return errors;
	}

	async function getTsconfigPath(tsconfig?: string) {
		if (!tsconfig) {
			tsconfig = ts.findConfigFile(process.cwd(), ts.sys.fileExists);
			let shortTsconfig = tsconfig ? path.relative(process.cwd(), tsconfig) : undefined;
			if (!shortTsconfig?.startsWith('.')) {
				shortTsconfig = `./${shortTsconfig}`;
			}
			tsconfig = await text({
				message: 'Select the tsconfig project. (You can use --project to skip this prompt.)',
				placeholder: shortTsconfig ? `${shortTsconfig} (${parseCommonLine(tsconfig!).fileNames.length} input files)` : 'No tsconfig.json found, please enter the path to your tsconfig.json file.',
				defaultValue: shortTsconfig,
				validate(value) {
					value ||= shortTsconfig!;
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
