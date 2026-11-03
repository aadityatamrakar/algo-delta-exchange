# Recenter Supervisor Migration — Design Spec

**Date:** 2026-08-21 (Friday) · **Rev 2** (post-grilling session, same day)
**Status:** Approved design. Implementation plan next.
**Rollout:** built and verified over the weekend 2026-08-22/23; **launch is any
trading day after** (operator's call — possibly Thu/Fri). Books are currently
flat; there is no open position to migrate and **no fallback to the old
system** — this is a complete cutover.

---

## 1. What this is

Retire the Python `desk-supervisor` / `desk-supervisor-live` processes in
`sensibull-desk` and rebuild the recenter position-management system natively in
this repo as TypeScript: a new `apps/supervisor` process, a pure decision engine
in a shared package, a redesigned typed contract to desk-api, tick-driven
evaluation off live bid/ask, passive-first execution with a quote-aware chase,
and a section/toggle/input dials UI. One repo, one deploy, one ledger.

Python keeps: the research dashboard, scheduler, research desk agents, and the
sim/backtest stack (it generates our parity fixtures and stays useful for
research). Those are out of scope.

### Decisions (operator-approved; D1–D8 in the design session, D9–D15 in the grilling session)

| # | Decision |
|---|---|
| D1 | Port the **whole recenter family** (both algorithms), merged into **one parameterized engine**. `recenter-relief-r` is the only variant recently live, but every family behavior must be available as a toggle. |
| D2 | Variants stop being code. They become **presets** — named dial-sets that prefill a section/toggle/input modal on the Books page. |
| D3 | **All pricing off live two-sided bid/ask** end to end. Each consumer names the side it reads (§6). The Python engine's single mid-or-LTP float is a known accuracy defect (it drops `bid`/`ask` on arrival, `store.py:139`). |
| D4 | **Tick-driven evaluation** replaces the 30 s poll / 5-min mark cadence, with explicit damping applied to **every order-producing trigger, phase S included** (§7). |
| D5 | **No cross-system position sync.** Single ledger (`desk-books`, folded by desk-api). Broker-truth reconciliation is retained as a periodic invariant check, alert-first. |
| D6 | `desk-supervisor` is a **separate pm2 process** from desk-runner and desk-api, independently restartable **during market hours**: stop is inert (no square-off), rehydration takes seconds, in-flight orders are re-adopted on boot. |
| D7 | **New native TS contract**; storage/schema changes allowed. Justified by flat books: there is no live position to protect through a cutover. |
| D8 | **Reduced dial schema**: constants-in-disguise deleted, sentinel off-states replaced with explicit ones, ~30 visible fields grouped in sections + a collapsed Advanced set (§5). |
| D9 | **Complete cutover, no fallback, no dead code.** The Python supervisors, their endpoints, and the Python-shaped contract machinery are removed in the migration itself (§9). Launch is decoupled from a fixed date; the gate is a readiness checklist, not a calendar. |
| D10 | **Execution is passive-first**: orders join the touch; the gateway re-pegs them via atomic XTS MODIFY as the touch moves; after a deadline they cross with a small buffer; still unfilled → rest + alert (§8). |
| D11 | **Pacing is fill-gated serial tranches** (`work_tranche_lots`, default 3): the next tranche is placed only when the previous reports terminal. The time-window throttle is deleted. Guard-tier exits escalate to freeze-limit-sized tranches and immediate crossing. XTS `disclosedQuantity` is a possible later addition, **only after a manual broker test** — it is currently dead wire in our integration. |
| D12 | **The engine manages the full position by default.** Protection is **opt-in** per leg from the UI, stored as quantity-per-instrument. The `*_shorts_only` toggles are greeks-population controls only, unrelated to protection. |
| D13 | **No automated loss stop.** Explicit operator decision: monitoring is manual; intervention is manual. (F-28 remains unwired by choice, not oversight.) |
| D14 | **The paper rail runs the full order lifecycle** — placed → working/pegged → fill event later — with tick-driven crossing fills; prices may be approximate, the *action path* must match live. |
| D15 | **Parity gates on code and tests only**: synthetic-context decision fixtures (all 12 presets, state threaded across mark sequences) + the transliterated Python test suite. No real-market ledger replay required for launch. |

---

## 2. Source system summary (what is being replaced)

Full maps: the 2026-08-21 exploration reports (Python supervisor; algomaker
architecture; gateway execution machinery; fixture data). Key facts the design
builds on:

- The recenter family is **12 variants over exactly 2 functions**:
  `recenter()` (`playbooks.py:3435`, 442 LOC — LIFO unwind, recycle/credit
  bank, EOD sweep, trend skew, gk-anchor, balance tier) and `recenter_shift()`
  (`playbooks.py:3879`, 291 LOC — margin-gated ITM shift + delta shed;
  **this is what relief-r runs**). They diverge structurally; the merge is a
  deliberate design act, not a dial union.
- Python holds **no database**; it speaks 9 HTTP endpoints to desk-api.
  Python maintains its **own book** beside the bridge's book; ~2,000 LOC of
  `translate.py` exists solely to keep the two ledgers agreeing. The
  single-ledger design (§4) makes almost all of it unnecessary.
- Core port surface ≈ 8,500 LOC Python; **2,842 lines / 224 test functions**
  across `tests/test_sim_recenter*.py` are transliterable. No scipy/numpy on
  the supervisor path. Black-76 + IV exist in `packages/greeks`; the relief
  trigger arithmetic exists in `packages/payoff` with Python parity fixtures.
- **Fixture source verified locally** (no prod access needed): the Python test
  suite's synthetic context builder (`tests/test_sim_hold_recycle.py` —
  `_ctx`/`_chain_rows`/`_sold_book`) fabricates complete engine inputs; all 12
  playbook default-sets import cleanly; `gen-parity-fixtures.py` already runs
  locally. Recenter is **stateful across marks**, so fixtures are mark
  *sequences* with `state` threaded and `state_after` recorded.
