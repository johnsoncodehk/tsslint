import type { SourceFile } from 'typescript/ast';
import type { Checker, Diagnostic as TSDiagnostic, Program, TextEdit } from 'typescript/sync';

export interface LinterContext {
	typescript: typeof import('typescript/ast');
}

export interface LintTarget {
	program: Program;
	checker: Checker;
	/**
	 * For files produced by a tsconfig `contentMappers` entry, this is the
	 * transformed TypeScript. Report positions in its coordinates; TSSLint
	 * maps them back to the original file.
	 */
	file: SourceFile;
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
	resolveDiagnostics?(target: LintTarget, diagnostics: Diagnostic[]): Diagnostic[];
	resolveCodeFixes?(target: LintTarget, diagnostic: Diagnostic, codeFixes: CodeFixAction[]): CodeFixAction[];
}

export interface Rules {
	[name: string]: Rule | Rules;
}

export interface Rule {
	(ctx: RuleContext): void;
}

export interface RuleContext extends LintTarget {
	typescript: typeof import('typescript/ast');
	report(message: string, start: number, end: number): Reporter;
}

export interface Reporter {
	at(err: Error, stackIndex: number): Reporter;
	asWarning(): Reporter;
	asError(): Reporter;
	asSuggestion(): Reporter;
	withDeprecated(): Reporter;
	withUnnecessary(): Reporter;
	/** Edits apply to the reported file. */
	withFix(title: string, getEdits: () => readonly TextEdit[]): Reporter;
	withRefactor(title: string, getEdits: () => readonly TextEdit[]): Reporter;
}

export interface CodeFixAction {
	fixName: string;
	description: string;
	edits: readonly TextEdit[];
	fixId?: string;
	fixAllDescription?: string;
}

export interface RefactorAction {
	name: string;
	description: string;
	kind?: string;
}

/**
 * A TypeScript diagnostic, or a rule report when `ruleId` is set. Rule
 * reports are in the coordinates of `LintTarget.file`; compiler
 * diagnostics of a content-mapped file are in the original file's.
 */
export interface Diagnostic extends TSDiagnostic {
	ruleId?: string;
}
