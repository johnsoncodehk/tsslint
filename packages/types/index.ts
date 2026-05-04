import type {
	CodeFixAction,
	CompletionEntry,
	Diagnostic,
	DiagnosticWithLocation,
	FileTextChanges,
	Program,
	SourceFile,
} from 'typescript';

export interface LinterContext {
	typescript: typeof import('typescript');
	// Program thunk (not a stable instance). Callers that mutate the
	// project mid-session (e.g. CLI `--fix` rewriting a file) rebuild the
	// Program and the next `lint()` call sees the new one. Each `lint()`
	// reads this once at the top, so within a single file's pass the
	// Program identity stays stable.
	//
	// Pre-3.2: this was `{ languageService, languageServiceHost }`.
	// LinterContext consumed only `getProgram()` and `getCancellationToken()`
	// from those — the rest of the LS / Host surface was unused, so the
	// indirection was paying for capabilities (completions, refactors,
	// navigation) that the linter never touches. Direct Program access
	// also makes the surface trivially compatible with hosts that don't
	// run a full LanguageService (raw `ts.createProgram`, tsgo's
	// `Project.program`, etc.).
	program: () => Program;
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
	// IDE-side completion entries. Hosted environments (typescript-plugin)
	// merge the result into `LanguageService.getCompletionsAtPosition`.
	// CLI ignores it. Pre-3.2 the ignore plugin reached for `LanguageService`
	// directly via `LinterContext`; that path is gone, so plugins that want
	// IDE completions hook in here instead.
	resolveCompletions?(file: SourceFile, position: number, entries: CompletionEntry[]): CompletionEntry[];
}

export interface Rules {
	[name: string]: Rule | Rules;
}

export interface Rule {
	(ctx: RuleContext): void;
}

export interface RuleContext {
	typescript: typeof import('typescript');
	program: Program;
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
	// just read `ctx.program` once — that re-classifies the rule
	// type-aware, and layer 2 handles cross-file invalidation properly.
	withoutCache(): Reporter;
}
