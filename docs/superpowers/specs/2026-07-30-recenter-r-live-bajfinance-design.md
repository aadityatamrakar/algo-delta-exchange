# recenter-r on a live BAJFINANCE book — design

**Date:** 2026-07-30
**Target session:** 2026-07-31 (Friday)
**Repos:** `algomaker` (bridge, registry, book) and `algo-engine/sensibull-desk` (supervisor, driver, playbook)

## Goal

Run the `recenter-r` delta-management variant against a BAJFINANCE 2026-08-25
paper book, managed by the `desk-supervisor` process on prod, starting with the
2026-07-31 session.

**STATUS: executed 2026-07-30 evening. All four steps below are done and
verified on prod.** See "Execution log".

An earlier draft of this spec claimed this was the first-ever run of
`desk-supervisor`, on the strength of the wave-4 report's closing note ("did not
start it under pm2, did not point it at the production bridge"). **That was
false.** The supervisor has been running under pm2 on prod since 2026-07-28.
The wave-4 report described the state at the end of that task, not the state of
the world, and this spec trusted it instead of checking.

## Decisions

| | |
|---|---|
| Mode | `paper` |
| Expiry | 2026-08-25 (Aug monthly) |
| `margin_cap` | ₹50,00,000 |
| `target_pnl` | ₹60,000 |
| Where it runs | prod `3.108.231.230`, under pm2 |
| When | seed + start tonight with `desired: 'stopped'`; flip to `running` on 2026-07-31 |

## The book

From the operator's sheet, CMP 1050. Lot size **750** (`config/lot_sizes.json:4`),
so ±3000 is 4 lots a leg.

| Option | Strike | Rate | Qty |
|---|---|---|---|
| CE | 1070 | 28 | −3000 |
| PE | 1030 | 26 | −3000 |
| CE | 1150 | 7 | +3000 |
| PE | 960 | 7 | +3000 |

Sell premium ₹1,62,000; wings cost ₹42,000; **net credit ₹1,20,000**.

## What needs no work

`recenter-r` requires **no supervisor change to be runnable**:

- It is already `{"decider": "rule-engine", "playbook": "recenter", ...}`
  (`sim/variants.py:348`), so `publish_catalogue()`'s `decider == "rule-engine"`
  filter already includes it.
- `build_decider` maps rule-engine → `RuleEngine(playbook=...)` generically
  (`variants.py:594`). Nothing under `sensibull_tools/live/` names a variant.
- `translate.to_actions` is generic over the sim `Decision` shape, and
  `recenter` is **sell-only** — it emits `open_legs` and never `close_ids` or
  `close_parts`, the simplest case the live path has.
- Being stateless (no anchor, `cooldown_min 0`) it also sidesteps the driver's
  known whole-`rule_state` rollback caveat, which only over-reverts a decider
  proposing several independent legs per decision.

## 1. Code change — the dials contract

`_default_worker_factory` (`sensibull_tools/live/desk/supervisor.py:232`) wires
`dials.margin_cap` through to `BookDriver` (line 243) but **never wires
`dials.target_pnl` anywhere**. The sim injects it into the decider's params
before building it:

```python
# sim/runner.py:230-231
if target_pnl is not None and cfg.get("decider") in ("hybrid", "rule-engine"):
    cfg["params"] = {**(cfg.get("params") or {}), "target_pnl": float(target_pnl)}
```

The live factory calls `build_decider(cfg)` on the bare config, so `RuleEngine`
gets `params=None` and the target lock — which reads `self._p`
(`sim/rules/engine.py:98-117`) — never arms. Per `recenter-r`'s own definition,
*"the scrap rule, the target lock and expiry are the only exits"*, so with the
lock disarmed **the book has no profit exit at all** and runs to expiry
whatever it makes.

The fix, in `_default_worker_factory` before `build_decider`:

```python
cfg = get_variant(variant)
dials = row.get("dials") or {}
target_pnl = dials.get("target_pnl", cfg.get("default_target_pnl"))
if isinstance(target_pnl, (int, float)) and not isinstance(target_pnl, bool):
    cfg["params"] = {**(cfg.get("params") or {}), "target_pnl": float(target_pnl)}
decider = build_decider(cfg)
```

Two properties this must preserve:

- **No cross-book leakage.** `get_variant` returns `dict(cfg)` — a *shallow*
  copy (`variants.py:565`). Rebinding `cfg["params"]` to a freshly built dict is
  safe; writing `cfg["params"]["target_pnl"] = x` would mutate the registry's
  own nested dict and leak one book's target into every other book on that
  variant, silently, in a long-lived supervisor process.
- **Same resolution order as `margin_cap`** — dials first, variant default
  second — so the two dials behave alike.

The `bool` exclusion matches `_catalogue_defaults_of` (line 144), which already
guards it: `isinstance(True, int)` is `True` in Python.

## 2. The book — two records

The registry row and the leg-level book are deliberately distinct
(`books-registry.ts`: the registry holds what a book *is*; `store.ts`'s
`saveBook` holds what it *holds*). Both are needed.

`seeds/BAJFINANCE-2026-08-25-recenter-r.json`, following
`seeds/BHEL-2026-08-25-hold-recycle-r.json`:

