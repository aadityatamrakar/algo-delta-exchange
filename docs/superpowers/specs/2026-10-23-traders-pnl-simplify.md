# Traders: one P&L, one Today (2026-10-23)

Operator, on jignesh RELIANCE: "alot of different PNL and MTM, i dont understand what to look at and what is real" →
"check all pnl and mtm values, remove confusing values and which does not matter".

What the book showed at one moment: Pay In Out −1,37,625 · Day MTM −12,026 · Series P&L −19,035 (strip) · Series P&L
(net) −18,023 (MTM block) · Open P&L −1,76,000 · Gross MTM −47,175 / +35,737 / −11,438 · Expense −589 · Sq. off Exp.
−739 · Proj. MTM −12,765 · Booked (series) +1,59,125 · Charges (series) −3,660. The real numbers were two. Three
read the same figure at different moments, and two are cash, not P&L.

## Rulings

**R1. Two names, the same everywhere.**
- **P&L** = the Series P&L net (`seriesTotal.net`): every live expiry since its first trade, i.e. booked on the closed
  contracts + the open legs at LTP − all charges. This is the real number.
- **Today** = the Day MTM (`mtmDay` / the block's `current.total`): today's move after today's charges. It is part of
  P&L, not in addition to it.
- No other P&L or MTM total is shown as a headline anywhere. The labels "Day MTM", "Series P&L", "Series P&L (net)" and
  "Open P&L" leave the UI.

**R2. One snapshot on a screen.** The live frame (`GET /books/:stock/live`, analytics/live.ts) gains `seriesNet`
(number | null) and its parts `seriesOpen`, `seriesBooked` and `seriesCharges`. They come from the series base (the
`SeriesReader`, already in deps) and each live-series leg's live gross MTM, with the same arithmetic as
`seriesPnl`/`seriesTotal`. The value is null when a live-series leg has no LTP; with no series reader the fields are
absent. The strip and the P&L block both take P&L and Today from the fresh live frame when it has them (the existing
`liveWins` rule), else from their own view. The two can then never disagree on one screen. The web must work against
the old server (frame without `seriesNet` → the view's `seriesTotal.net`), so the web build may go live before the
restart.

**R3. Removed (not P&L, or only a part shown as if it were a total):**
- `Pay In Out` (greek-panels column): cash premium paid or received today, not profit.
- `CF Balance` (analysis metadata): cash.
- `Sq. off Exp.` and `Proj. MTM` (MTM block): an estimate of closing charges; does not matter for reading the book.
- The `Gross MTM` and `Expense` rows as separate rows: they become Today's breakdown (R4).
- `Open P&L` as a total: the book-legs summary cell (book-legs.tsx), the Portfolio columns (book, month-wise and stock
  rows, totals) and the Daily column.
- `Series booked` column (Daily).
- Wire fields stay (`payInOut`, `cfBalance`, `squareOff`, `projected`, `openPnl`, …): the AI desk and older clients read
  them. This is a UI change plus the additive live-frame fields (and portfolio fields, R5).

**R4. The analysis MTM block becomes "P&L"** (block id unchanged so saved layouts keep working; title "P&L"). It shows
two bold totals, each with its parts indented beneath and visibly summing to it:

```
P&L  (since 5 Oct, after charges)        −18,023
   Booked on closed contracts          +1,59,125
   Open legs at LTP                    −1,73,488
   Charges                                −3,660
Today                                    −12,026
   Legs carried from yesterday's close    −47,175
   Today's trades                         +35,737
   Today's charges                           −589
```

- The "since" date is the series' first trade.
- With more than one live expiry, P&L's ⓘ lists each expiry (the existing `seriesLines`).
- Before 09:15 or on a closed day, Today and its parts are "—" with the server's reason (G5's `dayReason`).
- An unknown value is "—".
- Rates not confirmed adds the existing "(est.)" note.

**R5. Where each shows.**
- **Book strip:** `P&L` first, then `Today`. Each ⓘ gives its breakdown in words: P&L = R4's three parts; Today =
  carried + today's trades − today's charges.
- **Portfolio:** columns `Today` and `P&L`, replacing Day MTM and Open P&L.
  - Server portfolio rows gain `pnl` (the book's `seriesTotal.net`, null = unknown or no live series) and `pnlReason`
    if useful.
  - Month-wise rows: that expiry's series net.
  - Stock roll-up and totals: sums, unknown if any part is unknown (as `addKnown` does for Day MTM).
  - `MONTH_MTM_NOTE` goes.
  - Reuse the cached `SeriesReader`. Do not add a per-book Mongo walk to every portfolio poll beyond what the series
    reader already caches.
- **Daily:** columns `Today` (dayMtm) and `P&L` (seriesNet); drop Open P&L and Series booked. Stored rows are unchanged.
- **Per leg** (book-legs `Open P&L` column, leg-table `GrossMTM`): one name, **`Leg P&L`**, tooltip "this contract since
  it was opened, partial exits included, before charges; the book's result is P&L". The groups card's total cell is
  also renamed `Leg P&L` (a group's legs summed, same tooltip). The `Net Price` column stays (a price, not P&L).

**R6. Unchanged:**
- what-if tools (scenario grid, gap panel "vs value now", payoff curves, assistant plan metrics EV / Max loss / Worst
  shock);
- the hidden Booked page;
- every number's arithmetic.

**R7. AI desk:**
- The prompt (agent/prompt.ts) states that a book's result is reported as "P&L" (series net, since the first trade,
  after charges) and "Today" (Day MTM).
- Open P&L, booked, Pay In Out and CF balance are never given as the result. Parts are given only as P&L's breakdown,
  when asked.
- Bump `PROMPT_VERSION` to `desk-ai-2026-10-23.9`.
- Tool outputs may keep their fields.

## Tests
- Live frame `seriesNet`: equals `seriesTotal.net` for the same LTPs; null on a missing LTP; absent with no reader.
- Strip and block: same value from one fresh frame; fallback to the view without the field (old server).
- Removed labels absent: Pay In Out, CF Balance, Sq. off Exp., Proj. MTM, Open P&L, Day MTM, Series P&L, Series booked.
- Portfolio `pnl` and roll-ups.
- Daily columns.
- Prompt version.
- Web CSS brace test still passes.
