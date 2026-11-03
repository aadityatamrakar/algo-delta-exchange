# Ticket 12 (plan Task 16) — Gateway quote map + peg-mode chaser

**Status:** complete. Branch `worktree-agent-a1bca1566a3b6d9ef` (off `recenter-migration`).
**Commit:** `b23907e0` + a follow-up test fix.

---

## What shipped

### `apps/order-gateway/src/quote-map.ts` (new)

`createQuoteMap({ now, maxAgeMs })` → `{ onTick(frame), touch(token), size }`.

- **Two-sided or nothing.** A frame is recorded only when `bid` and `ask` are both
  finite, `> 0` and un-crossed (`ask >= bid`; a locked market is kept). An LTP-only
  frame is a *trade print*, not a book — it neither replaces the last book nor
  refreshes its age. That is the TCS 2440PE failure (last print 14:20 under a book
  moving every second) made structurally impossible.
- **Age is the book's own**, taken from the frame's `ts`; a garbled `ts` degrades to
  arrival time, never to `NaN` (a `NaN` age reads as fresh forever).
- **`touch()` returns `null`** past `DESK_PEG_QUOTE_MAX_AGE_MS` (default 15 000,
  `quoteMaxAgeFromEnv`, NaN/≤0-refusing). `null` means *pause*.
- **Never throws** — it runs inside a bus subscriber on the only process that can
  place orders. Every field off the wire is validated; junk is dropped.
- No `desk-marks` read: the display-only-snapshot invariant stays intact. This map
  holds only what arrived live on this process's own subscription.

### `apps/order-gateway/src/order-chaser.ts` — peg mode

A doc with `workMode: 'passive'` (contract: `packages/desk-engine/src/contract.ts:45`)
leaves the shared gate chain right after the liveness check and is worked by `pegOne`:

- **Join the touch** — `pegPrice()`: SELL rests at the best ask, BUY at the best bid,
  rounded *away* from the spread (sell ceil, buy floor) so an off-grid quote can never
  round the order into a cross. Bounded at `limitPrice ± chaseCrossBufferPct × limitPrice`
  so a passive sell does not follow a collapsing offer down one reasonable-looking
  re-peg at a time.
- **Modify only on a real move** — `|target − lastChasePrice| ≥ 1 tick` AND dwell
  ≥ `DESK_PEG_DWELL_MS` (default 1 000; the blind ladder keeps `chaseAfterMs`).
- **Stale touch → pause.** No modify, no attempt consumed, **no fall-through to the
  blind ladder**. Same for: no `instrument_token`, no quote map wired, no tick yet for
  the token. Logged once per order (in-memory `warnedNoTouch`) once past the deadline.
- **One cross, last** — at `chaseMaxMs` from `placedAt` (doc field, default 30 000),
  `crossPrice()` reaches through the *far* side of the touch by `chaseCrossBufferPct`
  (doc field, default 0.005), stamps `pegCrossedAt`, and after that price has had its
  own dwell the existing `exhaust()` hands the order to a human, unchanged.
- Per-tranche: one price to every live broker id, acceptance counted per pass —
  identical rule to the blind ladder (shared `sendPrice`).

Dials: `chaseDialsFromEnv` gained `pegDwellMs` (`DESK_PEG_DWELL_MS`, NaN/zero-refusing).
Deps: `quotes?: Pick<QuoteMap,'touch'>`, optional — a gateway wired without it pegs
nothing rather than reverting to crossing.

### `apps/order-gateway/src/main.ts`

- `createQuoteMap` built at boot, fed by an **unconditional** `md.tick` subscription
  (was simulate-only at `:1546-1551`). The simulator feed still takes the same frames
  via `busTickFeed?.()`. A subscription that lived only on paper would have meant the
  rehearsal pegs and the live session crosses.
- `quotes` passed to the chaser; the wiring comment and the "chaser armed" log line
  now state both modes.

### `apps/order-gateway/package.json`

`@algomaker/bus` declared (was resolving through the workspace symlink only).

### `apps/api/src/rail.ts`

`orderDocument` stamps the instrument's own `tickSize` (8 lines with the comment;
omitted, never zeroed, when the instrument has no usable tick). `DEFAULT_TICK = 0.05`
remains as the fallback for documents written before this. Pinned from the gateway's
side in `test/rail-contract.test.ts`, the file whose stated job is pinning the rail's
shape.

---

## Tests

| Suite | Count |
|---|---|
| `apps/order-gateway/test/quote-map.test.ts` (new) | 10 |
| `apps/order-gateway/test/order-chaser-peg.test.ts` (new) | 27 |
| `apps/order-gateway` workspace (`npm test -w @algomaker/order-gateway`) | **295 pass / 0 fail** |
| Root `npm run test:node` | **2929 pass / 1 fail (pre-existing, see below)** |
| `npx tsc -p tsconfig.json` | clean |

Every scenario from the brief's failing-test list is covered:
passive SELL at ask 10.00 → touch 10.10 after dwell → one `modifyOrder(10.10)`;
flicker 10.00→10.05→10.00 inside the dwell → zero modifies; stale quote → zero;
`chase_max_ms` elapsed with touch `{bid 9.90}` → crossing modify at `9.90 × 0.995`
tick-floored = **9.85**, then exhausted; cancel-pending → skipped, `cancel wins`
log unchanged.