- The hard part is not math: the Python driver/translate layers are ~40 %
  comments naming dated prod incidents (ITC 2026-08-03 six-fold resize, ITC
  2026-07-31 null-strike runaway, TCS 2026-06-19 phantom-profit target lock,
  VEDL Dec-25 naked-call convexity hold). Every one must survive the port as
  behavior + test — the relevant ones are called out inline below.

---

## 3. Target architecture

```
                 ┌────────────────────────────────────────────────┐
                 │ apps/marketdata  (unchanged)                   │
                 │  Kite feed → md.tick {token,price,bid,ask,ts}  │
                 └──────────────┬─────────────────────────────────┘
                                │ WS bus :8791 (broadcast)
                ┌───────────────┼──────────────────────┐
                ▼               ▼                      │
 ┌──────────────────────────┐  ┌───────────────────────▼──────────┐
 │ apps/supervisor (NEW)    │  │ apps/order-gateway (extended)    │
 │  pm2 "desk-supervisor"   │  │  peg-mode chaser (md.tick touch) │
 │  ChainView, own greeks   │  │  fill-gated tranche placement    │
 │  EngineHost per book     │  │  atomic XTS MODIFY re-pegs       │
 │  state: desk-supervisor- │  └───────────────▲──────────────────┘
 │   state (single writer)  │                  │ desk-gateway-orders
 │  ledger: desk-engine-    │  ┌───────────────┴──────────────────┐
 │   decisions              │──▶ apps/api (desk-api)              │
 │  HTTP :8793 nudges+health│  │  gates (unchanged) → rails →     │
 └──────────────────────────┘  │  folds desk-books = ONE ledger   │
      POST /v1/desk/engine/    └──────────────────────────────────┘
      decisions
```

- **`apps/supervisor`** — new workspace, `bin/desk-supervisor.mjs` calling
  `main()` explicitly, pm2 entry in `ecosystem.desk.config.cjs` namespace
  `desk`, `installCrashGuards()` first line, `connectWithRetry(connectMongo)`,
  every interval `.unref()`ed. No broker credentials. Never writes any order
  collection. Listens on **:8793** for best-effort nudges (dial change, fill
  arrived) and health.
- **`packages/desk-engine`** — new package: the pure merged engine, the
  contract types, the preset catalogue. Imported by supervisor, api, and web.
  Zero IO, per the strategy-kit logic-split convention.
