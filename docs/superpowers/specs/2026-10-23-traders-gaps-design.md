# Traders gaps: settlement, booked P&L, daily record, MTM labels, 15:40 + alerts

The operator approved this on 23 Oct 2026 ("yes build 1–4, 5-yes"). It acts on the Fable gap review of 22 Oct, top 5.
The lanes are listed below. The integration branch is `feat/traders-gaps`, and the shared stub is
`apps/traders/src/ingest/settlement.ts`.

## Rulings (the main session's; lanes do not re-decide these)

**G1. Settlement is derived, never stored.**
- Synthetic settlement fills are made at read time from NSE history (`data/nse/history/<day>.json`, field
  `symbols[STOCK].c`: the CM close for stocks, the index close for indices, which is the final settlement price). They
  are folded into the ledger walk wherever the walk runs: legs, series, booked.
- Nothing is written to `traders-trades`.
- The backfill is a recompute: on boot, and after a new history day appears, the server reruns `legs.replaceOdin` for
  every trader.
- The agent never writes to prod Mongo itself.

**G2. Settlement rule.** A non-share contract settles when its net qty is non-zero at the end of its expiry day and that
day's history close S exists. The synthetic fills:
- *Option:* one fill closing q at its intrinsic value (CE max(0, S−K), PE max(0, K−S)).
- *Future:* one fill closing q at S.
- *Delivery (physical settlement):* if the underlying is a stock rather than an index, and the option ended ITM or the
  contract is a future, add one `share` fill at S.
  - Delivered shares: long CE or short PE gives +q×sign shares; long PE or short CE gives −; a future gives +q.
  - The share fill uses the same leg key as ODIN equity trades
    (`clientCode|share|STOCK|||`, expiry '', strike null, optType null).
  - It therefore nets with later cash-market sells.
- Every ITM stock option is treated as exercised. Do-not-exercise is not modelled; say so in the note.
- Settlement fills carry **no charges** (exercise STT and delivery stamp duty are not modelled; say so).
- Fill timing: dated on the expiry day, after every real trade of that day.
- If S is missing (no history file, or the symbol is absent, e.g. TATAMOTORS after the demerger), the leg stays open
  and is reported as *unsettled*, with its reason.
- 534 expired legs are open today (expiries 2025-07-31 … 2026-09-29). History starts 2025-10-01, so the earlier ones
  stay unsettled until the operator backfills further.

**G3. Booked P&L horizon.**
- A *series* is (trader, stock, expiry) across client codes, as in series-pnl.ts.
- booked = Σ −v of cycles flat at a day's end, settlement included.
- charges = `chargesFor` over the series' real fills.
- net = booked − charges for a closed series. An open series adds its open MTM, so it equals Series P&L.
- Every figure counts only from the ledger's history start (balance day or `historyFrom`), and the page says so.

**G4. The daily record is written once per trading day, at 15:45 IST**, from the same functions the page uses.
- It is idempotent, keyed (trader, stock, day). If the server was down at 15:45, it is written on boot or on the next
  tick that same evening.
- Rows are kept forever.
- Nothing is backfilled for past days: they have no live prices. Say so.

**G5. MTM block = a day view only.**
- The total is "Day MTM" = gross previous (prev close → LTP on carried qty) + gross today − charges of TODAY's fills.
- Previous-cycle charges leave the day total. They show in the series block as "Charges (series)".
- Before the session opens (before 09:15 IST, or on a closed day), the day figures are "—", never a number built from
  yesterday's last tick.
- Labels: "Day MTM" (block, strip), "Open P&L" (Σ GrossMTM of open legs vs net price), "Series P&L" (net of the series).
- Never fall back from one definition to another under the same label.

**G6. 15:40 is the expiry instant; order windows do not grow.**
- The instant an F&O contract expires and stops being valued becomes 15:40 IST everywhere, on the live desk too:
  - the greeks `yearsToExpiry` and its copies (payoff `CLOSE_MS`, api);
  - desk-engine `SESSION_CLOSE_MIN` where it means expiry, settle, the marking clock or theta session minutes;
  - traders `near-expiry` and `engine-book`.
- Anything that lets the live desk or its strategies PLACE orders between 15:30 and 15:40 when it could not before stays
  at 15:30, behind a named constant that says why: the cash spot is the closing auction's from 15:15, and extending
  order windows is a separate decision.
- core `MARKET_CLOSE_MIN` (strategy-kit's market-closed check, the runner's day end) stays 930 for that reason. Core
  gains `FNO_CLOSE_MIN = 940`, the one source for 15:40, and traders `calendar.ts` reads it.
- Fixtures that encode 15:30 (desk-engine parity, Python `scripts/gen-decision-fixtures.py`) are regenerated with the
  same change, and every changed expectation is listed in the lane report.
- **As built (lane E1, 23 Oct):** every desk-engine clock that feeds a live decision stays at 930, under
  `DECISIONS_END_MIN` and `DECISION_CLOCK_CLOSE_MIN`. That covers:
  - the expiry-day settle and the session gate;
  - the mark grid;
  - `marking.yearFrac`;
  - the supervisor's trading minutes to expiry;
  - the playbook's `Dday` and session length.

  So the live desk's behaviour is unchanged, and no parity fixture changed.