Plus, on top of the list: bounded peg on a collapsing book, passive BUY bounded above,
doc-level `tickSize` honoured, multi-tranche pegging, sub-tick move ignored, LTP-only
feed never pegs, refused cross retried (not counted as *the* cross), crossed order that
filled exhausts *silently*, deadline with a stale book crosses nothing, `resting:true`
beats `workMode:'passive'`, pre-boot passive doc untouched, passive doc exempt from the
attempt ceiling, and the blind ladder proven **unchanged** against a fresh touch for
three non-passive shapes (absent / `'urgent'` / unrecognised `'PASSIVE'`) → all three
still price at 97 off the original limit of 100.

**Harness:** the blind-ladder suite's fakes were extracted verbatim into
`apps/order-gateway/test/chaser-harness.ts` (not a `.test.ts`, so the runner globs skip
it) and are shared by both suites. **No assertion in `order-chaser.test.ts` was changed**
except the two `chaseDialsFromEnv` deepEquals, which gained the new `pegDwellMs` key.
The harness holds a **real** `QuoteMap` on the harness clock, so the staleness gate is
exercised end to end rather than stubbed.

---

## Deviations from the brief, and why

1. **`"@algomaker/bus": "1.0.0"`, not `"*"`.** Every other workspace dependency in the
   repo is pinned at `1.0.0` (`apps/api`, `apps/runner`, …). House consistency.
2. **The cross and the exhaust are not the same pass.** The brief says "one crossing
   modify … then `exhaust()`". Implemented as: cross, stamp `pegCrossedAt`, and exhaust
   once that price has had the same dwell every other price gets. Reason: a marketable
   modify usually fills in well under a second, and alerting immediately would fire the
   loud "still resting" line at an order that is already gone — the exact failure the
   existing `LIVENESS FIRST, EXHAUSTION SECOND` comment was written to prevent. If it
   filled, the liveness gate now retires the doc **silently** (tested). `pegCrossedAt`
   guarantees the cross is still exactly one.
3. **The worst-price bound governs the peg, not the single cross.** Required by the
   brief's own expected value: limit 10.00 with buffer 0.005 gives a bound of 9.95,
   which would clamp the specified cross of 9.85. Rationale in the code: a limit pushed
   past the touch fills **at** the touch, so the book itself is the cross's bound — and
   the staleness gate is what keeps that true.
4. **`chaseDialsFromEnv` grew a key.** Needed for `DESK_PEG_DWELL_MS` to reach the
   chaser through the existing wiring. No behavioural change to any blind-path dial.
5. **`sendPrice` extracted** and used by both modes. Log strings are byte-identical
   (`chase modify REFUSED by broker` / `chase modify threw`) and are pinned by an
   existing assertion in the blind-ladder suite.

---

## Concerns / follow-ups

1. **Peg responsiveness is floored by the pass interval, not the dwell.** The chaser
   runs on `setInterval(DESK_CHASE_MS, default 5 000)`, so a peg can follow the touch at
   most every 5 s — ~6 opportunities inside a 30 s deadline, not the ~30 the 1 s dwell
   implies. Lowering `DESK_CHASE_MS` to 1 000 is safe for the blind ladder (it is
   independently gated by its own 15 s dwell) and costs one bounded Mongo find per
   second. **Left at 5 000 deliberately — out of this ticket's scope to change a shared
   timer — and documented in the `DEFAULT_PEG_DWELL_MS` comment. Worth a decision before
   the first passive live session.**
2. **Nothing writes `workMode` onto order documents yet.** Peg mode is dormant until the
   engine endpoint / rail thread `workMode`, `chaseMaxMs` and `chaseCrossBufferPct`
   through (Task 17 already has to add `trancheLots` in `rail.ts:86-110` — same place,
   same context). Until then every doc takes the blind ladder, so this is **deployable
   now and inert**.
3. **A passive order that can never see the touch never crosses and never exhausts.**
   It rests; one log line names it; the broker sweep's WORKING alert (F-17) is what tells
   a human. That is the deliberate "never guess" choice, but it means a dead feed
   converts passive orders into resting ones with no journal event of their own. If that
   silence is unacceptable, the fix is a journalled alert on the stale-deadline branch —
   deliberately not added here to keep the failures feed for things that need action.
4. **`warnedNoTouch` is process-memory and uncapped** — bounded in practice by distinct
   passive orders that reach their deadline with no touch in one gateway lifetime (tens).
5. **Pre-existing red test:** `apps/api/test/service.integration.test.ts:153`
   *"a PARTIALLY marked book names only the missing legs"*. Verified pre-existing —
   it fails identically on the base commit with this work stashed. **Not touched by this
   ticket**, but the root suite is not green on `recenter-migration`.
6. `rail.ts:orderDocument` is shared by the paper rail and the legacy positional writer;
   `tickSize` is purely additive and every legacy reader (`xtsOrder.js`) reads by key, so
   no consumer sees a shape change.