- **desk-api** — gains the new endpoint + nudge client; keeps all gates,
  rails, folding, journaling. Python-facing endpoints removed (§9).
- **apps/order-gateway — extended, not rewritten** (§8): unconditional
  `md.tick` bus subscription (declare the missing `@algomaker/bus` dep — it
  currently resolves only via workspace symlink), peg-mode on the existing
  chaser, fill-gated tranche placement. Chaser scaffolding (single-flight,
  dwell, cancel-wins, exhaustion, kill switch) is reused as-is.
- **marketdata, desk-runner** — untouched.
- **Removed** (§9): Python supervisor pm2 apps, `POST /v1/desk/actions`,
  `POST /v1/desk/variants`, the `CE530#3` deskTag contract machinery,
  `docs/PYTHON-DESK.md`, `data/desk/` file state (tar-archived first).

Process isolation properties (D6): SIGTERM sets a stop flag, in-flight work
completes, **nothing is squared off** (explicit test; desk-runner does the
opposite and the asymmetry must never blur). Restart mid-session: rehydrate
from Mongo (§10), resolve in-flight decisions, resume on next tick. A Mongo
lease (`desk-supervisor-lease`, compare-and-set with TTL heartbeat) prevents
two supervisors steering the same books.

---

## 4. Single ledger, protection semantics

`desk-books` (folded by desk-api from fills — it already carries the F-26
leg-by-leg reduce fix and the F-27 compare-and-set retry) is **the** book.
The supervisor holds no separate position ledger.

**The engine manages the full position by default (D12).** Every leg in the
book — built from the Build screen, opened by the engine, placed by hand — is
steerable. Protection is opt-in:

- The book-page leg row gets a **Protect** control writing
  `{instrument → protectedQty}` into supervisor state (quantity per
  instrument, not per leg — `desk-books` legally holds the same contract on
  several legs, and quantities survive desk-api's leg folding without leg
  identity).
- The engine exempts `min(protectedQty, heldQty)` from routine shift / shed /
  scrap / close / resize selection; protected quantity **is** counted in every
  greek, MTM, and margin figure; whole-book terminal exits (target lock,
  expiry settle) ignore protection.
- `delta_shorts_only` / `gamma_shorts_only` are **greeks-population dials**
  (which legs feed steering netΔ/netΓ) and have nothing to do with protection.

What the supervisor persists (`desk-supervisor-state`, keyed `${tag}:${mode}`,
single writer):

| Field | Purpose |
|---|---|
| `ruleState` | Engine persistent state: credit bank, scrap bans, target streak/lock, ratchet, eod-day consumed, anchor EMA, last action |
| `workingPackage` | The in-progress decision's remaining tranches (survives restart) |
| `protectedQty` | `{instrument → qty}` from the UI Protect control |
| `cumRealized` | Running realized P&L folded from fill events at the fill's own price |
| `inFlight` | The one unresolved decisionId, if any |
| `updatedAt` | Version for compare-and-set |

