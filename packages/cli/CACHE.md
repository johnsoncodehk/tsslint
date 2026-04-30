# CLI cache: design notes

This package previously shipped a per-file mtime cache. It was removed
because it was unsound for type-aware rules — see commit removing
`packages/cli/lib/cache.ts` for context. This file lays out how the
replacement should be built.

## What broke in 3.1.0

The 3.1.0 cache invalidated cached diagnostics only on the linted
file's own mtime. Type-aware rules (rules that read
`rulesContext.program` to look up cross-file types) depend on
declarations in *other* files; mtime on the linted file doesn't move
when those dependencies change. Cached results went silently stale.

3.0.4 had a partial guard: it ran rules first against a syntax-only
`LanguageService` whose `program` getter threw on access, caught the
throw, marked the rule type-aware, and excluded type-aware rules from
cache writes. The syntax-only path was removed in c5a8c25; the
cache-skip side effect was lost with it.

## What replaces it

Two layers, gated by a flag.

### Layer 1: per-file mtime cache for syntactic rules

When a rule's diagnostic is a pure function of the linted file's
text, its cached result is valid as long as the file's mtime hasn't
moved. The cache file format records, per `(file, rule)`:
- the source file's mtime at last lint
- the diagnostic list (and whether any had a fix)

On read: if `mtime(file) === cached.mtime` and the rule is classified
as syntactic, reuse the cached diagnostics; otherwise re-run the rule.

Rule classification uses a getter probe on `rulesContext.program` —
the same mechanism implemented in commit 4f4f923. Once a rule
touches `program` in any session, it's marked type-aware (sticky)
and never cached.

This layer always runs, regardless of any user flag.

### Layer 2: BuilderProgram-based invalidation for type-aware rules

ESLint-style per-file mtime can't see global changes (`declare global`,
ambient `.d.ts`, lib files, module augmentation, `@types/*`) that
change a file's effective types without changing its text. TypeScript
already tracks this internally via `BuilderProgram` — the same
machinery that powers `tsc --incremental`.

When the `--incremental` flag is passed (or the equivalent config
option):

1. CLI creates a `ts.createSemanticDiagnosticsBuilderProgram` wrapping
   the `ts.LanguageService`'s program. The first run has no
   `oldProgram`; everything is "affected".
2. Builder serializes its state to a `.tsbuildinfo` file in TSSLint's
   own cache directory (not the user's tsconfig path — that would
   collide with their own `tsc` runs). State persists across sessions.
3. Next session: load the previous `.tsbuildinfo`, pass as `oldProgram`
   to `createSemanticDiagnosticsBuilderProgram`. Walk
   `getSemanticDiagnosticsOfNextAffectedFile()` — those are the files
   whose type-relevant inputs (own content, transitive imports,
   ambient declarations, lib changes) have moved. Type-aware rule
   diagnostics for unaffected files reuse the previous cache.

Type-aware rule diagnostics get written to the cache only when this
layer is active. Without `--incremental`, type-aware rules always
re-run (matches 3.0.4 behavior).

## Cache file format

Single JSON file at `os.tmpdir()/tsslint-cache/<pkg-version>/<key>.cache.json`.
Path key already invalidates on tsslint version change, tsslint.config.ts
mtime/size, tsconfig path, and language plugin set.

Shape (proposed):

```jsonc
{
  "version": "v2",
  // Sticky type-aware classification across sessions. Once a rule has
  // been observed reading `program` in any past session, it stays
  // type-aware until it disappears from the config.
  "ruleModes": {
    "no-leaked-conditional-rendering": "type-aware",
    "semi": "syntactic"
  },
  // Per-file diagnostic cache. Type-aware rule entries only present
  // when layer 2 (BuilderProgram) is active.
  "files": {
    "/abs/path/foo.ts": {
      "mtime": 1234567890,
      "rules": {
        "semi": { "hasFix": false, "diagnostics": [] },
        "no-leaked-conditional-rendering": {
          "hasFix": false,
          "diagnostics": [],
          // Only present in layer 2 mode. Tracks which BuilderProgram
          // version produced this — invalidate if mismatch on load.
          "buildSignature": "<hash>"
        }
      }
    }
  }
}
```

