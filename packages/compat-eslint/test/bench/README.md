# Per-rule parity bench

Self-contained, ~0.6 s sanity check that every (rule, file) pair this
package claims to support emits the **same diagnostics at the same
locations** as ESLint with `@typescript-eslint/parser`. Runs in-process
— no CLI subprocess, no temp files.

## Usage

```sh
pnpm -F @tsslint/compat-eslint bench
```

Exits non-zero on any unexpected per-location diff. CI runs this on
every change to `packages/compat-eslint/lib/**`.

```sh
node packages/compat-eslint/test/bench/run.js --update-baseline
```

Regenerates `baseline.json`. Use this when you intentionally change a
rule's behaviour (or land a fix that changes the divergence shape).
The diff to `baseline.json` is part of the PR — review it.

## What it checks

- Each rule listed in `rules.config.ts` is run against each file in
  `corpus/`.
- TSSLint side: `compat.convertRule(rule, options)` driven through a
  per-file `ts.Program`.
- ESLint side: `Linter.verify` with `@typescript-eslint/parser`.
- Diff is **location-keyed** (`file:line:col`) — count parity isn't
  enough.
- `baseline.json` records the EXPECTED set of (rule, file, location)
  divergences. Each entry should ideally be empty; non-empty entries
  document an intentional or pending divergence.

## Adding rules

1. Append to `RULES` in `rules.config.ts`.
2. (Optional) Add a corpus file that exercises the rule's edge cases.
3. Run `... --update-baseline` to record the current shape.
4. If `baseline.json` is non-empty for the new rule, leave a comment
   in `rules.config.ts` explaining why (or fix the divergence).

## Adding corpus files

Each file should:

- Cover a small, focused pattern (preferably one that's bitten us
  before — see `git log -- packages/compat-eslint/lib/`).
- Be lint-clean from the **rule** perspective (rules under test
  should fire/not fire consistently across both linters).
- Be self-contained or import only from sibling `_*.ts` helpers in the
  same dir.
- Stay small enough to be obvious — corpus files are documentation,
  not stress tests.

## Why this exists

The audit that produced this harness uncovered 18+ rule-parity bugs
in the compat layer that had been shipping for months. Every one of
them was a "form-correct, semantics-off" issue that the existing
fixture-style tests couldn't catch because they didn't compare
TSSLint's output against ESLint's at all.

The first run of this bench, after that audit, also caught a
materialise-loop double-Identifier bug for destructure bindings that
slipped past every prior test. Lesson banked: every rule-parity claim
needs a runnable comparison against the upstream rule, on real-shape
code.
