# StrategyBase and the generic runner — Design Spec

**Date:** 2026-07-27
**Status:** approved in brainstorming, not yet implemented

## 1. Purpose

Give intraday strategies one host and one set of ports, so that adding or changing a strategy
never means touching the runner. Strategy logic lives in strategy files and is expected to change
often; the base and the runner are infrastructure and should not.

The design is not invented. `context/strategy-specs/modern.md` §2 is a 20-row table titled
"Canonical anatomy (**the thing `StrategyBase` must generalise**)", derived from the four working
modern engines. This spec assigns each row an owner.

## 2. The split

### The base owns (never rewritten per strategy)

| Anatomy row | Becomes |
|---|---|
| 5, 6 — `zerodha_init()`, `ticker()`, subscribe | the injected `md` port; a strategy never constructs a socket |
| 7 — `istMinutes()` | the `clock` port |
| 8 — idempotent `runStrategy()`, resets `started` on error so a retry can happen | `start()` |
| 9 — phase fns, ready-flag guarded, self-retrying via `setTimeout(fn, 30000)` | job scheduler + retry |
| 10 — `checkTicks` merge, then a synchronous exit check | tick fan-in |
| 12 — `async.queue(fn, 1)` around `historyData` | serialised evaluation |
| 16 — `status = 'CLOSING'` set **before any `await`** | re-entrancy guard |
| 18, 19 — cron block; `bootstrap()` catch-up inside 09:00–15:30 | lifecycle + restart catch-up |
| 20 — echo the effective config on start | automatic |

### The strategy file owns

The rule (row 1), hardcoded config constants (row 3), its own state (row 4), what to evaluate
(row 11), instrument selection (row 13), entry (row 14) and exit (row 15) decisions. Decision
functions live in a pure `*-logic` module so they stay unit-testable without a feed.

**Strategy parameters are hardcoded in the strategy file and are not editable from the UI.** A
threshold is a code change that can be reviewed and golden-tested; a database edit is not.

## 3. The contract

```ts
config        // hardcoded constants, exported so the base can echo them on start
dataNeeds()   // ticks / candles(interval) / option-chain / futures
jobs()        // [{ name, cron, catchUpFrom?, replayable, run }]
onTick()      // pushed; call the exit check synchronously
onCandle()    // pushed when a declared series completes a bar
onRecover()   // rebuild in-memory state from the StateStore after a restart
```

### Jobs use cron expressions

`phases()` today takes `atIstMinute` — whole minutes only — and the real schedules are 6-field
with seconds and repeats:

```
20 15 10 * * 1-5     10:15:20   band width
10 */5 9-13 * * 1-5  every 5 min at :10 past, 09:00–13:55   poller
0 31 13 * * 1-5      13:31:00   entry deadline
```

Neither is expressible today. This is also why `cheetah-b1-snx`'s 3s-vs-10s bootstrap difference
could not be ported (logged as M2 during Phase C). Jobs take cron expressions.

**Deadline jobs must fire after the last poller tick** (13:30:10 poller, then 13:31:00 deadline),
so the final scheduled check is still allowed to trade. This ordering is deliberate in all four
engines and must be preserved.

### Jobs may request a retry

Anatomy row 9 is explicit: a phase that finds missing data retries in 30 seconds — the live log
line is *"not enough hourly candles for ATR, retrying in 30s"*. A job returns `{ retry: true }`
and the base reschedules. Without it, one slow instrument feed means the band never forms and the
strategy silently does nothing all day.

### Restart catch-up

`catchUpFrom` replaces the hand-written `bootstrap()` thresholds (09:21 → `computeLines`,
10:15 → `computeWidth`, 14:15 → `entryClosed`). Jobs that place orders are marked
`replayable: false` and are **re-derived from recovered state, never replayed** — replaying an
entry after a restart duplicates the position.

## 4. Market data wrapper

One object for live and historical data, so a strategy never touches a socket or a REST call.

```ts
ctx.md.quote(token)                     // last tick — the old ticksCache[token]
ctx.md.candles(token, interval, count)  // completed bars — the old historyData()
ctx.md.selectOption(underlying, expiry, criteria)
ctx.md.future(underlying) / atmStrike() / spotToken()
```

### Push vs pull

**Ticks are pushed** (`onTick`), because exit checks run synchronously off them and latency
matters. **Everything else is pulled**, at the strategy's own decision points — which is exactly
what the old files did: `checkTicks()` was pushed by the socket, `historyData()` was pulled inside
the 5-minute poller.