The 3.0.4 / 3.1.0 cache used a tuple `[mtime, lintResult, minimatchResult]`.
Drop the tuple in favor of a self-documenting object — it cost no
measurable space but made the format opaque and migration painful.

`minimatchResult` (per-file pattern→bool cache) is dropped. It was
useful to skip re-running glob matches across runs but the actual
cost is microseconds per file and it added a third tuple slot of
serialization overhead per file. If profiling later shows it back
on the hot path, add it as a separate top-level key, not woven in.

## Implementation outline

Order matters — each step compiles and ships independently:

1. **Restore the getter probe in `core/index.ts`** (already landed in
   4f4f923, removed alongside cache here). Doesn't write or read any
   cache yet — just classifies rules.

2. **Add layer 1**: cache file load/save in CLI; per-file mtime
   invalidation; per-rule lint short-circuit. Type-aware rules never
   cache. Persist `ruleModes` in the cache file so a session starting
   cold knows which rules to skip without re-probing.

3. **Add `--incremental` flag**: create `BuilderProgram` alongside
   the existing `LanguageService`. Use `getSemanticDiagnosticsOfNext-
   AffectedFile()` to enumerate which files BuilderProgram considers
   changed since last run. Cross-reference with `ruleModes`:
   - syntactic rules: layer 1 cache (mtime-only) is authoritative
   - type-aware rules: cache hit only if file is unaffected per
     BuilderProgram AND ruleModes hasn't changed

