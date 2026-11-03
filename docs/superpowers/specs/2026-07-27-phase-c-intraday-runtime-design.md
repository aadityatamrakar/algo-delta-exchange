# Phase C — Intraday strategy runtime — Design Spec

**Date:** 2026-07-27
**Status:** approved in brainstorming
**Depends on:** Phase A (registry, switch), Phase B (P&L engine)
**Companion:** `2026-07-27-strategy-base-design.md` — the base and the ports

## 1. Purpose

Run the intraday strategies in the new system, managed from the portal: enable/disable, autostart
at day start, square-off and stop at day end, live lot allocation, and per-strategy P&L views.

## 2. The strategies to run

Taken from `archive/common/models/strategies.json`, selecting `autostart === true` **or**
`delay_start` set — 16 of 101 entries. `delay_start` is an "HHmm" IST string matched by a
once-a-minute cron (`xtsOrder.js:343`); `autostart` starts at boot.

**All 15 strategies are already ported** as configs in `packages/strategies`. Phase C hosts them;
it does not re-port them.

| Registry tag | Legacy module | Start | Ported config | Golden reference |
|---|---|---|---|---|
| `MIRROR_1PBUY` | candlestrategy | 0914 | ✓ | none (external mirror) |
| `MIRROR_A006` | candlestrategy-a006 | 0914 | ✓ | none (external mirror) |
| `MIRROR_EMA2050` | candlestrategy-test3 | 0914 | ✓ | none (external mirror) |
| `BN_BREAKOUT` | bn-breakout | 0916 | ✓ | present |
| `CHEETAH_B1_1` | cheetah-b1-1 | 0917 | ✓ | present |
| `CHEETAH_B1_SNX` | cheetah-b1-snx | 0917 | ✓ | present |
| `ATR_BAND_NIFTY` | atr-band-nifty | 0918 | ✓ | present — **see §6** |
| `ORB_FUT_NIFTY` | orb-fut-nifty | 0918 | ✓ | present |
| `ORB_FUT_BN` | orb-fut-bn | 0918 | ✓ | present |
| `ORB_FUT_SNX` | orb-fut-snx | 0918 | ✓ | present |
| `ORB_SCALP_BN/NIFTY/SNX` | orb-scalp | 0918 | ✓ | present |
| `LION_S25_2` | lion-s25-2 | autostart | ✓ | present |
| `EAGLE_S_1` | eagle-s-1 | autostart | ✓ | present |
| `BULL_S_1` | bull-s-1 | autostart | ✓ | present |
| `BULL_SNX_1` | bull-snx-1 | autostart | ✓ | present |

`smp_order_listener` (0914) is the 16th entry but is **infrastructure, not a strategy** — the order
gateway's fill watcher replaces it. It does not get a registry row.

The three `candlestrategy` legacy files were deleted (they carried plaintext optionbhai passwords
and have no golden reference — an external signal mirror has no legacy file to diff against). Their
credentials move into Phase A's broker store. **Those credentials are in git history and still need
rotating.**

The registry is seeded with these and **more are added later** by inserting a row; nothing in the
runner is hardcoded to this list.

## 3. `apps/runner`

Loads enabled `hosted` rows from `desk-strategies`, constructs each strategy with the injected
ports, and drives the lifecycle. It knows nothing about any individual strategy — see the
StrategyBase spec. If adding a strategy requires touching the runner, the runner is wrong.

## 4. Order path

Hosted strategies POST to the bridge exactly as the Python desk does:

```
/v1/desk/actions   book-shaped        external Python desk
/v1/desk/submit    one order          hosted intraday strategies   ← new
        └────── same gates → same journal → same gateway ──────┘
```

Both pass the strategy switch, kill switch, live allowlist and freeze split. Hosted and external
strategies differ only in who runs the process.

## 5. Lifecycle

- **Start:** `autostart` at boot; `delay_start` at its HHmm, via a once-a-minute IST check.
- **Day end:** run the square-off phase, then stop. In the old system this was `process.exit()` at
  15:30 with pm2 restarting each morning; in one runner it is a state transition, which is simpler
  and observable.
- **Restart mid-session must work.** The old system kept positions in process memory, so a 12:30
  restart lost them. State persists via the `StateStore` port and `onRecover()` rebuilds before
  catch-up. Order-placing jobs are `replayable: false` and are re-derived from recovered state —
  replaying an entry would duplicate the position.

## 6. ATR_BAND_NIFTY is blocked

Its golden test is currently `{ todo }` and failing by design. Two real port defects: the band is
formed in one step instead of two (10:15 ATR width off 60-minute candles, then 11:40 lines anchored
on the 5-minute close), and the exit path compares the **option's own** candle close against
spot-scale band lines, which force-closes every CE almost immediately.

**It must not be enabled live until that test is green.** It may run in paper with the defect
visible. Fixing it is part of Phase C, not a prerequisite for the rest.

## 7. Live sizing

`liveLots` on the registry row **replaces** the strategy config's `sizing.lots` in live mode. It is
an override, not a multiplier. Multipliers compound invisibly — that is exactly how `xtsOrder.js`
applied an account multiplier on top of an already-multiplied quantity. An override can be read off
the row and matched against the order that went out.

## 8. UI

- **Dashboard:** per-strategy P&L cards (Phase B engine), paper and live.
- **Strategy management:** the list with enable/disable, autostart time, live lots, status.
- **Per-strategy page:** net positions, that strategy's order log, its intraday P&L chart.

This is the old `Dashboard`, `Strategy Management` and `Net Positions` screens, rebuilt on data we
compute rather than scrape.

## 9. Testing

- Lifecycle transitions on a synthetic clock: autostart, delay_start, day-end square-off, stop.
- Restart recovery reconstructing an open position.
- `/submit` blocked independently by each gate.
- `liveLots` overriding rather than multiplying.
- Strategy classes keep their golden-master coverage against `archive/server/slive/`.

## 10. Sequencing

1. runner + `/submit` — strategies can trade
2. lifecycle: autostart, delay_start, day-end
3. registry seeding with the table in §2
4. UI: management, cards, per-strategy pages
5. ATR_BAND_NIFTY defect fix

## 11. Out of scope

Editing strategy parameters from the UI. Supervising external Python processes. Backtesting.
