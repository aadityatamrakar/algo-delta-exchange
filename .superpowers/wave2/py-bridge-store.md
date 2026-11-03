# py-bridge-store — Tasks 1 & 2 (Bridge client, BridgeStore)

**Status:** DONE. Both tasks implemented, tested, committed, in
`/Users/aaditya/Documents/dev/algo-engine/sensibull-desk` on branch `main`.

## Commits

- `db0439a` — feat(live): bridge HTTP client, fail-soft by contract
  - `sensibull_tools/live/desk/bridge.py`, `tests/test_desk_bridge_client.py`
- `a04e334` — feat(live): BridgeStore duck-types GfdlStore over the bridge
  - `sensibull_tools/live/desk/store.py`, `tests/test_desk_bridge_store.py`,
    `tests/test_desk_bridge_store_ctx.py`

## Test commands and observed counts

```
.venv/bin/pytest tests/test_desk_bridge_client.py -v
  -> 7 passed (plan specified 3; I added 4 more: write-path failure,
     actions() happy path, chain() URL/param shape, trades() unwrap/default)

.venv/bin/pytest tests/test_desk_bridge_store.py -v
  -> 11 passed (plan specified 7; I added 4 more: empty payload, a single
     stale quote among fresh ones — not just "all stale", pre-refresh None
     reads, future()/raw_future() happy path)

.venv/bin/pytest tests/test_desk_bridge_store_ctx.py -v
  -> 2 passed (the plan's ctx-conformance test, plus a two-leg finite/
     nonzero-delta variant)

.venv/bin/python -m pytest tests/ -q
  -> exit 0, 0 failures. Verified via `-rA`: 2185 PASSED, 0 FAILED, 5
     SKIPPED (baseline was ~2163 passed / 5 skipped; this run adds the 20
     new tests above, and skip count is unchanged). Ran with
     `python -m pytest` (not bare `pytest`) — the latter does not put the
     repo root on sys.path, which one pre-existing test file
     (tests/test_sim_hold_recycle_shift.py) needs to import a sibling test
     module as `tests.test_sim_hold_recycle`; that is pre-existing behavior,
     not something this change touched.
```

Note on `-q` output: this pytest install (9.1.1) prints per-test dots/`s`
and, with `-rA`, per-test `PASSED`/`SKIPPED` lines, but never emits the
usual trailing `"N passed in Ts"` summary line — confirmed by running a
small clean subset directly and observing the same absence. Verified
pass/fail/error/skip counts via `grep -c` on `-rA` output instead of
trusting the (missing) summary line.

## What was built

**Task 1 — `sensibull_tools/live/desk/bridge.py`, `class Bridge`.**
Matches the plan's interface exactly (`feed`, `positions`, `chain`, `trades`,
`actions`, `declare`, `put_variants`, `books`, `set_actual`). Verified the
URL/param shapes against the actual routes, not the plan's guess:
`apps/api/src/routes/desk.ts` (`/v1/desk/positions?tag&mode`,
`/v1/desk/trades?tag&mode&limit`, `/v1/desk/chain/:underlying?expiry`,
`/v1/desk/actions` POST) and `apps/api/src/chain.ts`'s `ChainResponse` —
all match the plan's fixtures field-for-field
(`underlying/expiry/spot/spotAsOf/future/futureAsOf/step/lotSize/rows[{strike,
CE,PE}]/feedAlive`, `ChainQuote = {price,oi,volume,asOf,ageMs}`).

**One deliberate deviation from the plan's literal code:** the plan's
template does `import requests` as the default transport. This repo has no
`requests` anywhere in its dependency tree (`pyproject.toml` declares
`httpx`, and `.venv/bin/pip list` confirms no `requests` package at all);
every other network module in the repo (`sensibull_tools/client.py`) is
already `httpx`-based. Using `requests` would have added a new, unused-
elsewhere dependency and made the module fail to import in this venv the
instant a test exercised the real-transport fallback. I substituted
`httpx.get`/`httpx.post` (module-level, same kwarg names: `url, headers,
timeout, params` / `json`), imported lazily. I also fixed a latent bug in
the plan's own template along the way: it imports the fallback transport
eagerly whenever *either* `get_fn` or `post_fn` is `None`, so a test that
overrides only `get_fn` (as every read-path test in the plan does) would
still try to import the transport for the unused write path. I split the
lazy import per verb (`_get_call`/`_post_call`) so overriding one side
never requires the other to be importable — this is what let the plan's
own `test_positions_asks_by_tag_and_mode` (which passes only `get_fn`) pass
without `requests`/`httpx` needing to be touched at all.

**Task 2 — `sensibull_tools/live/desk/store.py`, `class BridgeStore`.**
Implements the six-method duck-type (`spot_ref`, `future`, `raw_future`,
`mark`, `marks`, `raw_chain`) plus `refresh(as_of_ms)` and `stale_quotes()`.
Read `sensibull_tools/gfdl/store.py:174-197` (`GfdlStore.mark`) and matched
its calls exactly: `t = year_frac(date, expiry)`,
`iv = implied_vol(px, S, K, t, r, opt_type)` with `S` = the bridge's
`future` close (never cash `spot`), `gk = greeks(opt_type, S, K, t, r, iv)`,
zeroed-greeks fallback on falsy `iv`. `stale_days` is hardcoded `0`
everywhere (no prior-session backfill live). An unticked strike (`PE: null`
in the chain payload) marks `None`, never `0` — pinned by test.

