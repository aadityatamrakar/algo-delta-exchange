# Seam-and-supervisor — status report

Repo: `/Users/aaditya/Documents/dev/algo-engine/sensibull-desk` (branch `main`)

## Status: DONE, both parts

## Commits

1. `5001f11` — `fix(live): BridgeStore.raw_chain honours the requested checkpoint`
2. `916a3fc` — `feat(live): supervisor converging the registry to workers`

## Pytest command and observed counts

```
.venv/bin/python -m pytest tests/ -q --junit-xml=<...>.xml
```

Final run (after both commits): **2217 tests, 0 failures, 0 errors, 5 skipped**
(junit `<testsuite errors="0" failures="0" skipped="5" tests="2217">`, exit code 0).
Baseline was 2206 passed / 0 failed / 5 skipped; net +11 new tests across the
two parts (2 in `test_desk_bridge_store.py`, 9 in the new
`test_desk_supervisor.py`; note pytest's terminal reporter in this sandbox
prints no final "N passed" summary line for unknown reasons, so counts here
come from `--junit-xml`, which is authoritative).

Part-1-only run: `.venv/bin/python -m pytest tests/test_desk_bridge_store.py -q`
→ 13 passed. Part-2-only run: `.venv/bin/python -m pytest tests/test_desk_supervisor.py -v`
→ 8 passed.

## Part 1 — the ΔOI seam

**Read first, as instructed, and the fix follows exactly what was found — no
deviation from your description was needed.**

`sim.chain.build_chain` calls `store.raw_chain` **twice** per checkpoint:
once for "now" (`time=cp`) and once for its own cross-checkpoint reference
(`time=prev_cp_time`), then diffs the two results' own `oi` fields itself via
its private `_d()` helper — it never reads `raw_chain`'s own `d_oi_cp` key at
all. `GfdlStore.raw_chain` answers those two calls with two genuinely
different historical snapshots (an as-of scan by `date`/`time` over the
parquet lake). `BridgeStore.raw_chain` ignored `date`/`time` for data
selection entirely (per its own honest docstring) and always answered off
`self._current` — so both of `build_chain`'s calls got the same OI and its
`_d()` diff was always `0`, i.e. "flat," while `BridgeStore`'s own internally
diffed `d_oi_cp` field (current vs. its remembered `prev`) went completely
unused by `build_chain`.

**Fix** (`sensibull_tools/live/desk/store.py`):
- `refresh(as_of_ms)` now stamps each snapshot with the `"HH:MM"` session
  checkpoint it belongs to (`_checkpoint()`, reusing
  `session.mark_time` — the identical grid the driver marks on), keeping
  `self._current_cp` / `self._prev_cp` alongside the existing
  `self._current` / `self._prev` snapshots.
- `raw_chain(underlying, date, time, expiry)`: when `time` (`[:5]`) equals
  the checkpoint held as `prev` (and differs from `current`'s own
  checkpoint, guarding a same-checkpoint double-refresh edge case), it now
  serves the `prev` snapshot's own strikes verbatim instead of `current`.
  Any other `time` — "now"'s own checkpoint, or one this store has no record
  of — still falls back to `current`, unchanged from before.
- `d_oi_cp` is computed only when serving `current` (diffed against `prev`,
  exactly as before) and is `None` when serving `prev` (there is no snapshot
  before `prev` to diff it against — "unknown," never invented as zero) —
  this preserves the docstring's stated first-mark-after-restart contract
  verbatim, per your instruction to keep it.
- `date` still plays no part in selection (the bridge only ever has "now"
  and the one snapshot before it, as the module docstring says) — only the
  fix to `time`-selection was needed.

## How the pre-fix failure was verified

