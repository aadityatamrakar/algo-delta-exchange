# `@algomaker/strategies`

Every intraday strategy the runner can host. Four **engines**, seventeen registry **tags** — most
strategies are a config against an existing engine, not new code.

## Layout

```
src/<engine>/
  configs/<name>.ts   THE NUMBERS — thresholds, times, sizing, intervals
  config.ts           the shape those numbers must fit, and its validation
  logic.ts            pure decision functions: no feed, no clock, no I/O
  strategy.ts         the class that wires logic to the injected ports
```

| Engine | Tags it serves |
|---|---|
| `range-breakout-directional` | BN_BREAKOUT, ATR_BAND_NIFTY, ORB_FUT_×3, ORB_SCALP_×3 |
| `momentum-flip-directional` | CHEETAH_B1_1, CHEETAH_B1_SNX |
| `premium-leg-book` | LION_S25_2, BULL_S_1, BULL_SNX_1 |
| `premium-distance-accumulator` | EAGLE_S_1 |
| `external-signal-mirror` | MIRROR_× — an adapter, **not** a `StrategyBase` (see below) |

## Changing an existing strategy

Edit its file in `configs/`, then:

```
npm test          # the goldens must stay green
make restart      # the runner reloads
```

**If a golden fails, your change moved the behaviour.** That is the test doing its job — every
ported strategy is verified order-for-order against the original in `archive/server/slive/`. Do not
edit a fixture or loosen an assertion to make it pass. If you believe the fixture is genuinely
wrong, stop and prove it; a fixture edited to match the port is the one failure the goldens exist
to prevent.

**Parameters are not editable from the portal, deliberately.** A threshold in a file can be
reviewed, diffed and golden-tested. A row edited in Mongo at 14:50 is none of those. The portal
owns what is operational — on/off, paper/live, live lots, autostart — not what the strategy
decides.

## Adding a strategy

### If an existing engine fits — the common case

1. **`src/<engine>/configs/<name>.ts`** — the config. Copy the closest sibling; the type and
   `assertValid…` will reject anything the engine cannot express.
2. **`apps/runner/src/catalogue.ts`** — one line in `CATALOGUE`, using the engine's helper
   (`rangeBreakout('MY_TAG', MY_CONFIG)`). **Without this the tag has no implementation**, and the
   portal's add form refuses it rather than creating a switch that looks armed and runs nothing.
3. **`apps/api/src/registry-seed.ts`** — an entry in `HOSTED_STRATEGIES` if it should appear on a
   fresh deployment. Seeded rows are always added to **paper only** and **switched off**.
4. **A test.** A golden if you are porting something that already runs in `archive/server/slive/`;
   otherwise a class-level test that pins the decision you care about.

### If no engine fits

A new folder under `src/`, following the same four-part split, plus a `build` helper in the
catalogue. Keep `logic.ts` free of the clock and the feed — that separation is what makes a
strategy testable without a market.

### What NOT to do

Do not give a non-`StrategyBase` thing a fake lifecycle to get it into the catalogue. The
`MIRROR_*` tags are the standing example: an external signal mirror has no entry logic, no position
state and no data needs, so it is a `SignalSource` adapter. Listing it in `CATALOGUE` would have
`Runner` supervise a session, a cron schedule and a square-off that do not exist.

They are still hosted, in a path of their own: **`apps/runner/src/mirrors.ts`** (`MirrorHost`) runs
them against **`apps/runner/src/optionbhai.ts`**, which implements the adapter's two ports — login,
instruments, websocket, reconnect. Same registry rows and same per-mode switch as a strategy, same
`/v1/desk/submit`, one lot per mirrored signal. Credentials come from the environment, named by the
config's `credentialsRef` (`optionbhai/1pbuy` → `OPTIONBHAI_1PBUY_USER` / `_PASS`); a mirror whose
pair is missing refuses to start and says so. See `.env.local.example`.

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