`refresh` stores the new snapshot as `current` and the outgoing `current` as
`prev`, so `raw_chain` can diff `oi` between them for `d_oi_cp` (`None` on
the first mark after a restart, when there is no `prev`). It returns
`False` — leaving `current`/`prev` untouched — when `bridge.chain()` raises,
returns falsy/no `rows`, `feedAlive` is `False`, or **every** quote's `asOf`
predates today's IST session start (reusing
`sensibull_tools.live.desk.session.session_start_ms`, not a re-derived
09:15 constant). A single stale quote among otherwise-fresh ones does not
fail the whole refresh: it is dropped individually and its `"{strike}-
{side}"` name recorded in `stale_quotes()`, and that one leg marks `None`
while its siblings from the same refresh still price — this asymmetry (all-
stale vs. some-stale) wasn't explicitly pinned by the plan's own tests, so I
added `test_a_single_stale_quote_among_fresh_ones_is_named_but_does_not_
fail_refresh` to cover it, since it's exactly the gap the spec text ("A
per-quote asOf... is rejected individually") calls out.

`future()`/`raw_future()`: the bridge's `/v1/desk/chain` payload carries no
future OI/volume (only `future`/`futureAsOf` price), so those fields
fail-soft to `0.0` rather than fabricate a print that was never served —
noted in the code, not pinned by a plan test, and not exercised by
`mark_book`'s option path so it doesn't affect the conformance test.

**Conformance test** (`tests/test_desk_bridge_store_ctx.py`): ran the real,
unmodified `sensibull_tools.sim.book.mark_book` over a `BridgeStore`,
matched the plan's book-leg field names by reading `sim/book.py:240-315`
(`instrument`, `opt_type`, `strike`, `expiry`, `side`, `lots`, `lot_size`,
`entry` — confirmed, not guessed). Verified manually (not just via the
`!= 0.0` assertion) that the greeks are genuinely computed rather than
falling back to zero: for the plan's fixture, IV comes out ≈16.7% and net
delta ≈ -7613, gamma/theta/vega all nonzero — i.e. the IV inversion and
Black-76 greeks path is actually exercised, not silently defaulting.

## Concerns / things the next task (Task 3+) should know

1. **`requests` → `httpx` substitution.** If a later task or a human
   re-reads the plan's literal bridge.py code and expects `requests`, they
   will hit the same `ModuleNotFoundError` I hit. Flagging this explicitly
   since the plan's own "Tech Stack" line names `requests`.
2. **No final pytest summary line** in this environment (pytest 9.1.1,
   `-q`). Anyone scripting "grep the last line for 'passed'" against this
   suite will get nothing; use `-rA` and count `PASSED`/`FAILED` lines, or
   check the exit code.
3. **`BridgeStore.raw_chain`'s `date`/`time`/`expiry` args are accepted but
   not used to select data** — the store only ever holds one live snapshot;
   `date` is only meaningful to `mark()`'s `year_frac` tenor calculation.
   This matters for whoever wires Task 5's `driver.py` → `build_chain`: when
   `build_chain` calls `store.raw_chain(symbol, date, prev_cp_time, exp)` to
   fetch a ΔOI *reference* snapshot (`sim/chain.py:50`), a `BridgeStore`
   will return the **same current snapshot** regardless of `prev_cp_time`
   (it has no by-time history) — so `build_chain`'s own `d_oi_cp` (computed
   by diffing two `raw_chain` calls) will come out `0`/`None` for every
   leg, while `BridgeStore.raw_chain`'s own embedded `d_oi_cp` field (from
   its internal current/prev memoization, which IS meaningful) is what
   `build_chain` currently ignores — it reads `leg["oi"]` off each
   `raw_chain` call and diffs those itself, never `leg["d_oi_cp"]`. Task 5
   needs to either not pass `prev_cp_time` into `build_chain` for a
   `BridgeStore` (letting `d_oi_cp` come from the embedded field via a
   post-hoc reconciliation) or accept that `build_chain`'s `d_oi_cp` is
   flat live and rely on `raw_chain`'s own field instead. This is a real
   design seam between Task 2 and Task 5, not a bug in either — flagging it
   per the plan's own Task 2 spec text, which was explicit that
   `raw_chain` "can serve `d_oi_cp`" itself for exactly this reason.
4. Did not touch `sensibull_tools/sim/**`, `translate.py`, or `session.py`
   (already landed, per the task brief) — only Tasks 1 and 2 as instructed.
5. `apps/api/src/routes/books.ts`'s `POST /v1/desk/books/registry/:tag/
   actual` route (needed by `Bridge.set_actual`, per the plan's Step 3 note)
   was **not** verified/added — out of scope for Tasks 1–2 as scoped to me
   (TypeScript, a different repo), flagging so whoever does Task 5/7 checks
   it exists.
