import type {
	FileTextChanges,
	LanguageService,
	LanguageServiceHost,
	SourceFile,
	Diagnostic,
} from 'typescript/lib/tsserverlibrary';

export interface ProjectContext {
	typescript: typeof import('typescript/lib/tsserverlibrary.js');
	languageServiceHost: LanguageServiceHost;
	languageService: LanguageService;
	tsconfig?: string;
}

export interface Config {
	rules?: Rules;
	resolveRules?(context: ProjectContext, rules: Rules): Rules;
	resolveResults?(context: ProjectContext, results: Diagnostic[]): Diagnostic[];
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
