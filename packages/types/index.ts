import type {
	CodeFixAction,
	Diagnostic,
	DiagnosticCategory,
	DiagnosticWithLocation,
	FileTextChanges,
	LanguageService,
	LanguageServiceHost,
	Program,
	SourceFile,
} from 'typescript';

export interface LinterContext {
	typescript: typeof import('typescript');
	languageServiceHost: LanguageServiceHost;
	languageService: LanguageService;
}

export interface Config {
	include?: string[];
	exclude?: string[];
	rules?: Rules;
	plugins?: Plugin[];
}

export interface Plugin {
	(ctx: LinterContext): PluginInstance;
}

export interface PluginInstance {
	resolveRules?(fileName: string, rules: Record<string, Rule>): Record<string, Rule>;
	resolveDiagnostics?(file: SourceFile, diagnostics: DiagnosticWithLocation[]): DiagnosticWithLocation[];
	resolveCodeFixes?(file: SourceFile, diagnostic: Diagnostic, codeFixes: CodeFixAction[]): CodeFixAction[];
}

export interface Rules {
	[name: string]: Rule | Rules;
}

export interface Rule {
	(ctx: RuleContext): void;
}

export interface RuleContext {
	typescript: typeof import('typescript');
	languageServiceHost: LanguageServiceHost;
	languageService: LanguageService;
	program: Program;
	file: SourceFile;
	report(message: string, start: number, end: number, category?: DiagnosticCategory, reportAt?: [Error, number]): Reporter;
}

export interface Reporter {
	withDeprecated(): Reporter;
	withUnnecessary(): Reporter;
	withFix(title: string, getChanges: () => FileTextChanges[]): Reporter;
	withRefactor(title: string, getChanges: () => FileTextChanges[]): Reporter;
}
