export interface Renderer {
	/** A single-line header (project, skip notice, input-error message). Flush-left. */
	info(msg: string): void;
	/** A diagnostic block (multi-line, pre-formatted, trimmed). Indented. */
	diagnostic(out: string): void;
	/** One-off error line to stderr. */
	error(msg: string): void;
	/** Final summary block. Flush-left; last line typically holds the counters. */
	summary(lines: string[]): void;
	/** Flush any pending state. Call before exit. */
	dispose(): void;
}

export function createRenderer(): Renderer {
	const INDENT = '   ';
	const isTTY = !!process.stdout.isTTY;
	let lastWasContent = false;
	return {
		info(msg) {
			if (lastWasContent && isTTY) {
				process.stdout.write('\n');
			}
			process.stdout.write(msg + '\n');
			lastWasContent = false;
		},
		diagnostic(out) {
			const lines = out.split('\n');
			while (lines.length && !lines[lines.length - 1]) {
				lines.pop();
			}
			if (!lines.length) {
				return;
			}
			const body = isTTY ? lines.map(l => l ? INDENT + l : '').join('\n') : lines.join('\n');
			process.stdout.write('\n' + body + '\n');
			lastWasContent = true;
		},
		error(msg) {
			process.stderr.write(msg + '\n');
		},
		summary(lines) {
			if (!lines.length) {
				return;
			}
			process.stdout.write('\n');
			for (const line of lines) {
				process.stdout.write(line + '\n');
			}
		},
		dispose() {},
	};
}
