# `@algomaker/strategies`

The hosted strategy the runner can build. One **engine**, three registry **tags**:

| Engine | Tags it serves |
|---|---|
| `premium-leg-book` | LION_S25_2, BULL_S_1, BULL_SNX_1 |

It is kept in the Delta desk as the **parity reference for the BULL-S decide path**
(`packages/desk-engine`): `test/golden/premium-leg-book-bull.test.ts` holds the order tape the
legacy `bull-s-1.js` emitted, recorded on 3 Nov 2026 before the legacy archive was deleted, and the
port must still match it order for order. The other NSE engines (range breakout, momentum flip,
premium-distance accumulator) and the optionbhai signal mirrors were removed then.

## Layout

```
src/<engine>/
  configs/<name>.ts   THE NUMBERS — thresholds, times, sizing, intervals
  config.ts           the shape those numbers must fit, and its validation
  logic.ts            pure decision functions: no feed, no clock, no I/O
  strategy.ts         the class that wires logic to the injected ports
src/session-state.ts  restart-surviving state, through ctx.state
```

**If a golden fails, your change moved the behaviour.** Do not edit the recorded tape or loosen an
assertion to make it pass; the tape is what the legacy file did.

## Adding a hosted tag

1. **`src/<engine>/configs/<name>.ts`** — the config.
2. **`apps/runner/src/catalogue.ts`** — one line in `CATALOGUE`. Without it the tag has no
   implementation, and the portal's add form refuses it.
3. **`apps/api/src/registry-seed.ts`** — an entry in `HOSTED_STRATEGIES` if it should appear on a
   fresh deployment. Seeded rows are added to **paper only** and **switched off**.
4. **A test** that pins the decision you care about.

## The contract a strategy runs under

`StrategyBase` (`packages/strategy-kit`) owns the lifecycle. A strategy implements:

| Hook | When |
|---|---|
| `dataNeeds()` | declared once; the service dedups subscriptions across all strategies |
| `jobs()` | 6-field IST cron, with seconds — `20 15 10 * * 1-5` is 10:15:20 |
| `onTick()` | pushed; run the exit check synchronously here |
| `onCandle()` | pushed when a declared series closes a bar |
| `onRecover()` | rebuild in-memory state after a restart |
| `onDayEnd()` | flatten; called by the day-end job and by `stop()` |

Four of these are load-bearing in ways that are not obvious:

- **`onDayEnd` must actually place the exit.** It is the only automatic flatten. A strategy without
  it reports `squared-off` while carrying the position overnight — that was a real defect, found by
  driving the real classes rather than reading them.
- **`onRecover` must restore what `onDayStart` cleared.** `start()` calls `onDayStart()` *before*
  `onRecover()`. Without recovery a 12:30 restart abandons the open position, and a job replay can
  open a second one on top of it.
- **Order-placing jobs are `replayable: false`.** Catch-up after a restart replays setup jobs;
  replaying an entry duplicates the position.
- **Flags flip only after `res.accepted`.** A refused order must leave the opportunity available,
  and a refused *exit* must not mark the leg closed — that hides it from every later stop check and
  from the day-end flatten.

State that must survive a restart goes through `ctx.state` (see `src/session-state.ts`), written at
the point the field changes rather than at end of tick.

## Where a tag becomes real

```
configs/<name>.ts ─→ CATALOGUE (runner can build it)
                 └─→ HOSTED_STRATEGIES (row exists on a fresh deploy)
                       └─→ portal: add to paper/live, then switch on
```

Adding, and permitting to trade, are separate acts at every layer. A seeded row is off; an added
row is off; only the toggle makes it trade, and turning it on in live asks for the password.
