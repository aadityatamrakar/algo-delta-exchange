# Phase B — Reporting & P&L — Design Spec

**Date:** 2026-07-27
**Status:** approved in brainstorming
**Depends on:** Phase A (strategy registry supplies the tag list)

## 1. Purpose

Per-strategy P&L that survives a restart, an intraday chart, and a per-day order log. This is the
engine the dashboard cards and the per-strategy pages in Phase C both consume, so it is built once
here rather than twice there.

## 2. Locked decisions

| # | Decision |
|---|---|
| B1 | P&L is **computed from our own fills** and marked live — one engine for paper and live. |
| B2 | **Average-cost** basis, not FIFO. |
| B3 | Costs are an explicit optional input, defaulting to zero. We report **gross**. |
| B4 | M2M snapshots are **persisted**, ~15s during market hours. |
| B5 | Snapshots pruned beyond a configurable window (default 30 days); daily rollups kept forever. |

## 3. `packages/pnl` — pure engine, no IO

```ts
buildPositions(fills)            // net qty + average cost per contract
realised(fills, costs?)          // booked P&L, average-cost basis
unrealised(positions, marks)     // open legs marked off the feed
dayPnl = realised + unrealised
```

**Average cost, not FIFO (B2).** Options desks quote average; FIFO across a rolled ladder produces
numbers nobody recognises when they reconcile against a broker statement.

**Short-open is a credit; buying back realises.** That is the normal case for these books, not an
edge case, and it is the first thing to get wrong.

**Gross, not net (B3).** The Python desk owns its own net via its `CostModel`. If we silently
applied a different cost model, our number and theirs would disagree for reasons neither side
could explain. Costs are an input so net can be added later without redesign.

## 4. Where it runs

`apps/api`. It already holds the book and the marks for both paper and live, so P&L lives where its
inputs are rather than being recomputed in a second process.

## 5. Data

```
desk-pnl-snapshots  { tag, mode, ts, realised, unrealised, total }
desk-daily-reports  { date, tag, mode, realised, total, maxProfit, maxLoss,
                      orderCount, closingPositions, writtenAt }
```

Snapshots drive the intraday chart and **survive restarts** — the specific defect in the old
`strategyPNL`, which sat on a memory connector and lost the day on every restart.

The daily rollup is written at day end **and is recomputable from fills**. A rollup missed because
a process was down must be repairable, not a permanent hole.

## 6. Retention (B5)

A nightly prune job plus a manual "prune now" in the portal that **previews what would go** first.

**The guard: never prune a day whose rollup has not been written.** Otherwise the intraday detail
is deleted before it was ever summarised and both are gone — the rollup is recomputable from fills,
but not from nothing. The job prunes only days where `desk-daily-reports` has a row for every
strategy that traded, and reports any day it skipped and why.

This is why it is an explicit job and **not a Mongo TTL index**, which is the obvious mechanism: a
TTL index deletes on a timestamp and cannot express "only if summarised". It would happily delete a
day the rollup job missed while the process was down.

Sizing: ~15s snapshots over a 6.25h session is ~1,500 rows per strategy per day; 10 strategies over
30 days is ~450k rows, roughly 30 MB.

## 7. API and UI

```
GET /v1/desk/pnl?tag=&mode=&from=&to=     snapshots for the chart
GET /v1/desk/reports?date=                per-strategy rollup for a day
GET /v1/desk/reports/orders?date=         that day's order log
POST /v1/desk/reports/prune?dryRun=1      preview, then execute
```

Reports page: pick a date → per-strategy table (realised, total, order count) → the day's order log
from `desk-order-events` → the intraday chart. Chart via `recharts`, which astryx's own dashboard
template already uses.

## 8. Error handling

A strategy whose legs cannot all be marked reports P&L as **partial**, the same convention as
positions. A P&L of ₹0 and a P&L of "three legs could not be marked" must never look identical —
that is the same failure already fixed in the positions endpoint.

## 9. Testing

- realised across open / close / roll / resize; average cost through a partial close.
- short-open credit; buy-back realisation.
- unrealised against known marks; partial marking reported, not silently dropped.
- a snapshot gap does not corrupt the rollup.
- rollup recomputed from fills equals the live-computed number.
- prune skips a day with a missing rollup and says so; dry run mutates nothing.

## 10. Out of scope

Broker-reported P&L reconciliation (Phase C or later). Tax/charges modelling. Backtesting.