```json
{
  "tag": "BAJFINANCE-2026-08-25-recenter-r",
  "symbol": "BAJFINANCE",
  "expiry": "2026-08-25",
  "mode": "paper",
  "legs": [
    { "strike": 1070, "type": "CE", "qty": -3000, "rate": 28 },
    { "strike": 1030, "type": "PE", "qty": -3000, "rate": 26 },
    { "strike": 1150, "type": "CE", "qty":  3000, "rate":  7 },
    { "strike":  960, "type": "PE", "qty":  3000, "rate":  7 }
  ]
}
```

Registry row: same `tag`/`symbol`/`expiry`/`mode`, `variant: "recenter-r"`,
`dials: { lot_size: 750, target_pnl: 60000, margin_cap: 5000000 }`,
`desired: "stopped"`.

`desired` starts stopped whatever is requested — creating a book is never itself
a trading permission. Registering the tag also creates its `desk-strategies`
row; without that the book's first decision 403s on `UnknownStrategy`.

**recenter never opens the initial position.** These four legs are seeded as an
already-held position; the playbook only manages delta from there. In paper the
sheet's rates are taken as the fills.

## 3. Deployment

**sensibull-desk** (`/home/ubuntu/sensibull-desk`, confirmed present on prod):
pull, apply the §1 fix, ensure `.env` carries `DESK_API_URL=http://127.0.0.1:8790`,
`DESK_API_TOKEN`, `DESK_SUPERVISOR_MODE=paper`, then
`pm2 start ecosystem.config.js --only desk-supervisor`.

`desk-supervisor` is `autorestart: true` with no `cron_restart`, because it
holds per-book worker state in memory between marks. That is safe here:
SIGTERM/SIGINT stop the converge loop **without closing or squaring off
anything**, unlike the TypeScript `desk-runner`, which flattens the book on
SIGTERM. A pm2 restart of the supervisor is a no-op for every book it manages.

**algomaker**: a deploy is needed only if prod's checkout predates the registry
(`4948293b`). Prod tracks `overhaul/foundation`, the same branch this work sits
on. See open items.

## 4. Data flow

`converge()` polls every 30s (independent of, and much shorter than, the mark
grid). For a `desired: 'running'` row it builds one `BookDriver`, which ticks on
the **5-minute IST grid**:

```
BridgeStore marks off /v1/desk/chain
  → build_chain → ctx
  → RuleEngine(playbook="recenter").decide
  → translate.to_actions        (open_legs only — recenter never closes)
  → POST /v1/desk/actions
  → apply_fills → save state/ledger/mark
  → bridge.declare
  → set_actual back to the registry
```

## 5. Failure handling

All pre-existing; nothing new is required.

- Fail-soft per row, per worker build, per tick — logged and skipped, never
  raised out of `converge`.
- Pidfile (`DESK_SUPERVISOR_PIDFILE`) refuses a second supervisor instance; two
  converging one registry would double every action.
- The legacy guard refuses any book whose `(symbol, variant)` already has a
  state file under the old `sensibull-live` root (`data/live/`).
- The margin throttle binds at ₹50L.

## 6. Testing and gates

**Unit** — on the §1 injection: `dials.target_pnl` reaches `RuleEngine._p`; the
fallback to `default_target_pnl` holds when dials omit it; a non-numeric or
boolean value is ignored; and `_REGISTRY` is unmutated after building two books
on one variant with different targets.

**Tonight's smoke run**, row at `desired: 'stopped'` — this exercises the poll
loop, the catalogue publish and the `actual` handshake while placing zero
actions, because `converge` only builds workers for rows that are `running`.
Assert: the catalogue posts and contains `recenter-r`; the registry is polled;
`POST /v1/desk/actions` appears **zero** times in the log.

**Gates before flipping to `running`:**

1. No BAJFINANCE entry under `~/sensibull-desk/data/live/` (else converge
   silently refuses the book).
2. The BAJFINANCE 2026-08-25 chain is subscribed and serving live quotes — this
   is the first book on that contract, so it is a first-time subscription.
3. No lot-size disagreement warning. The bridge's exchange dump is authoritative
   and wins loudly over `dials.lot_size`; both should say 750.

## Expectations

Mostly `hold`. The 1070CE/1030PE shorts straddle the 1050 spot near
symmetrically, so netΔ starts near zero, and recenter fires only when drift
pushes `|netΔ|` past `|netΓ| × 2% × spot`. The sim's very first mark decided
*"recenter: netΔ -1100 inside allowed 1,250 (|netΓ| 70.2 × 2% × spot 891.0)"*.
Sells, when they come, land 2 strikes OTM on the delta-reducing side.

**This pairing lost money in the backtest.** `data_sim_runs/BAJFINANCE/2026-06-30/recenter-r/`
— a larger book (₹3.60L sell premium, ₹15.4L entry margin, 28 DTE at entry) over
20 days:

| | |
|---|---|
| net P&L | −₹4,86,712 |
| max DD | ₹4,97,362 |
| peak margin | ₹2.11cr (≈14× entry margin) |
| avg margin | ₹67.7L |
| throttled marks | 12 of 1520 |

