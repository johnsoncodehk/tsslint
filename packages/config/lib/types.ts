import type {
	FileTextChanges,
	LanguageService,
	LanguageServiceHost,
	SourceFile,
	Diagnostic,
	ApplicableRefactorInfo,
	TextRange,
} from 'typescript/lib/tsserverlibrary';

export interface ProjectContext {
	configFile: string;
	typescript: typeof import('typescript/lib/tsserverlibrary.js');
	languageServiceHost: LanguageServiceHost;
	languageService: LanguageService;
	tsconfig?: string;
}

export interface Config {
	rules?: Rules;
	plugins?: Plugin[];
}

export interface Plugin {
	(projectContext: ProjectContext): PluginInstance | Promise<PluginInstance>;
}

export interface PluginInstance {
	lint?(sourceFile: SourceFile, rules: Rules): Diagnostic[];
	getFixes?(sourceFile: SourceFile, positionOrRange: number | TextRange): ApplicableRefactorInfo[];
	fix?(sourceFile: SourceFile, refactorName: string, actionName: string): FileTextChanges[] | undefined;
	resolveRules?(rules: Rules): Rules;
	resolveResult?(results: Diagnostic[]): Diagnostic[];
}

export interface Rules {
	[name: string]: Rule;
}

export interface Rule {
	(context: RuleContext): void;
}

export interface RuleContext {
	typescript: typeof import('typescript/lib/tsserverlibrary.js');
	languageServiceHost: LanguageServiceHost;
	languageService: LanguageService;
	sourceFile: SourceFile;
	reportError(message: string, start: number, end: number): Reporter;
	reportWarning(message: string, start: number, end: number): Reporter;
	reportSuggestion(message: string, start: number, end: number): Reporter;
}

export interface Reporter {
	withDeprecated(): Reporter;
	withUnnecessary(): Reporter;
	withFix(title: string, getChanges: () => FileTextChanges[]): Reporter;
}
