import type { SourceFile } from 'typescript/ast';
import type { Checker, DiagnosticCategory, Program } from 'typescript/sync';

export interface LinterContext {
	typescript: typeof import('typescript/ast');
	getProgram(): Program;
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
	resolveDiagnostics?(file: SourceFile, diagnostics: Diagnostic[]): Diagnostic[];
	resolveCodeFixes?(file: SourceFile, diagnostic: Diagnostic, codeFixes: CodeFixAction[]): CodeFixAction[];
}

export interface Rules {
	[name: string]: Rule | Rules;
}

export interface Rule {
	(ctx: RuleContext): void;
}

export interface RuleContext {
	typescript: typeof import('typescript/ast');
	program: Program;
	checker: Checker;
	/**
	 * For files produced by a tsconfig `contentMappers` entry, this is the
	 * transformed TypeScript. Report positions in its coordinates; TSSLint
	 * maps them back to the original file.
	 */
	file: SourceFile;
	report(message: string, start: number, end: number): Reporter;
}

export interface Reporter {
	at(err: Error, stackIndex: number): Reporter;
	asWarning(): Reporter;
	asError(): Reporter;
	asSuggestion(): Reporter;
	withDeprecated(): Reporter;
	withUnnecessary(): Reporter;
	withFix(title: string, getChanges: () => FileTextChanges[]): Reporter;
	withRefactor(title: string, getChanges: () => FileTextChanges[]): Reporter;
	// Mark this diagnostic as ineligible for the CLI's per-file cache.
	// The diagnostic is still returned for the current run, but won't be
	// written to disk — so the next warm run (cache hit on this file)
	// won't replay it, and the rule must re-run to surface it again.
	// Use when a diagnostic's correctness depends on inputs the layer-1
	// mtime check doesn't track (external resources, env, sibling files
	// the rule reads directly via fs). For type-checker-derived findings
	// just read `ctx.program` / `ctx.checker` once — that re-classifies the
	// rule type-aware, and layer 2 handles cross-file invalidation properly.
	withoutCache(): Reporter;
}

export interface TextSpan {
	start: number;
	length: number;
}

export interface TextChange {
	span: TextSpan;
	newText: string;
}

export interface FileTextChanges {
	fileName: string;
	textChanges: readonly TextChange[];
}

export interface CodeFixAction {
	fixName: string;
	description: string;
	changes: FileTextChanges[];
	fixId?: string;
	fixAllDescription?: string;
}

export interface RefactorAction {
	name: string;
	description: string;
	kind?: string;
}

export interface RelatedInformation {
	category: DiagnosticCategory;
	code: string | number;
	messageText: string;
	file: SourceFile | undefined;
	start: number | undefined;
	length: number | undefined;
}

export interface Diagnostic {
	category: DiagnosticCategory;
	/** The rule id, or the TypeScript diagnostic code for compiler diagnostics. */
	code: string | number;
	messageText: string;
	file: SourceFile;
	start: number;
	length: number;
	source: string;
	relatedInformation?: RelatedInformation[];
	reportsUnnecessary?: boolean;
	reportsDeprecated?: boolean;
}