Scaled by premium (0.45×) that is roughly −₹2.2L on a book collecting ₹1.2L.
The scaling is crude — margin is not linear in premium, and a clean 4-leg condor
is not the sim's laddered book — but the order of magnitude stands. The ₹50L cap
is what keeps the margin path from repeating: the sim ran at the ₹10cr default,
which on a book this size is effectively uncapped.

**The value of this run is watching the live path behave, not the P&L.**

## Execution log — 2026-07-30

Access is `ssh -i ~/Documents/dev/aws_keys/wealthcreator.pem ubuntu@3.108.231.230`
(the key is in the Makefile as `SSH_KEY`; there is no `~/.ssh/config` entry).

**Prod facts, corrected.** The Python repo is `/home/ubuntu/sensibull_tools`
(underscore), not `sensibull-desk`. Prod's algomaker was already at
`b32d9b25`, the branch tip, so no algomaker deploy was needed. `data/live/`
does not exist, so the legacy double-management guard was never a risk.
`sensibull-desk.service` is the research dashboard, unrelated to the supervisor.

**1. The catalogue was stale — the real blocker.** `publish_catalogue()` runs
ONCE, at startup. The supervisor had been up since 2026-07-28; `recenter-r` was
authored on 2026-07-29. So the published catalogue held 19 variants and
`recenter-r` was not among them, while `variants.py` on disk had it all along.
The spec's "recenter-r needs no work" was true of the code and false of the
running process. Restarting republished 26 variants including the whole
recenter family and `counter-r`.

**FIXED the same evening** (`dd4974f`): `run()` now owns the cadence and
republishes every `DESK_SUPERVISOR_CATALOGUE_SEC` (default 300), so a variant
added while the process is up reaches the bridge without a restart. The
republish is unconditional rather than diffed against the last post — a memo of
"what I last sent" would stop the catalogue self-healing if anything else ever
clobbered the collection. `publish_catalogue()` now reports success so a failed
post retries on the next 30s tick instead of costing a full interval. Verified
end-to-end against a real `Supervisor` (26 → 27 variants picked up mid-run) and
on prod.

**2. BAJFINANCE was absent from the instrument master.** `DESK_UNIVERSE` was
unset on prod, so `marketdata/src/main.ts:147` fell back to
`'NIFTY,BANKNIFTY,SENSEX,BHEL'` and `planSync` dropped every other name
(`instrument-sync.ts:103`). Set to the 3 indices plus all 13 backtested symbols
in `/opt/algomaker-delta/.env.local` (backup `.env.local.bak-20260730-105222`), then
forced a sync via the exported `runSync` — the daily job only fires at 08:45 IST
and a boot after 08:45 marks the day already done (`main.ts:223`), so an evening
restart alone would not have synced. Result: 107,496 dump rows → 6,884 upserts,
**all 16 names matched**, BAJFINANCE at 142 contracts with expiries
`["2026-08-25","2026-09-29","2026-10-27"]` and `lotSize: 750`.

**Latent issue found, not blocking.** The sync matches on the dump's `name`
column, which for equities is the COMPANY name — BAJFINANCE's EQ row is
`name="BAJAJ FINANCE"`, so it was dropped. 10 of the 13 stocks now have no cash
spot row; BHEL, ITC and DLF survived only because their company name equals
their symbol. This does **not** break the desk: `store.py`'s `spot_ref` returns
the FUTURE close and never cash spot ("Returning cash spot here would price
every option off a different forward than the backtest"), and greeks invert IV
off the future too. `planSubscriptions` reports a missing spot in `missingSpot`
but still subscribes options and the future. The visible cost is a null cash
spot on the dashboard for those symbols.

**3. `target_pnl` fix shipped.** `_cfg_with_target_pnl` added, TDD, committed as
`04dfb59` in sensibull_tools. Local suite 2,405 passed / 0 failed / 5 skipped;
the file was copied to prod (md5 `5fe7964c…` identical both sides) and its 24
tests re-run green there before restarting the supervisor.

**4. Book created.** Seeded via
`node apps/api/src/cli.ts seed --file seeds/BAJFINANCE-2026-08-25-recenter-r.json`
(4 legs resolved to real contracts), and the registry row POSTed with
`dials: {lot_size: 750, target_pnl: 60000, margin_cap: 5000000}`,
`desired: "stopped"`.

**Smoke test passed:** with the row at `desired: 'stopped'`, the supervisor
polled it and started nothing — `actual` stayed `stopped`, zero actions placed.

### Correction to §2 of this spec

`BookRow` has **no `seedLegs` field** (`books-registry.ts:41-60`). The
supervisor's `_row_lot_size_of` fallback that reads
`row["seedLegs"][0]["lot_size"]` is therefore dead against this registry;
`dials.lot_size` is the only row-derived source, and the bridge's exchange value
(750, confirmed) outranks it anyway.

## Remaining before the session

1. Flip the row to `desired: 'running'` via `POST .../:tag/start`.
2. Confirm the BAJFINANCE Aug-25 chain is serving live quotes once the feed is
   up — it is the first book on that contract.