- **What moves to 15:40:** the greeks `yearsToExpiry`, payoff `CLOSE_MS`, the api P&L snapshot window, and the traders
  app.
- **Accepted consequence:** on expiry day, desk-api's displayed greeks (Positions, payoff, repair) price to 15:40 while
  the engine prices to 15:30, so the two deltas for one book differ near the close. Repair orders are applied by hand
  from the api's figures.
- The delta-based strike selector (marketdata-core `selector.ts`) also reads `yearsToExpiry`, but no strategy calls it.

**G7. Out-of-page alerts use Web Push** (RFC 8291, encrypted end to end, no third-party account). The `web-push`
library is pinned exact.
- VAPID keys are generated by the server on first use and stored in `traders-settings {kind:'vapid'}`, so there is no
  operator secret.
- The service worker lives under `/traders/`. iPhone needs Add to Home Screen; a manifest is required.
- Alert kinds:
  - expiring ITM (expiry day from 14:30 IST, physical delivery estimate);
  - order rejected;
  - watcher offline (more than 10 min without a heartbeat between 09:00 and 15:45 on a trading day);
  - band breach (the existing `traders-events` out).
- Every alert is stored in `traders-alerts` with a dedupe key and also appears in the bell.
- Payload text carries stock, strike, qty and ₹. It never carries client codes or names.
- A trader gets their own alerts. The admin gets watcher-offline and rejections for everyone.

**G8. Privacy and ops (standing).**
- No client codes in any output, log or push.
- No prod Mongo writes by agents.
- No probing of external hosts.
- `pm2` restarts are the operator's.
- No `merge=union` on .ts files.
- Traders suites run with `TRADERS_TEST_LANE=<lane>`. Only lane E1 runs the api suites.

## Lanes

| Lane | Item | Owns (new files are free; shared lists are merged by the main session) |
|---|---|---|
| S | 1 settlement | `ingest/settlement.ts` (fill the stub), `ingest/ledger.ts`, `ingest/ledger-store.ts`, history price adapter, boot/daily recompute in `app.ts`, book-view expired/unsettled warning |
| B | 2 booked | new `analytics/booked.ts`, `analytics/booked-wire.ts`, `routes/booked.ts`, `series-pnl.ts` (fold settlement fills in), web `booked.tsx` + nav entry, admin roll-up |
| D | 3 daily + data status | new `analytics/daily.ts`, `analytics/daily-wire.ts`, `routes/daily.ts`, a data-status route + admin panel, web `daily.tsx` |
| M | 4 MTM labels | `analytics/mtm.ts`, web `book-strip.tsx`, the MTM block component, `series-lines.ts` |
| E1 | 5a 15:40 | packages core, greeks, payoff, desk-engine, apps api, supervisor, runner (read), traders `calendar.ts`, `near-expiry.ts`, `advice.ts`, `engine-book.ts` |
| E2 | 5b alerts | new `apps/traders/src/alerts/*`, `routes/push.ts`, web `sw.js`, manifest, settings toggle, bell feed |

Shared list files (`routes/endpoints.ts`, `deps.ts`, `app.ts` wiring, `db.ts` collections and indexes, web `pages.tsx`,
`api.ts`) each get a small, append-only edit per lane. Merge conflicts in them are resolved by the main session.

## Contract: settlement (stub on `feat/traders-gaps`)

```ts
// apps/traders/src/ingest/settlement.ts
/** Final settlement price of `stock` on `day` (IST), from NSE history; null = not known. */
export type SettlementPrice = (stock: string, day: string) => number | null
/** true = cash-settled index; false = a stock (physically settled). */
export type IsIndex = (stock: string) => boolean

export interface SettlementFill extends LedgerTrade { readonly settlement: true }
export interface Unsettled { readonly key: string; readonly stock: string; readonly expiry: string; readonly qty: number; readonly reason: string }
export interface Settlement { readonly fills: readonly SettlementFill[]; readonly unsettled: readonly Unsettled[] }

/** Fills that settle every contract still open at the end of its expiry day, for expiries before `today`
 *  (and `today` itself once its history close exists). Pure. */
export function settlementOf(balance: OpeningBalance | null, trades: readonly LedgerTrade[], today: string,
  price: SettlementPrice, isIndex: IsIndex): Settlement
```

Every walk (legs, series, booked) uses `[...trades, ...settlement.fills]`. `ledgerWalk` orders a fill after the real
trades of its day.

## Hand-over (operator)

1. **Restart after the close only:** desk-api and desk-traders. G6 changes desk-api's displayed valuation, not the
   engine's. desk-runner, desk-supervisor, desk-gateway and desk-marketdata load identical values and need nothing.
2. **Optional:** run `span_job.py --backfill-history 320` to cover the expiries back to Jul 2025, so the older legs can
   settle.
3. **Phones:** open the traders page, choose "Phone alerts → On", and on iPhone Add to Home Screen first.
