# algomaker — desk execution system

Execution bridge and dashboard for the Python trading desk
(`algo-engine/sensibull-desk`), which owns all trading logic. This side routes
orders, computes greeks independently from the live feed, and reports what
actually happened.

> **2026-07-27: full cutover.** The previous LoopBack system is retired and
> frozen in [`archive/`](archive/README.md). Do not fix anything there — new
> work goes in `packages/` and `apps/`.

## Quick start

```bash
make up        # start everything, SIMULATED broker (cannot place real orders)
make status    # processes + feed readiness
make logs      # follow
make down      # stop
make help      # everything else
```

`make up` is safe by construction: the gateway runs `DESK_BROKER=simulate`, and
only `make live` (which asks for confirmation) reaches a real broker. A
forgotten flag should never be the difference between a dry run and real money.

The feed needs **60–90 seconds** to warm up after a start — far strikes trade
rarely, so their first tick takes a while. `make feed` reports readiness, which
is measured against *the legs you actually hold*, not chain coverage.

## Layout

| Path | What it is |
|---|---|
| `apps/api` | The bridge. HTTP :8890 — actions, positions+greeks, diff, kill switch, close-all |
| `apps/marketdata` | One Kite login, socket pool (900 tokens each), instrument + freeze sync, bus :8891 |
| `apps/order-gateway` | The only process that places live orders. Splits under the exchange freeze limit, journals every attempt |
| `apps/runner` | Supervises the hosted strategies. **Squares off open positions on SIGTERM** — never restart it mid-session |
| `apps/web` | React 19 + Vite dashboard |
| `packages/` | Pure, tested libraries: instruments, greeks, brokers, order-bus, strategies, bus |
| `context/`, `memory/`, `docs/` | Architecture docs, distilled facts, plans |
| `archive/` | The retired system, frozen |

## Safety properties worth knowing

- **Paper and live are separate collections.** A paper order cannot reach a
  broker by construction, not by discipline.
- **Idempotency is a unique database index** on `decisionId`, not a
  read-then-write — several Python clients race.
- **A halt blocks new exposure and never an exit.** Close-all works while the
  kill switch is engaged; that is its purpose.
- **Nothing incomplete is presented as complete.** A book whose legs cannot all
  be marked reports `complete: false` and names what is missing, rather than a
  net delta of zero that reads as "flat".
- **Every order submission is journalled** to `desk-order-events`, with the
  broker's own message and its error class.

## Testing

```bash
make check                                # typecheck + both suites
cd apps/web && npx tsc -b                 # NOT covered by the above — run it too
```

`make check` is the root typecheck plus `test:node` (node:test) and `test:web` (vitest). The root
typecheck **excludes `apps/web`** — `tsconfig.json` lists it in `exclude` and globs only `*.ts` —
so the dashboard's own `tsc -b` is a separate, necessary step. A type error reached the server this
way on 2026-07-28. See `context/13-development-workflow.md` §4.

`DESK_BROKER=simulate` runs the entire live path — durable write, nudge, claim,
freeze split, placement, fill correlation, journal — with no broker account.
