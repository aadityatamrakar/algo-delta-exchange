# Reports order log — one row per order, read as the book's day

Date: 2026-10-05. Operator: "in reports when we open order log for any
particular day it is noisy and messy, can you clean up and make it simple easy
to understand, spec and implement."

## Why (what was noisy, verified read-only against `desk-order-events`)

The Reports page opens a day's log for ONE tag and rendered the journal as
written: one row per PHASE, columns `Time · Phase · Contract · Detail`.

- **Seven rows per leg.** A paper engine order journals PLANNED, SUBMITTED,
  ACK `WORKING`, STATUS `WORKING`, STATUS `FILLED`, the reconcile's second
  STATUS `FILLED` and the fold's `FILL`, all inside about two seconds.
  `NIFTY-delta-lean-aggressive-2026-10-01`: 150 events for 16 orders.
  `SENSEX-delta-lean-aggressive-2026-10-05`: 136 for 16.
- **No why.** Nothing on an event says it was the day's open, an adjustment
  or the 14:50 flatten. The trigger is in `desk-engine-decisions` (keyed on
  `decisionId`), and every engine order id is `<decisionId>#<leg>`, but
  nothing joined the two.
- **Raw vocabulary.** Phase badges (`PLANNED`, `ACK`), the broker's status
  words, `NIFTY26O0622650CE` packings, `filled 130 @74.6` as the detail, and
  no side on most rows.
- **Newest first and interleaved.** The legs of one package were mixed in
  with their own phases, so the day read backwards.
- **Failures were hard to tell apart.** A chase that ran out of reprices
  (`ok:false`, "still resting…") and then filled at the deadline looked like
  a failure row followed by fill rows.

## Decisions

1. **Collapse in the web, join the trigger in the API.** The fill arithmetic
   already exists and is tested (`groupOrders`, used by the strategy page), so
   the collapsing is web-side. The trigger cannot be derived from the event
   stream, so the API stamps it.
2. **API, additive only.** `PnlStore.orderEvents` (behind
   `/v1/desk/reports/orders`) runs a new `withDecisionContext` after
   `withOrderContext`: one `$in` read of `desk-engine-decisions` on the
   decision ids, stamping optional `trigger` and `reason` on matching events.
   Events with no journal row (manual closes, `/submit` orders) are returned
   unchanged, and a failed read falls back to the events as they were. No
   existing field changes. The `/v1/desk/orders` route and the strategy page
   are untouched.
3. **Book → step → order.** Orders are grouped by book (tag), then by decision
   (a "step"), oldest first. The time and the step label are printed on a
   step's first row only, so a two-leg or four-leg package reads as one block.
4. **Words.** Trigger → label: `dl-open` Open, `dl-add` Add, `dl-neutral`
   Neutralise, `dl-target` Target hit, `dl-stuck` Stuck exit, `dl-stop` Day
   stop, `eod` EOD flatten, `expiry` Expiry settle, `lock` Profit lock, plus
   the recenter family's triggers. An unknown trigger shows as itself. With no
   trigger, the id prefix is used (`ui-flatten-` Flatten (manual), `ui-close-`
   or `opclose:` Close (manual), `daily-guard-` Day guard), then the paper
   fill's `op`, then "Order". Side is Buy/Sell. The contract is
   `formatContract` (`NIFTY 22650 CE`). Size is shown in lots, using the lot
   size from SUBMITTED `{lots, quantity}`, or `qty` when that is unknown.
   Average price has 2 decimals.
5. **Status is one of five words**, judged from the order's whole life rather
   than its last event: Filled (green), Partial (amber, "1 of 4"), Rejected
   (red), Cancelled (grey), Working (blue). The first failure's sentence is
   kept as the row's `problem`. It is red when nothing traded, and secondary
   when the order went on to fill.
6. **Times are IST `HH:MM:SS`** (`istClock`). Order ids are not on the row.
   The id is the first line of the per-order dialog.
7. **Summaries.** A day line (`16 orders · 16 filled`, prefixed with `N books`
   when there are several), and per book the step sequence
   (`Open → Neutralise → Add → … → EOD flatten`) plus its counts line when
   there is more than one book. Zero counts are left out.
8. **Failures stay findable.** The page never had a failures toggle, so this
   adds a "Problems only" switch. It keeps orders that did not end Filled or
   that carry a problem. The counts stay the whole day's. The api's
   `failures=1` is unchanged. It filters events, which would strip the
   context a row needs, so the web filters rows instead.
9. **Lifecycle on demand.** Each row ends in `N ›`, which opens every journal
   event in the same per-event table the strategy page's dialog uses
   (`eventColumns`).

## Shape

- `apps/api/src/rail.ts`: `withDecisionContext` and `decisionIdOf`.
  `store.ts` gains `COLLECTIONS.engineDecisions`, and `routes/engine.ts`'s
  `ENGINE_DECISIONS_COLLECTION` now points at it. `pnlstore.ts` calls the
  join.
- `apps/web/src/api.ts`: `OrderEvent.trigger?`, `reason?`. `baseOrderId` is
  exported.
- `apps/web/src/report-orders.ts`: a pure builder, `buildOrderLog(events,
  {problemsOnly})` → `{books: [{tag, steps: [{label, reason, orders}],
  counts}], counts}`, plus `countsLine`, `lotsText` and `istClock`.
- `apps/web/src/report-orderlog.tsx`: `ReportOrderLog`. `reports.tsx` renders
  it in place of the flat table.

## Tests

- api `pnl-routes.test.ts`: the route stamps trigger and reason. A split
  tranche joins on its decision, and an unjournalled order is left alone.
  The fake gains `$in`.
- web `report-orders.test.tsx`: a multi-fill order collapses to one Filled
  row with the final quantity; a rejected order; a partial fill (`1 of 4`); a
  failure the order outlived; two books interleaved in time come out grouped
  and in time order; problems-only; labels with no trigger; the id split;
  IST time. On screen: one row per order and no phase words; the switch;
  the dialog.

## Out of scope

- The strategy page's per-book log (`orderlog.tsx`). It is the same journal,
  but it is not what was asked about.
- Cleaning the journal at the write side (the duplicate STATUS FILLED from
  the reconcile). Rows already written would stay noisy, and the gateway's
  journal is relied on elsewhere.
- Running P&L per step. The day rows above the log already carry realised and
  total figures.
