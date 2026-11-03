# legacy/ — archived strategies

**Moved here 2026-07-25, not deleted.** Every file's logic is documented first (see below), and
`git mv` preserved full history — `git log --follow legacy/slive/<file>.js` works normally.

## What's here

| Path | Files | Was |
|---|---|---|
| `legacy/slive/` | 137 | `server/slive/` — everything outside the active set |
| `legacy/smp/` | 134 | `server/smp/` — the entire staging/authoring directory |

`server/slive/` now holds exactly **19** files: the 15 active strategy modules plus 4 pure-logic
helpers (`atr-band-logic`, `orb-fut-core`, `orb-fut-logic`, `orb-scalp-logic`).

## Why these were archived

Scope decision by the owner: **only strategies with `autostart: true` or a `delay_start` value in
`common/models/strategies.json` are in scope.** That is 15 strategies + 1 service out of ~380
files. See `context/09-active-strategy-scope.md`.

`server/smp/` emptied completely because it was the *staging* directory: strategies were authored
there, promoted into `slive` in the same commit, and thereafter only `slive` received feature work.
Its 26 slive-twinned files were stale copies; its 108 orphans were unregistered experiments.

## Where the documentation lives

**Read these before reviving anything.** Every archived file is covered:

- `context/strategy-specs/00-taxonomy.md` — the unified taxonomy. All **290** filenames (156 slive
  + 134 smp) appear in its migration ledger; verified by exhaustive filename check.
- `context/strategy-specs/{lion,bull,eagle,cheetah-hft,stgl,rv-cp,p718-spread,singles,modern,smp-drift}.md`
  — per-family canonical algorithms in pseudocode, per-file config tables, and preserve/risk notes.
  Written to be implementable **without** re-reading these legacy files.
- `context/04-strategy-catalog.md` — narrative family overview.
- `context/sheets/slive-strategies.csv` — 156 rows, one per original slive file.
- `context/sheets/legacy-strategies.csv` — 408 rows covering the older dead directories.

## Safety checks performed before the move

- **No external references.** Nothing outside `slive`/`smp` requires any moved file.
- **Tests unaffected.** The only cross-directory requires are 3 files in `server/test/` pointing at
  `atr-band-logic`, `orb-fut-logic`, `orb-scalp-logic` — all keepers. 113 tests pass after the move.
- **pm2 unaffected.** `server/tools/ob_start.js:10,22` restarts by pm2 *name*
  (`Manager.restart(module)`), not by filesystem path, so no path resolution breaks.
- **Dependency closure intact.** The active set's 26-file transitive closure resolves with zero
  broken requires.
- **All 22 `ecosystem.config.cjs` script paths still resolve.**

## Registry entries now pointing here

Of the 101 entries in `common/models/strategies.json`:

- **17** still resolve to `server/` (the 16 active modules plus `smp_target`, which lives in
  `server/tools/` with `autostart: false`)
- **84** now resolve to `legacy/`
- **0** resolve to nothing

Verified: **no entry with `autostart: true` or a `delay_start` points into `legacy/`.** The 84 all
have `autostart: false` and no `delay_start`, so `ob_start` never launches them and nothing breaks.
They are left in place deliberately as a record; prune them when the registry is replaced by the new
config system.

## Reviving a strategy

1. Read its spec in `context/strategy-specs/`.
2. Prefer implementing it as a **config record** against one of the 12 new strategy classes rather
   than restoring the file — the whole point of the taxonomy.
3. If you must run the legacy file, `git mv` it back to `server/slive/` and check its `require`
   paths still resolve (they were all relative to `server/slive/`, so depth is unchanged).

## Do not delete this directory

These files are the historical record of what was tried and why. Several encode ideas absent from
the active set (`rv-1`'s realized-volatility strike rolling, the `ce-d2*` depth-priced credit-spread
scanner, `p718`'s Supertrend gating). Deleting them destroys information the specs only summarise.