4. **Manage `.tsbuildinfo`**: enable `incremental: true` in TSSLint's
   internal program options (NOT the user's tsconfig). Set
   `tsBuildInfoFile` to a path under TSSLint's cache directory.

5. **Tests** in `packages/core/test/` and `packages/cli/test/`:
   - syntactic rule cached, type-aware rule not (without `--incremental`)
   - sticky classification across files
   - persistent classification across sessions (load `ruleModes` on init)
   - layer 2: edit `globals.d.ts`, type-aware rule re-runs for
     affected files but not others
   - layer 2: `.tsbuildinfo` corrupted → graceful cache miss

## Edge cases

- **`incremental: true` in user tsconfig**: TSSLint's internal program
  must use its own `tsBuildInfoFile` path. Don't let the user's tsc
  build state collide with TSSLint's.
- **`noEmit: true`**: confirmed compatible with `incremental` — TS
  still writes the buildinfo, just doesn't emit JS. Set both.
- **`.tsbuildinfo` format across TS major versions**: TS doesn't
  guarantee format stability. On parse error, treat as cache miss
  and rebuild. Already the pattern in old `cache.ts:21`.
- **First run cold**: no `oldProgram`, everything affected, full lint.
  Same cost as `--force` today.
- **`--fix` runs**: if any fix wrote to the file, mtime moves and
  layer 1 invalidates that file's entries; layer 2's BuilderProgram
  picks up the snapshot change via project version bump.
- **Rule that conditionally reads `program`**: classified as syntactic
  on a session that doesn't hit the type-aware branch. Later session
  hits the branch → upgrade to type-aware, persist in `ruleModes`.
  The cached results from before the upgrade are stale but the upgrade
  is a one-time event per cache lifetime; users running `--force`
  once after upgrading TSSLint clears any residue.

## Backwards compat

None needed for cache files. The cache file path key includes
`pkg.version`; version bumps create fresh cache directories.
Old cache files just sit unused until OS tmpdir cleanup.

The TSSLint *config API* (`@tsslint/types`) loses `Reporter.withoutCache()`.
That method only made sense when the linter had a cache to suppress
writes to; without one, calling it was a no-op. The new cache impl
may reintroduce a per-report cache opt-out if needed — design TBD,
likely a different shape (e.g. `withDependencies(...filePaths)` or
similar declarative form) once layer 2 lands.

## Pre-implementation checklist

Run through these before writing any cache code. Each one corresponds
to a real failure mode the old design either hit or could have hit.

### Soundness

1. **Write the regression tests first**, before any cache code:
   - Edit `globals.d.ts` (`declare global { ... }`) → linted file must
     re-check
   - Edit imported file's exported type → linted file must re-check
   - Switch `compilerOptions.lib` → all files re-check
   - Edit `compilerOptions` other than lib → whole cache invalidates
   - Add/remove rule in tsslint.config.ts → that rule's entries clear
   - Rule that conditionally reads `program` → after sticky upgrade,
     no stale serve

   Each test corresponds to one invalidation path. Tests failing on
   un-implemented spec is the goal — finishing them all defines done.

2. **Cache miss is always safe**. Treat any uncertainty as a miss:
   - `.tsbuildinfo` parse failure → miss
   - `ruleModes` shape mismatch → miss
   - `getProgram()` returns null → miss
   - File stat throws → miss

   Wrong cache hit corrupts a code-review tool. Wrong miss costs a
   re-run. Bias hard.

3. **`--fix` writes a file**. After a fix, that file's mtime moves
   and its layer-1 entry must invalidate. If the fixed file is an
   import dep of another, layer-2's BuilderProgram must see the
   snapshot change and mark that other file affected. Both paths
   need a regression test.

### Cache key

4. **Include TypeScript's version in the cache path key**. The current
   key is `os.tmpdir()/tsslint-cache/<tsslint-version>/<hash>` — extend
   to `<tsslint-version>/<ts-version>/<hash>`. `.tsbuildinfo` format
   is TS-major-coupled; without this, a TS upgrade silently corrupts
   layer 2.

5. **Cache key already covers**: tsslint.config.ts mtime+size, tsconfig
   path, language plugins. Don't break this on the rewrite.

### Implementation

6. **Atomic write**: `writeFileSync(file.tmp); rename(file.tmp, file)`.
   Old `cache.ts` wrote in-place — SIGINT during write left half-JSON.
   Cheap to fix.

7. **BuilderProgram + LanguageService coexistence**: CLI uses
   `ts.createLanguageService(host)`, which owns its program internally.
   Wrapping in BuilderProgram requires `builder.getProgram() ===
   languageService.getProgram()` to avoid double-building. Spike a
   10-line POC standalone before touching the real CLI flow.

8. **Multi-project / virtual files (Vue / MDX / Astro)**: language
   plugins synthesize virtual `.ts` files with magic suffixes. Cache
   key uses absolute path; verify virtual paths don't collide with
   real ones in a fixture test before relying on it.

### Operational

9. **Add `--force` flag back**. Removed in the cache deletion. Users
   need an escape hatch when something breaks.

10. **Bench a warm-cache scenario**. `tsslint-dify-bench` only tests
    cold runs; can't measure cache value or catch stale-result bugs.
    Add: cold run → identical-input warm run (cache hit expected) →
    edit `globals.d.ts` and warm run again (selective miss expected).
    This is both perf metric and soundness regression gate.

### Realistic upper bound

Profile attached in CPU.20260430.062953.cpuprofile shows the cold-run
breakdown for Dify web/ (5860 files):

```
~5.0 s  TS Program build (parse + bind + resolve)  — cache CANNOT save
~4.4 s  lint pass (rule execution + walker)        — cache CAN save
~1.8 s  process startup + render output            — cache CANNOT save
─────
11.3 s  total
```

`BuilderProgram` does not speed up cold-run program build — `.tsbuildinfo`
stores file signatures and shape hashes, not parsed AST, so parse+bind
must happen every cold start. The cache saves the lint pass on warm
runs. **Upper bound: ~40% wall-time reduction on warm runs**, capped
by the unavoidable Program build.

Set this as the warm-run target before starting; if implementation
doesn't get close, something's wrong with the design.


## Open questions

- Should layer 2 be opt-in (`--incremental`) or default-on once it's
  proven? Default-on is the friendlier UX but `BuilderProgram` adds
  some startup overhead and writes a cache file the user has to know
  about. Default-off until the perf cost is measured.
- Per-rule classification persistence: should we expire `ruleModes`
  entries when a rule disappears from config? Or keep forever? Keep
  forever is simpler; the file grows by one string per rule ever
  used, which is bounded.
- Should the cache work for `--fix` runs? Currently `--fix` runs
  rewrite files; cache stays correct as long as we update mtime
  after write. Layer 2's BuilderProgram automatically tracks the
  snapshot change. No special handling needed.
