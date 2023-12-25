import ts = require('typescript');
import path = require('path');
import config = require('@tsslint/config');
import core = require('@tsslint/core');
import glob = require('glob');

(async () => {
	const { log, text } = await import('@clack/prompts');

	let errors = 0;

	if (process.argv.includes('--project')) {
		const projectIndex = process.argv.indexOf('--project');
		const tsconfig = process.argv[projectIndex + 1];
		errors += await projectWorker(tsconfig);
	}
	else if (process.argv.includes('--projects')) {
		const projectsIndex = process.argv.indexOf('--projects');
		const searchGlob = process.argv.slice(projectsIndex + 1);
		const tsconfigs = glob.sync(searchGlob[0], { cwd: process.cwd() });
		for (let tsconfig of tsconfigs) {
			if (!tsconfig.startsWith('.')) {
				tsconfig = `./${tsconfig}`;
			}
			errors += await projectWorker(tsconfig);
		}
	}
	else {
		errors += await projectWorker();
	}

	process.exit(errors ? 1 : 0);

	async function projectWorker(tsconfig?: string) {

		tsconfig = await getTsconfigPath(tsconfig);

		log.info(`tsconfig path: ${tsconfig} (${parseCommonLine(tsconfig).fileNames.length} input files)`);

		const configFile = ts.findConfigFile(path.dirname(tsconfig), ts.sys.fileExists, 'tsslint.config.ts');
		if (!configFile) {
			throw new Error('No tsslint.config.ts file found!');
		}
		log.info(`config path: ${configFile}`);

		const tsslintConfig = await config.buildConfigFile(configFile);
		const parsed = parseCommonLine(tsconfig);
		if (!parsed.fileNames) {
			throw new Error('No input files found in tsconfig!');
		}

		let projectVersion = 0;

		const snapshots = new Map<string, ts.IScriptSnapshot>();
		const versions = new Map<string, number>();
		const languageServiceHost: ts.LanguageServiceHost = {
			...ts.sys,
			getProjectVersion() {
				return projectVersion.toString();
			},
			useCaseSensitiveFileNames() {
				return ts.sys.useCaseSensitiveFileNames;
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
		const plugins = await Promise.all([
			...core.getBuiltInPlugins(false),
			...tsslintConfig.plugins ?? [],
		].map(plugin => plugin({
			configFile,
			languageService,
			languageServiceHost,
			typescript: ts,
			tsconfig,
		})));

		for (const plugin of plugins) {
			if (plugin.resolveRules) {
				tsslintConfig.rules = plugin.resolveRules(tsslintConfig.rules ?? {});
			}
		}

		let errors = 0;

		for (const fileName of parsed.fileNames) {
			if (process.argv.includes('--fix')) {

				let retry = 3;
				let shouldRetry = true;
				let newSnapshot: ts.IScriptSnapshot | undefined;

				while (shouldRetry && retry) {
					shouldRetry = false;
					retry--;
					const sourceFile = languageService.getProgram()?.getSourceFile(fileName);
					if (!sourceFile) {
						throw new Error(`No source file found for ${fileName}`);
					}
					plugins.map(plugin => plugin.lint?.(sourceFile, tsslintConfig.rules ?? {})).flat().filter((diag): diag is ts.Diagnostic => !!diag);
					const fixes = plugins
						.map(plugin => plugin.getFixes?.(fileName, 0, sourceFile.text.length))
						.flat()
						.filter((fix): fix is ts.CodeFixAction => !!fix);
					const changes = fixes
						.map(fix => fix.changes)
						.flat()
						.filter(change => change.fileName === sourceFile.fileName && change.textChanges.length)
						.sort((a, b) => b.textChanges[0].span.start - a.textChanges[0].span.start);
					let lastChangeAt = sourceFile.text.length;
					if (changes.length) {
						let text = sourceFile.text;
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
						snapshots.set(sourceFile.fileName, newSnapshot);
						versions.set(sourceFile.fileName, (versions.get(sourceFile.fileName) ?? 0) + 1);
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
				const diagnostics = plugins.map(plugin => plugin.lint?.(sourceFile, tsslintConfig.rules ?? {})).flat().filter((diag): diag is ts.Diagnostic => !!diag);
				const output = ts.formatDiagnosticsWithColorAndContext(diagnostics, {
					getCurrentDirectory: ts.sys.getCurrentDirectory,
					getCanonicalFileName: ts.sys.useCaseSensitiveFileNames ? x => x : x => x.toLowerCase(),
					getNewLine: () => ts.sys.newLine,
				});
				if (output) {
					errors++;
					log.info(output);
				}
			}
		}

		if (errors) {
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
