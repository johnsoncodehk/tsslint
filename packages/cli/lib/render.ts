export interface Renderer {
	/** A single-line header (project, skip notice, input-error message). Flush-left. */
	info(msg: string): void;
	/** A diagnostic block (multi-line, pre-formatted, trimmed). Indented. */
	diagnostic(out: string): void;
	/** One-off error line to stderr. */
	error(msg: string): void;
	/**
	 * Update the live status line (current file / progress).
	 * TTY: pinned to the last line. CI: no-op.
	 * Call with no argument to clear.
	 */
	status(text?: string): void;
	/** Final summary block. Flush-left; last line typically holds the counters. */
	summary(lines: string[]): void;
	/** Clear any pinned status. Call before exit. */
	dispose(): void;
}

export function createRenderer(): Renderer {
	return process.stdout.isTTY ? createTTYRenderer() : createCIRenderer();
}

function createTTYRenderer(): Renderer {
	const INDENT = '   ';
	const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
	const SPINNER_INTERVAL_MS = 80;
	let spinnerFrame = 0;
	let spinnerTimer: NodeJS.Timeout | undefined;
	let statusText = '';
	let statusDrawn = false;
	let lastWasContent = false;

	function clearStatus() {
		if (statusDrawn) {
			process.stdout.write('\r\x1b[K');
			statusDrawn = false;
		}
	}

	function drawStatus() {
		if (statusText) {
			process.stdout.write(SPINNER_FRAMES[spinnerFrame] + ' ' + statusText);
			statusDrawn = true;
		}
	}

	function startSpinner() {
		if (spinnerTimer) {
			return;
		}
		spinnerTimer = setInterval(() => {
			if (!statusText) {
				return;
			}
			spinnerFrame = (spinnerFrame + 1) % SPINNER_FRAMES.length;
			clearStatus();
			drawStatus();
		}, SPINNER_INTERVAL_MS);
		spinnerTimer.unref();
	}

	function stopSpinner() {
		if (spinnerTimer) {
			clearInterval(spinnerTimer);
			spinnerTimer = undefined;
		}
	}

	return {
		info(msg) {
			clearStatus();
			if (lastWasContent) {
				process.stdout.write('\n');
			}
			process.stdout.write(msg + '\n');
			lastWasContent = false;
			drawStatus();
		},
		diagnostic(out) {
			clearStatus();
			const lines = out.split('\n');
			while (lines.length && !lines[lines.length - 1]) {
				lines.pop();
			}
			if (!lines.length) {
				drawStatus();
				return;
			}
			const body = lines.map(l => l ? INDENT + l : '').join('\n');
			process.stdout.write('\n' + body + '\n');
			lastWasContent = true;
			drawStatus();
		},
		error(msg) {
			clearStatus();
			process.stderr.write(msg + '\n');
			drawStatus();
		},
		status(text) {
			const next = text ?? '';
			if (next === statusText && statusDrawn === !!next) {
				return;
			}
			statusText = next;
			clearStatus();
			if (next) {
				startSpinner();
				drawStatus();
			}
			else {
				stopSpinner();
			}
		},
		summary(lines) {
			clearStatus();
			if (!lines.length) {
				return;
			}
			process.stdout.write('\n');
			for (const line of lines) {
				process.stdout.write(line + '\n');
			}
		},
		dispose() {
			stopSpinner();
			clearStatus();
		},
	};
}

function createCIRenderer(): Renderer {
	return {
		info(msg) {
			process.stdout.write(msg + '\n\n');
		},
		diagnostic(out) {
			process.stdout.write(out + '\n\n');
		},
		error(msg) {
			process.stderr.write(msg + '\n');
		},
		status() {},
		summary(lines) {
			for (const line of lines) {
				process.stdout.write(line + '\n');
			}
		},
		dispose() {},
	};
}