`cumRealized` is folded exclusively at **the fill's own reported price**
(Python's rule, kept verbatim) and is cross-checked against desk-api's P&L
rows by the invariant sweep (§10). Divergence alerts; it never self-corrects
silently. Bootstrap adoption, manual adoption, absorb passes, and the
delta-vs-absolute resize fold are all **deleted** — single ledger, full
identity on fills (§9).

---

## 5. The engine: merged algorithm and field schema

One engine, both code paths, every tier independently toggleable. Evaluation
order within a decision pass (preserved from Python where the ordering is
load-bearing):

1. Session gate (trading day, ≥ 09:20, before close).
2. **Expiry settle — before everything else, urgency execution** (§8): a
   contract past expiry leaves the master and can never be closed again.
3. Repair hold (skip the action pass entirely; marking/state continue).
4. Guard tier: hard target lock (mark-anchored confirmation streak, §7),
   crash protect, margin guard (wings, or trim — `no_buy` semantics are now
   engine constants for the recenter family).
5. Working-package hold — while tranches of a prior decision are being worked
   or a maker-quote rests, no **new playbook** action is formed; marking,
   greeks, and guard tiers keep evaluating, and guards may preempt (§8).
6. Scrap tier (price test on **bid**; delta test; per-expiry re-sell ban;
   protected quantity exempt at selection).
7. Playbook phases — the merged body:
   - **Phase S (shift, toggleable):** margin-fraction gate → ITM depth scan
     over unprotected short quantity → roll to `shift_land_steps` OTM →
     slot-merge → if `hedge_after_shift` is off, return with the shift alone.
   - **Phase R (recenter/shed):** corridor `allowed = |netΓ|·tol·spot`
     (with optional √dte shrink, band floor, anchor EMA, EOD sweep arming,
     trend-skew target); excess vs damping (§7); balance tier (toggleable);
     LIFO unwind of engine-added opposite legs (toggleable, gamma-floor
     bounded); shed-candidate scan, best-fit sizing off real greeks;
     recycle/credit bank (toggleable).
8. Sell gate (scrap-banned / sub-min-price / sub-min-delta sells stripped;
   all-sells decision degrades to hold; a roll degrades to its close).
9. Margin-cap projection (downsize/drop Sell opens net of the decision's own
   closes; closes and Buy opens always survive).
10. Deferred state commits scaled to surviving lots.

**Deleted Python semantics** (deliberate, not oversights): `cooldown_min`,
`no_buy`, `no_close`, `unwind_share`, `unwind_entry_book` (constants across
the family — hardcoded); the `netΓ == 0.0` missing-mark sentinel → explicit
`hasGreeks` flag; the `dps = 0.30` sizing fallback → we compute greeks for any
candidate strike, and a strike whose greeks cannot be computed is not a
candidate; absent-vs-zero dial semantics → one typed off-state per field;
the per-mark time throttle → fill-gated tranches (§8).

### Field schema (dials, stored in `desk-books-registry.dials` — unchanged storage, number|boolean only)

Sections marked ⏻ have a master toggle; their numeric fields are inert while
off. Defaults shown are the relief-r live preset.

| Section | Field | Type | Default | Notes |
|---|---|---|---|---|
| Corridor | `delta_tol_pct` | number | 0.02 | band width |
| | `delta_shorts_only` | bool | true | steering delta population |
| | `gamma_shorts_only` | bool | true | steering gamma population |
| | `tol_ref_dte` | int | 0 (off) | √dte band shrink |
| Shift ⏻ | `shift_enabled` | bool | true | phase S on/off |
| | `shift_itm_steps` | number | 0.5 | ITM depth trigger, in strike steps |
| | `shift_land_steps` | int | 2 | landing strike, steps OTM |
| | `shift_margin_frac` | number | 0.60 | **operator-chosen; 0 disables the gate, not shifting; an uncapped book (margin_cap 0) never shifts** — semantics preserved verbatim |
| | `hedge_after_shift` | bool | false | off = shift mark returns without phase R |
| Band floor | `min_band_lots` | number | 0 (off) | floor = lots × cheapest-candidate delta-shares |
| | `no_band_floor` | bool | false | free variant: no convexity floor at all |
| Shed | `shed_scan_strikes` | int | 3 | outward candidate scan, cap 3 |
| | `strikes_out` | int | 2 | recenter()-path sell-strike push |
| | `min_sell_dte` | int | 1 | no fresh sells at/under |
| | `min_sell_delta` | number | 0 (off) | sell gate floor |
| | `scrap_close_delta` | number | 0 (off) | delta scrap tier |
| Unwind ⏻ | `unwind_enabled` | bool | false | LIFO buy-back of engine-added opposite legs (gamma-floor bounded) |
| Recycle ⏻ | `recycle_frac` | number | 0 (off) | fraction of realized loss re-sold |
| | `recycle_bank` | bool | false | sub-lot credit accumulator |
| | `recycle_opposite` | bool | false | crossfill: recycle to the other side |
| EOD ⏻ | `eod_flat_min` | int | 0 (off) | minute-of-day; arms one tol=0 sweep |
| Trend ⏻ | `trend_enabled` | bool | false | |
| | `trend_skew` | number | 0.5 | shed-target skew when enabled |
| Anchor ⏻ | `anchor_ema_marks` | int | 0 (off) | gk-anchor EMA length |
| | `confirm_marks` | int | 0 (off) | anchor confirmation streak |
| Risk | `target_pnl` | number | 250000 | hard lock (flatten all) |
| | `margin_cap` | number | per-book | 0 = uncapped (disables shift + margin guard projection) |
| Execution | `work_tranche_lots` | int | 3 | lots per fill-gated tranche (§8) |
| | `chase_max_ms` | int | 30000 | passive peg deadline before crossing |
| | `chase_cross_buffer_pct` | number | 0.005 | buffer when escalating to a cross |
| | `rest_max_min` | int | 10 | maker-quote lifetime before cancel+re-evaluate |
| Tick | `confirm_ms` | int | 5000 | trigger must persist before ANY phase acts |
| | `cooldown_s` | int | 30 | post-action quiet period per book |

**Advanced** (engine defaults, surfaced collapsed in the UI, rarely touched):
`scrap_close_px` 0.10 · `min_sell_px` 0 (off) · `crash_delta` 0.60 ·
`target_confirm_marks` 3 · `lock_exclude_mark0` · `lock_executability` ·
`target_snap_multiple` · `lock_branch_lots` · `sell_max_spread_pct` 0.25 ·
`quote_max_age_ms` 120000 · `balance_min_dte` 7 · `balance_enabled` false ·
peg dwell/min-move (gateway env dials, §8).

### Presets

`packages/desk-engine/src/presets.ts` — the 12 historical variant dial-sets as
named constants (`recenter-relief-r` **live** — shorts-only toggles ON — is a
distinct preset from `recenter-relief-r (board)` with them OFF, because the
committed backtest boards were measured with them off), plus `pairshift-*`
noted as out of scope. A preset is a prefill, nothing more; the book row
records `preset: string` as a label. The `desk-variants` collection and its
publication die.

---

## 6. Pricing model — two-sided end to end

The engine context carries `Quote = {bid, ask, ltp, asOf}` per instrument.
Consumers by name:

| Consumer | Side | Replaces |
|---|---|---|
| IV solve + all greeks | **mid**; LTP only when one-sided, flagged | mid-or-LTP ambiguity |
| Forward `S` for Black-76 | future's **mid** | single future float |
| MTM, `total_pnl`, target lock | **exit side**: long→bid, short→ask | mid (overstated short profit) |
| Scrap price test | **bid** | one-sided ltp |
| Sell sizing / recycle premium | **bid** | mid |
| Passive order price | **the touch** (join, then peg — §8) | mid ± 2 % cross |
| Maker-quote price | **Black-76 theoretical** at our marked IV, tick-floored | n/a (new) |
| Strike candidacy | two-sided book, spread ≤ `sell_max_spread_pct`, age ≤ `quote_max_age_ms` | no liquidity gate |

**Valuation vs candidacy split (load-bearing):** *valuation* — MTM, the lock,
the corridor — always uses the **last-seen two-sided pair**, however old. The
feed pushes on depth change, so an un-updated pair means an unchanged book
while the feed is healthy; feed death is what `md.health` gates. A contract
whose book has *never* been seen holds the whole action pass. *Candidacy* —
what we would newly sell — is where the spread/age gate actually blocks; gate
failure routes to the maker-quote path (§8), never to a silent hold.

Greeks: Black-76, `r = 0.065`, calendar-day tenor refined intraday on expiry
day only — preserved from Python for comparability; `packages/greeks` already
implements price/greeks/IV. Both greek populations (leg greeks off marked IV;
strike greeks for sizing) come from the supervisor's ChainView; no strike-band
limit, no fallback constant.

Margin input is `{value, source: 'broker'|'model', asOf, fresh}`. The shift
gate (`shift_margin_frac`) **requires a fresh broker figure on two
consecutive reads**; on model-only or stale it holds the shift and surfaces
the reason (Python silently steered on SPAN-lite, which under-modeled BHEL
20.8L vs broker 42.9L). SPAN-lite is ported only as the labeled fallback for
display/projection.

`pricing: 'parity' | 'live'` engine mode: parity reproduces Python's
mid-or-LTP semantics for fixture verification only (§12); not settable from
the UI.

---

## 7. Tick-driven evaluation

- Supervisor connects `WsTransportClient` to the bus, filters `md.tick` for
  its books' tokens. Chain demand comes free for registry books
  (`DESK_FULL_CHAIN=1`); the supervisor also writes its own
  `desk-subscriptions` row (`source: 'desk-supervisor'`, complete token list,
  refreshed ≤ 15 s).
- Every relevant tick updates ChainView and marks; triggers evaluate
  continuously (incremental greek update for the ticked instrument, band
  arithmetic O(legs)).
- **Damping applies to every order-producing trigger** (D4/Q4a): phase S and
  phase R alike require the condition to persist `confirm_ms` (default 5 s) —
  or, for phase R, to exceed the band by ≥ 1 full lot-equivalent; the shift's
  margin gate additionally needs two consecutive fresh broker-margin reads.
  `cooldown_s` (default 30 s) per book after any routed decision. **One
  in-flight decision per book.**
- **The 5-minute mark grid survives for two things only:**
  1. Journaling cadence (`desk-book-marks` row per book per mark).
  2. **Target-lock confirmation.** The 3-consecutive-mark streak defeats
     gap-open phantom marks (TCS 2026-06-19: one 09:15 mark printed +17L on a
     book that was really −21L). Tick-persistence is not an equivalent
     defense; the lock stays mark-anchored with `lock_exclude_mark0`,
     `lock_executability`, `target_snap_multiple` intact.
- **Decision identity:** `decisionId = {tag}:{mode}:{seq}`, per-book monotonic
  `seq` in supervisor state, intent hash recorded in the ledger; desk-api
  enforces idempotency by unique index. On boot an `inFlight` decisionId is
  re-POSTed verbatim; the api answers with the recorded outcome or routes it.
  No mark-walking recovery — decisions are functions of *now*.
- **Dial propagation:** registry poll every 5 s **plus** a best-effort HTTP
  nudge from desk-api to `:8793` on every dial write and desired-state
  change. Nudge failure is harmless; the poll is the guarantee. `lot_size`
  refused by name; unknown keys logged loudly (F-29 lesson).

## 8. Execution — passive-first, chase, fill-gated tranches

**Intent.** The supervisor states *how* an order should be worked; the
gateway owns the working. Per-action contract fields: `limitPrice` and
`workMode: 'passive' | 'urgent'`. Playbook actions default **passive**;
guard-tier exits (target lock, crash, margin guard trims, expiry settle) are
**urgent**.

**Passive (the default):**
1. Place joined to the touch (sell at best ask, buy at best bid), tick-rounded.
2. The gateway's chaser — extended with a **peg mode** — re-pegs the order via
   **atomic XTS MODIFY** (never cancel+replace; the existing
   `adapter.modifyOrder` path) whenever the touch moves ≥ 1 tick, with a short
   dwell and a worst-case price bound. Quote source: unconditional `md.tick`
   subscription in the gateway (token → `{bid, ask, ts}`), stale quotes
   **pause** pegging — never guess.
3. After `chase_max_ms` unfilled: cross the spread with
   `chase_cross_buffer_pct` (well under the old 2 % marketable buffer).
4. Still unfilled: stop working, rest, alert (the existing working-order
   alert). Existing chaser scaffolding — single-flight, dwell, cancel-wins,
   exhaustion, `DESK_CHASE_DISABLED` — is reused as-is. Passive orders carry
   their own flag; the manual-box `resting: true` remains an absolute
   never-chase skip, unchanged.

**Urgent:** skip pegging; place crossed at `chase_cross_buffer_pct`
immediately; tranche size escalates to the freeze limit.

**Fill-gated tranches (D11):** a decision's actions are worked
`work_tranche_lots` at a time; the gateway places the next tranche only when
the previous reports terminal through the fill watcher (which already knows
per-tranche terminality). A rejected tranche **halts the package + alerts** —
never silently continues. The remaining package lives in
`workingPackage` (supervisor state) and survives restarts. The freeze-limit
split still applies within a tranche. `disclosedQuantity` is out of scope
until manually broker-tested (D11).

**Maker-quote path (no liquid candidate):** when no strike passes the
candidacy gate, the engine places its quote at **Black-76 theoretical**
(tick-floored), `workMode: 'passive'` with pegging disabled, and alerts.
Invalidation: cancel + re-evaluate when the underlying moves ≥ 1 strike step,
after `rest_max_min`, or whenever a guard tier wants the book — **guards
always preempt working orders** (cancel first, then act).

**Working-package hold:** while a package or maker-quote is working, no new
playbook action forms; marking, greeks, and guard tiers keep evaluating.

**Fill flow.** Paper: **same lifecycle as live** (D14) — the simulator already
supports modify + tick-driven crossing fills; paper orders rest/peg and fill
when the opposite touch crosses, with approximate prices. Live: gateway
FillWatcher → `desk-fills` → desk-api folds the book → nudges the supervisor
(`:8793`), which also polls its unresolved decision at 1 s until terminal.
A REFUSED (4xx) outcome is final: roll back that decision's rule-state deltas,
log at error, do not retry. Indeterminate retries the same decisionId only.

## 9. Contract & storage changes

**New:** `POST /v1/desk/engine/decisions` (desk-api), types in
`packages/desk-engine`:

```ts
Request {
  tag, mode, decisionId, symbol, expiry,
  trigger: 'shift'|'shed'|'scrap'|'lock'|'margin'|'expiry'|'eod'|'recycle'|'unwind'|'balance',
  reason: string,
  actions: Array<
    | { op: 'open',  instrument, side: 'Buy'|'Sell', qty, limitPrice?, workMode? }
    | { op: 'close', instrument, limitPrice?, workMode? }
    | { op: 'resize', instrument, targetQty /* absolute signed */, limitPrice?, workMode? }
  >,
}
Response {
  decisionId, replayed: boolean,
  status: 'DONE'|'FAILED'|'ROUTING'|'WORKING',
  fills: Array<{ instrument, side, qty, price, resting? }>,   // full identity
  skips: [...], routeErrors: [...],
  book: StoredBook,                                            // post-fold echo
}
```

- Legs are identified by **real instrument**; the `CE530#3` pseudo-symbol and
  the deskTag/tradingsymbol duality die. `desk_tag` provenance on order
  documents is kept for journal continuity, now carrying the decisionId.
- All five live gates evaluate this endpoint identically to the old one; gate
  code is reused, not rewritten.
- **Removed in this migration (D9):** `POST /v1/desk/actions`,
  `POST /v1/desk/variants`, the Python-shaped contract machinery and
  validation, `docs/PYTHON-DESK.md`. On prod: `pm2 delete desk-supervisor
  desk-supervisor-live`, both removed from sensibull-desk's
  `ecosystem.config.js`; `data/desk/` **tar-archived, then removed** (the
  only record of the Python engine's decision history — archive, never plain
  delete). **Kept:** every GET the dashboard uses, all historical Mongo data,
  sensibull-desk's sim/backtest/research stack.
- **New collections:** `desk-supervisor-state` (§4), `desk-engine-decisions`
  (decisionId unique, tag, mode, ts, trigger, reason, actions, status, fills,
  engine snapshot {netΔ, netΓ, band, spot, marginSource} — replaces
  `data/desk/*.jsonl`), `desk-supervisor-lease`, `desk-book-marks` (one row
  per book per 5-min mark; distinct from marketdata's `desk-marks`).
- `desk-books`, `desk-books-registry` (incl. `dials` storage, validation,
  re-auth, audit): **unchanged**. `bin/desk-reset.mjs` learns the new
  collections. Gateway order docs gain the passive-work fields (`workMode`,
  peg bookkeeping, `tickSize` actually written).

## 10. Lifecycle, restart, safety

- Boot: crash guards → Mongo → lease acquire → registry + state load →
  ChainView from `desk-marks` snapshot + instrument master → resolve
  `inFlight` → subscribe bus → evaluating within seconds.
- Stop: inert, always. Supervisor heartbeats into `desk-supervisor-lease`;
  desk-api surfaces a dead supervisor in the health strip (unwatched gap is
  visible).
- Gates before any action pass: session → expiry settle → repair hold → feed
  trustworthy → book present. All fail toward hold; every hold has a reason
  string in the ledger.
- **Broker-truth invariant sweep** (D5): positionsCompare feeds a per-book
  comparison of `desk-books` vs broker positions and `cumRealized` vs
  desk-api P&L; divergence **alerts** in the order feed. Auto-heal only
  behind the four-fence pattern, only if explicitly enabled later.
- **No automated loss stop (D13)** — operator monitors and intervenes
  manually. Known gaps carried knowingly: order-bus risk caps unwired (F-28,
  operator-declined), gateway does not read the kill switch (F-9, follow-up).
- Expiry settle ships in the weekend build (core safety), but is not
  launch-gating: books created at launch will be next-monthly expiries.
  Post-settle, the next month's book is **created manually** — no auto-roll.

## 11. Dashboard changes (`apps/web`)

- Books-page Dials modal → **section/toggle/input panel**: sections per §5 +
  Advanced (collapsed), preset picker prefilling fields, per-field indicator
  (preset default vs overridden), inline validation against the
  `packages/desk-engine` schema. Password re-auth for live books and
  `desk-audit` logging unchanged.
- Book-page leg rows gain the **Protect** control (quantity per instrument,
  §4).
- Book creation picks a preset from code; registry rows keep working;
  `variant` field becomes the `preset` label (read-compatible).
- Decision feed: `desk-engine-decisions` rendered on the book page (reason,
  trigger, fills, working-package progress) — replaces tailing Python jsonl.

## 12. Verification (the readiness gate)

1. **Engine parity — gates launch (D15):** extend `gen-parity-fixtures.py`
   with decision-level fixtures from the Python tests' synthetic context
   builder: all 12 preset dial-sets × a grid of (spot, netΔ, netΓ, dte, legs),
   as **mark sequences with state threaded** and `state_after` recorded. TS
   engine in `pricing: 'parity'` mode must match bit-for-bit. Transliterate
   the 224 Python test functions (recenter base/shift/relief-band/eod/eod3/
   reshift/scrap/unwind + protected legs + target lock).
2. **Contract tests:** endpoint idempotency/replay, gates, REFUSED-vs-
   indeterminate, fill folding, tranche gating, peg-mode behavior against the
   simulator — node:test with the `require-mongo` pattern; CI enforces.
3. **Restart drills (automated):** kill mid-decision → boot → in-flight
   resolved exactly once; kill mid-package → tranches resume; SIGTERM → zero
   orders emitted.
4. **Dry run:** synthetic tick feed (fabricated bid/ask walks + recorded
   chain shapes) on the real bus; paper books exercising shift, shed, scrap,
   lock, expiry settle, maker-quote, chase, and tranche gating end to end
   through the real api + gateway simulator.
5. Real-market ledger replay (the 299 committed recenter `decisions.jsonl`
   cycles + local GFDL lake) is **not** launch-gating — available later as
   regression fodder.

## 13. Build & launch

**Weekend build order** (detail in the implementation plan):
Saturday — `packages/desk-engine` (context/quote types, merged engine, guard
tiers) to parity-green on the shift family; contract endpoint; supervisor
skeleton (boot, lease, bus, ChainView, registry poll, decision loop).
Sunday — remaining tiers (unwind, recycle, EOD, trend, anchor, balance) +
their fixtures; gateway peg mode + fill-gated tranches; dials UI + presets +
Protect control; restart drills; dry run; removal list executed; deploy.

**Launch (any trading day, operator-initiated):** create book(s) from a
preset → run a **paper session first** (same lifecycle as live, D14) → flip
live via the existing password-gated allowlist switch when satisfied. No
calendar dependency; the readiness gate is §12 items 1–4 green.

## 14. Out of scope

- `pairshift-*` variants (different function; revisit on demand).
- `disclosedQuantity` iceberg orders — until manually broker-tested (D11).
- Paper fill-quality realism beyond touch-crossing (queue position, partial
  probability models).
- Auto-roll into the next expiry after settle.
- Real-market ledger-replay parity (post-launch regression tool).
- marketdata and desk-runner changes; research desk; backtest boards.
- `packages/payoff` remains the dashboard's what-if/repair analysis engine;
  unifying it with `desk-engine` trigger logic is a post-migration cleanup.
- Wiring order-bus risk caps (F-28 — operator-declined for now) and gateway
  kill-switch reads (F-9) — recorded follow-ups.
