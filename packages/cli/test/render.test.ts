// Renderer-level invariants that integration tests can only verify by
// eyeballing subprocess stdout. Pin them here so the formatting rules
// don't drift silently:
//
//   - `info()` only prepends a separator newline in TTY mode AND when
//     the previous emission was "content" (diagnostic or summary).
//   - `summary()` always prepends a leading newline (even non-TTY) and
//     marks itself as content so any follow-up `info()` (e.g. the
//     `--list-rules` block) gets the same separator a diagnostic block
//     would have produced.
//   - `diagnostic()` indents only in TTY mode, and prepends a newline.
//
// Run via:
//   node packages/cli/test/render.test.js

const failures: string[] = [];
function check(name: string, cond: boolean, detail?: string) {
	if (cond) {
		process.stdout.write('.');
	}
	else {
		failures.push(name + (detail ? ' — ' + detail : ''));
		process.stdout.write('F');
	}
}

// Capture stdout while a renderer block runs. Toggles `process.stdout.isTTY`
// for the duration so we can exercise both branches deterministically.
function withCapture(isTTY: boolean, fn: (renderer: import('../lib/render').Renderer) => void): string {
	const stdout: any = process.stdout;
	const prevWrite = stdout.write.bind(stdout);
	const prevIsTTY = stdout.isTTY;
	stdout.isTTY = isTTY;
	let buf = '';
	stdout.write = (chunk: any) => {
		buf += String(chunk);
		return true;
	};
	try {
		// Re-require so isTTY is captured by the new closure.
		delete require.cache[require.resolve('../lib/render.js')];
		const render = require('../lib/render.js') as typeof import('../lib/render.js');
		fn(render.createRenderer());
	}
	finally {
		stdout.write = prevWrite;
		stdout.isTTY = prevIsTTY;
		delete require.cache[require.resolve('../lib/render.js')];
	}
	return buf;
}

// ── Test 1: info() in TTY adds no blank line on first call ─────────────
{
	const out = withCapture(true, r => {
		r.info('hello');
	});
	check('first info has no leading blank line', out === 'hello\n', `got: ${JSON.stringify(out)}`);
}

// ── Test 2: info() after info() — no separator ─────────────────────────
{
	const out = withCapture(true, r => {
		r.info('a');
		r.info('b');
	});
	check('info→info: no blank between', out === 'a\nb\n', `got: ${JSON.stringify(out)}`);
}

// ── Test 3: diagnostic→info in TTY: blank-line separator ───────────────
{
	const out = withCapture(true, r => {
		r.diagnostic('foo.ts:1:1 - error');
		r.info('summary line');
	});
	// diagnostic prepends \n, indents in TTY; info prepends \n because
	// lastWasContent is true.
	check(
		'diagnostic→info: separator in TTY',
		out === '\n   foo.ts:1:1 - error\n\nsummary line\n',
		`got: ${JSON.stringify(out)}`,
	);
}

// ── Test 4: diagnostic→info in non-TTY: NO separator (info gates on TTY) ─
{
	const out = withCapture(false, r => {
		r.diagnostic('foo.ts:1:1 - error');
		r.info('summary line');
	});
	check(
		'diagnostic→info: no separator in non-TTY',
		out === '\nfoo.ts:1:1 - error\nsummary line\n',
		`got: ${JSON.stringify(out)}`,
	);
}

// ── Test 5: summary→info in TTY: blank-line separator ──────────────────
// This is the recently fixed invariant. summary() must mark itself as
// content so --list-rules block reads visually as its own section.
{
	const out = withCapture(true, r => {
		r.summary(['5 passed']);
		r.info('type-aware (1)');
	});
	check(
		'summary→info: separator in TTY',
		out === '\n5 passed\n\ntype-aware (1)\n',
		`got: ${JSON.stringify(out)}`,
	);
}

// ── Test 6: summary→info in non-TTY: still no separator ────────────────
{
	const out = withCapture(false, r => {
		r.summary(['5 passed']);
		r.info('type-aware (1)');
	});
	check(
		'summary→info: no separator in non-TTY',
		out === '\n5 passed\ntype-aware (1)\n',
		`got: ${JSON.stringify(out)}`,
	);
}

// ── Test 7: summary→info→info: only first info gets the separator ──────
// Follow-up `info()`s reset lastWasContent to false, so they're flush
// against each other.
{
	const out = withCapture(true, r => {
		r.summary(['done']);
		r.info('a');
		r.info('b');
	});
	check(
		'summary→info→info: only first info gets separator',
		out === '\ndone\n\na\nb\n',
		`got: ${JSON.stringify(out)}`,
	);
}

// ── Test 8: empty summary is a no-op (doesn't trip the content flag) ───
{
	const out = withCapture(true, r => {
		r.summary([]);
		r.info('after empty');
	});
	check(
		"empty summary doesn't set content flag",
		out === 'after empty\n',
		`got: ${JSON.stringify(out)}`,
	);
}

// ── Test 9: diagnostic indents only in TTY ─────────────────────────────
{
	const ttyOut = withCapture(true, r => {
		r.diagnostic('line1\nline2');
	});
	const nonTtyOut = withCapture(false, r => {
		r.diagnostic('line1\nline2');
	});
	check(
		'diagnostic indents in TTY',
		ttyOut === '\n   line1\n   line2\n',
		`got: ${JSON.stringify(ttyOut)}`,
	);
	check(
		"diagnostic doesn't indent in non-TTY",
		nonTtyOut === '\nline1\nline2\n',
		`got: ${JSON.stringify(nonTtyOut)}`,
	);
}

// ── Done ──────────────────────────────────────────────────────────────
process.stdout.write('\n');
if (failures.length) {
	console.error(`\n${failures.length} failure(s):`);
	for (const f of failures) console.error('  - ' + f);
	process.exit(1);
}
console.log('OK');