### Candles: shared, cached, warm

`CandleStore` is keyed by `(token, interval)` and refcounted by the strategies that declare it.
Ten strategies wanting BHEL 5-minute share one series — the same dedup principle as
`SubscriptionRegistry`.

- Seeded once from history on start, then advanced by the tick stream.
- **Aggregated once per tick per series, not once per reader** — otherwise a bar advances N times
  and every OHLC is wrong.
- **Returns an immutable slice.** Handing out the internal array lets one strategy's `.pop()`
  silently corrupt what every other strategy reads — a bug that would present as a strategy defect,
  not a cache defect.
- **Only completed bars.** Strategies read `candles[candles.length - 1]` as the last *closed* bar;
  a forming bar leaking in makes every breakout check fire early.

A declared series is warm, so the pull is a memory read. That matters: anatomy row 12's
`async.queue(fn, 1)` exists *only* because the pull was a slow network call that could overlap the
next poller tick. Warm series removes that race by construction rather than serialising around it.
Undeclared series still work via ad-hoc pull; they are simply slower.

### Multiple timeframes per strategy

`atr-band-nifty` needs 60-minute (ATR width at 10:15) and 5-minute (anchor at 11:40)
simultaneously. Collapsing them is the port defect still sitting in the `{ todo }` golden test, so
the model supports several intervals per strategy from the start.

```js
dataNeeds() {
  return [
    { kind: 'index', underlying: 'NIFTY' },
    { kind: 'candles', underlying: 'NIFTY', interval: CONFIG.bandInterval },   // 60minute
    { kind: 'candles', underlying: 'NIFTY', interval: CONFIG.anchorInterval }, // 5minute
    { kind: 'option-chain', underlying: 'NIFTY', strikeWindow: 3 },
  ]
}
```

### Instrument selection

```ts
selectOption(u, expiry, { by: 'atm' })                          // nearest LISTED strike
selectOption(u, expiry, { by: 'offset', steps: +2, type })      // N strikes on the listed grid
selectOption(u, expiry, { by: 'delta', target: 0.30, type })    // closest |delta|
selectOption(u, expiry, { by: 'premium', target: 50, type })    // closest premium
```

Always walks the **listed grid**, never an arithmetic one: BHEL's real step is 2.5, and
`round(spot/5)*5` yields strikes that do not exist. Returns `null` when nothing qualifies — no
listed strike, or no mark for delta selection.

That null is the point. This replaces `otmSelector`, whose documented defect was returning `0` at
**87 of 93 call sites**, so strategies labelled "OTM sellers" were in fact trading ATM. Returning a
plausible answer instead of admitting it cannot answer is the failure being designed out.

Delta selection needs no new data source: the full chain is already subscribed and
`packages/greeks` computes per-leg delta from marks.

## 5. Order placement

Hosted strategies POST to the bridge, exactly as the Python desk does — they do not get a private
route.

```
/v1/desk/actions   book-shaped (open/close/roll/resize)   external Python desk
/v1/desk/submit    one order (instrument, side, lots)     hosted intraday strategies
        └────────── same gates → same journal → same gateway ──────────┘
```

`/submit` is new. Intraday strategies own their positions internally, so a book-shaped API is the
wrong shape for them. Both paths pass the strategy switch, kill switch, live allowlist and freeze
split, and both journal to `desk-order-events`. Hosted and external strategies therefore differ
only in who runs the process.

## 6. Error handling

- One strategy throwing must never affect its neighbours — the existing per-strategy guard.
- A failed `start()` resets so a retry can happen (row 8).
- A job that cannot get its data retries rather than failing the day (row 9).
- Feed staleness blocks **new exposure only**; exits are never blocked, because trapping a position
  is worse than the stale feed.
- Order flags flip only **after** a successful submit (row 14), so a failed order leaves the
  opportunity available rather than silently burning it.

## 7. Testing

- Job scheduling: cron firing, deadline-after-poller ordering, retry-on-missing-data.
- Restart: catch-up replays only `replayable` jobs; an open position is recovered from state.
- CandleStore: shared readers see one series; a bar advances once per tick; returned slices are
  immutable; only completed bars are served.
- Selector: listed-grid walking, delta/premium selection, `null` rather than an ATM fallback.
- Strategy classes themselves keep their existing golden-master coverage against the archived
  originals in `archive/server/slive/`.

## 8. Out of scope

Editing strategy parameters from the UI. Backtesting (declined 2026-07-25). Supervising external
Python processes — SMPv2 gates whether their orders are accepted, it does not start them.
