# Task 5 — the driver (sensibull-desk)

## Status
DONE. `BookDriver` (`tick`, `recover`) implemented in
`sensibull_tools/live/desk/driver.py`, with 15 pytest tests in
`tests/test_desk_driver.py`. All fakes for `Bridge` and the decider; the
real `BridgeStore` marks off a canned chain payload. No network, no disk
outside `tmp_path`.

## Commit
Repo: `/Users/aaditya/Documents/dev/algo-engine/sensibull-desk` (branch `main`)

```
634f050 feat(live): the book driver — session gates, settle, recovery
```
(parent: `a04e334 feat(live): BridgeStore duck-types GfdlStore over the bridge`, already landed)

## Test command and observed output

```
.venv/bin/pytest tests/test_desk_driver.py -v
```
→ 15 passed.

```
.venv/bin/python -m pytest tests/ --junit-xml=/tmp/junit.xml -q
```
→ `tests="2206" errors="0" failures="0" skipped="5"` (baseline ~2163 passed/5
skipped + this task's 15 new driver tests + Task 1-4's already-landed tests
now also collected together = 2206; no regression).

Note: plain `.venv/bin/pytest tests/ -q` (not `-m pytest`) fails to *collect*
one pre-existing, unrelated file (`tests/test_sim_hold_recycle_shift.py`,
`ModuleNotFoundError: No module named 'tests'`) because `pytest` invoked
directly doesn't put the repo root on `sys.path` the way `python -m pytest`
does. Confirmed pre-existing and unrelated to this task: reproduces identically
on the tree before this task's two new files existed. Use
`.venv/bin/python -m pytest tests/ -q` to run the full suite.

## What was built

`sensibull_tools/live/desk/driver.py` — `class BookDriver`:
- `tick(now_ist)` — one mark: session gate → reconcile-fold → settle-or-normal
  routing → gates (feed/complete-stale/refresh) → `mark_book`/`build_chain` →
  ctx build → `decider.decide` → leg-id minting → `throttle.submit` →
  `translate.to_actions` → `bridge.actions` → ROUTING/empty check →
  `blocked_tags` rollback → `apply_fills` → save state/ledger/mark →
  `bridge.declare`.
- `recover(now_ist)` — walks `session.marks_between(last_mark, now)`, re-posts
  each missed mark under its own deterministic `decisionId` with **empty**
  actions (never recomputes a decision — see design note below), folds
  whatever fills the bridge's replay idempotency returns, stops at the first
  ROUTING/empty response so the same mark is retried, not skipped.
- State persists via the already-landed `sensibull_tools/live/store.py`,
  rooted at `data/desk/` (or `$SENSIBULL_DESK_STATE_DIR`), keyed by **tag as
  the directory** and **mode as the filename** — `<dir>/<TAG>/<mode>.state.json`
  — never the old loop's `data/live/` default.

## Deliberate design decisions worth a second pair of eyes

1. **The settle check runs BEFORE the feed/positions/store-refresh gates**,
   not after them as the plan's literal step numbering (0..12) reads. A
   `close_ids` action needs no local price — the bridge marks and fills it —
   and the task brief itself warns that once the contract's expiry passes it
   drops out of the master and *nothing* can close it, including a manual
   close-all. Gating the one shot at the settle behind a transient feed
   hiccup at 15:30 on expiry day seemed like exactly the failure the settle
   exists to prevent, so I moved the check earlier and documented why in the
   module docstring and inline. Covered by
   `test_the_settle_still_fires_when_the_feed_is_dead`. **If this reading is
   wrong** — if the settle is meant to inherit the same gates as an ordinary
   mark — this is the one line to revert (`if settle:` in `_tick`).

2. **`recover()` never recomputes a decision for a missed mark** — it
   re-posts each missed mark's deterministic `decisionId` with an *empty*
   actions list, relying on the bridge's own idempotent-replay behavior to
   surface whatever fills a pre-crash decision for that exact mark actually
   produced. I read "discards any fresh decision" as meaning no fresh
   decision is ever computed during recovery, not that one is computed and
   then thrown away. The one exception: a missed mark that was itself the
   expiry settle is rebuilt (not replaced with a no-op), for the same reason
   as (1).

3. **`ctx["state"]` is added on top of the 13 keys `sim/engine.py:266-272`
   builds.** The backtest never needs it (one `RuleEngine` instance lives the
   whole cycle and owns `self.rule_state` internally); the live driver
   restarts across processes, and `RuleEngine.decide()`'s own docstring
   documents exactly this override ("a caller-supplied `ctx['state']` always
   wins"). Read "exactly the keys" as "match the 13 required fields
   precisely" rather than "no additional key may ever appear" — flagging in
   case that's too permissive a reading.

4. **`lot_size` is a required `BookDriver` constructor argument**, not pulled
   live off the chain each mark. `BridgeStore` doesn't expose it publicly (it
   holds `lotSize` in a private snapshot dict), and a brand-new leg's fill —
   before any leg exists in the book to read a lot size off of — would
   otherwise have nowhere to get it from. Did not modify `store.py` to add an
   accessor, per the instruction to treat Task 1-4 as landed/fixed.

5. **The corridor-anchor rollback is whole-`rule_state`, not leg-scoped.**
   When any action in a decision is blocked (`skips` ∪ `routeErrors`) and the
   mark wasn't a settle, the entire `rule_state` dict reverts to its
   pre-`decide()` snapshot. hold-recycle only ever proposes one merged action
   per mark, so this is exact for the variant this driver targets; it would
   over-revert a decider that proposed several independent legs in one
   decision, only one of which got blocked. Noted rather than solved because
   no playbook this driver runs does that today.

6. **Corrected one test in the plan's own illustrative skeleton.** The given
   `test_recovery_reposts_every_missed_mark_before_resuming` snippet uses
   `s["decisionId"].rsplit(":", 1)[1]`, which — because the decisionId is
   `tag:mode:dateThh:mm` and already contains a colon inside `hh:mm` — lands
   on the wrong side of the last colon (`"20"`, not `"10:20"`). My version
   (`tests/test_desk_driver.py`) asserts the full decisionId string instead.

7. No CLI/`--once`/`main()` entry point was built. Task 5's own "Interfaces"
   section lists only `class BookDriver` with `tick`/`recover`; the
   `python -m sensibull_tools.live.desk.driver --tag ... --once` invocation
   appears only in the plan's overall "Phase exit condition", which spans
   tasks 6-7 too. Left out to keep this task's surface area matched to its
   stated interface — flagging in case a thin CLI wrapper was expected here.

## Not done (out of scope for Task 5)
- Task 6 (parity harness, `record.py`) and Task 7 (supervisor,
  `ecosystem.config.js`) — not part of this task's brief.
- `sim/**` was not touched.

## Concerns for review
- Items 1-3 above are genuine judgment calls that diverge from the plan's
  literal step ordering / test skeleton; worth a deliberate look rather than
  a rubber stamp.
- `apply_fills`'/`reconcile`'s realized-P&L sign convention and the
  `close_parts`→absolute-resize mapping were exercised only indirectly here
  (through `translate`, already unit-tested in Task 3); this task did not
  re-verify them.
- The settle-bypasses-gates design (item 1) means a settle mark is now the
  *only* path that can post actions while `bridge.feed()` is reporting dead —
  worth confirming the bridge's own order-routing path doesn't itself
  hard-depend on `feedAlive` in a way that would silently no-op the close
  server-side even though the Python driver did everything right.