Two new tests were added to `tests/test_desk_bridge_store.py`:
`test_raw_chain_honours_the_requested_checkpoint_not_just_current` (a direct
two-call sequence mirroring `build_chain`'s own calls) and
`test_build_chain_over_bridge_store_reports_the_real_cross_checkpoint_d_oi`
(the real `build_chain` function, not a mock, over a real `BridgeStore`).

Verification sequence:
1. Wrote both tests against the **unmodified** `store.py`, ran
   `.venv/bin/python -m pytest tests/test_desk_bridge_store.py -q -k "raw_chain_honours or build_chain_over_bridge"`.
   First attempt used the literal checkpoint strings from the plan text
   (`"10:15"`/`"10:20"`) and passed — which turned out to be a **test bug**,
   not a fix: those strings did not actually match `NOW_MS`'s real IST wall
   clock (`NOW_MS` decodes to `11:25`/`11:30` IST, not `10:15`/`10:20` as
   its comment claimed), so the test was accidentally exercising the
   catch-all fallback branch rather than checkpoint-matching at all.
2. Caught this by computing the real checkpoints programmatically
   (`session.mark_time` over `NOW_MS`/`NOW_MS+300_000`) instead of trusting
   the literal strings, and re-ran.
3. `git stash push -- sensibull_tools/live/desk/store.py` to isolate the
   test-only diff against the genuinely unmodified store, then ran the two
   tests again:
   - `test_raw_chain_honours_the_requested_checkpoint_not_just_current`:
     `assert prev_oi == 1200` failed with `assert 1500 == 1200` — the "prev"
     call returned current's OI.
   - `test_build_chain_over_bridge_store_reports_the_real_cross_checkpoint_d_oi`:
     `assert row["CE"]["d_oi_cp"] == 300` failed with `assert 0 == 300` — the
     real, disclosed seam, reproduced end-to-end through `build_chain`.
4. `git stash pop` to restore the fix; both tests then passed, and the full
   `tests/test_desk_bridge_store.py` file (13 tests) stayed green, along with
   the full suite (§ counts above).

## Part 2 — the supervisor

Created `sensibull_tools/live/desk/supervisor.py`, `class Supervisor` with
`converge(now_ist) -> dict` and `publish_catalogue() -> None`, per Task 7 of
`docs/superpowers/plans/2026-07-28-desk-books-phase3-4-live-driver.md`. Tests
in `tests/test_desk_supervisor.py` (8 tests, all fakes — no network, no disk
outside `tmp_path`).

- `publish_catalogue()` reads `sim.variants.list_variants()` /
  `get_variant()`, keeps only `decider == "rule-engine"`, and posts
  `{key, decider, playbook, dials: {target_pnl, margin_cap}}` (from
  `default_target_pnl` / `default_margin_cap`) via `bridge.put_variants`.
  Verified against the real registry: `hold-recycle-r` is included;
  `delta2` (hybrid), `llm`, and `rules` (pure-python but not `rule-engine`)
  are excluded.
- `converge(now_ist)` pulls `bridge.books(mode)`, starts a worker for each
  row newly `desired == "running"` (via an injectable `worker_factory`,
  defaulting to building a real `BookDriver` wired with
  `variants.build_decider` and a lot size resolved from the row's
  `dials.lot_size` / first `seedLegs` entry — logged and skipped if neither
  is present), stops workers whose row is no longer `desired == "running"`,
  ticks every currently-running worker at `now_ist`, and reports `actual`
  (`"running"`/`"stopped"`) plus the last `decisionId` back per book via
  `bridge.set_actual`. All of it fail-soft: a bad row, a worker-build
  failure, or a raising tick is logged and skipped, never raised out of
  `converge`.
- **The guard** (`Supervisor._already_managed`): reads
  `sensibull_tools.live.store.list_live_books(dir=self._legacy_dir)` — the
  OLD `sensibull-live` loop's `{SYMBOL: [variant, ...]}` map under
  `data/live/<SYMBOL>/<variant>.state.json` — and refuses to start any book
  whose `(symbol, variant)` appears there, recording a refusal string
  containing `"already managed"` and leaving `self.workers` untouched for
  that book. Both required scenarios are tested and pass:
  - `test_it_refuses_a_book_the_old_live_loop_already_manages`: a
    `data/live/BHEL/hold-recycle-r.state.json` fixture under `legacy_dir`
    causes `converge` to refuse the matching book — `s.workers == {}`.
  - `test_its_own_state_root_does_not_trip_the_guard`: an **identically
    shaped** file (`BHEL/hold-recycle-r.state.json`) placed under
    `state_dir` (the supervisor's own root, standing in for `data/desk/`)
    does **not** trip the guard, because `_already_managed` only ever reads
    `self._legacy_dir`, never `self._state_dir` — the book starts normally.

`ecosystem.config.js`/`scripts/desk-supervisor.sh` (Task 7 steps 4-5, the pm2
wiring) were **not** touched — out of scope for "Task 7 only" as the module
implementation was the explicit ask, and no `ecosystem.config.js` deployment
context (real bridge URL/token, pm2 process layout) was available to verify
against in this pass. Flagged as a concern below.

## Concerns

1. **`ecosystem.config.js` / `scripts/desk-supervisor.sh` not added.** The
   plan's Task 7 also calls for a pm2 app entry and a launch script
   (`scripts/desk-supervisor.sh`, following `scripts/live-tick.sh`'s venv
   guard). I deliberately scoped this pass to "Task 7 only" = the
   `Supervisor` class per your instruction; the pm2/script wiring is a small
   follow-up if wanted.
2. **`lot_size` sourcing for the default (production) worker factory is a
   judgment call.** Neither the plan nor the design spec state where a
   `desk-books` registry row carries lot size. I resolve it from
   `row["dials"]["lot_size"]` first, then the first `seedLegs[0]["lot_size"]`,
   and skip starting (logged) if neither is present — documented in
   `_lot_size_of`'s docstring. This path is exercised only by the default
   factory, which the tests bypass via the injectable `worker_factory` seam
   (as the task explicitly asked for: fakes, no network). Worth confirming
   against the real `desk-books` row shape once algomaker's registry ships.
3. **`converge`'s per-tick `decisionId` plumbing back into `set_actual` is
   my design, not literally specified.** The plan only requires "reports
   actual back via the bridge"; I report `actual` (`"running"`/`"stopped"`)
   and the worker's last `decisionId` (or a refusal string) each pass. If
   the real registry expects a different `actual` vocabulary, `Bridge.set_actual`'s
   call site in `converge` is the one place to adjust.
4. **Orphaned workers** (a row disappears from the registry entirely rather
   than switching to `desired: "stopped"`) are left running — `converge`
   only reacts to rows it currently sees. Not covered by a test; flagging in
   case the registry can silently drop rows in practice.
5. Found (but did not need to touch, per your instruction not to modify
   `sim/**`) that `sim.chain.build_chain`'s own `d_oi_cp` computation is the
   only consumer of `raw_chain`'s `oi` field for ΔOI — `raw_chain`'s own
   `d_oi_cp` key is dead weight from `build_chain`'s point of view (used only
   by direct `raw_chain` callers, if any exist outside `build_chain`, and
   by the pre-existing `test_raw_chain_has_no_d_oi...` test). Kept it rather
   than removing it, since removing an unused-but-documented field wasn't
   part of the ask and nothing else in the read code seemed to depend on
   its absence either way.
