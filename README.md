# algomaker-delta — the Delta desk

Paper option books on **Delta Exchange India BTC options**, run 24x7 by the supervisor, with every
Dial editable while the book runs. The first strategy is **BULL-S** (an ATM straddle pyramid on
strike crossings), in 1-strike and 2-strike jumps across daily, weekly and monthly expiries. P&L is
in USD, net of Delta fees.

This repo was cloned from the live NSE desk (`/opt/algomaker`, at `0d390c37`). It shares that desk's
machinery but is **isolated** from it: own database, ports, pm2 names and cookies.

| | NSE desk (live, not this repo) | This repo |
|---|---|---|
| Mongo db | `algomaker` | `algomaker_dx` (tests: `algomaker_dx_*`) |
| Ports | 87xx | **8890–8897** |
| pm2 | namespace `desk`, `desk-*` | namespace `dx`, **`dx-*`** |

`packages/core/test/dx-isolation.test.ts` fails on any live port, database, pm2 name or cookie in
a tracked source file. Never edit, run or restart anything of `/opt/algomaker` from here.

**Status (3 Nov 2026):** being built in lanes — see the [plan](docs/plans/2026-11-03-dx-bull-s-plan.md).
Until the Delta feed and gateway lanes land, `apps/marketdata` and `apps/order-gateway` still carry
their NSE (Kite, XTS) code.

## Processes

| pm2 | Entry | What it does |
|---|---|---|
| `dx-api` | `bin/desk-bridge.mjs` → `apps/api` | HTTP + WS on :8890. Books, Dials, orders, P&L, kill switch, auth; the dashboard's only API |
| `dx-marketdata` | `bin/desk-marketdata.mjs` → `apps/marketdata` | Instruments and the price feed; bus on :8891 (`md.tick`, `md.spot`, `md.health`) |
| `dx-gateway` | `bin/desk-gateway.mjs` → `apps/order-gateway` | The only process that can place a live order. Defaults to the simulator. The Delta rule (plan Task 6, not built yet): it sends to Delta only when `mode === 'live'` AND `DESK_DX_LIVE=1`, and everything else goes to the simulator |
| `dx-supervisor` | `bin/desk-supervisor.mjs` → `apps/supervisor` | Converges the book registry and runs each book's decide path (`packages/desk-engine`) |
| `dx-runner` | `bin/desk-runner.mjs` → `apps/runner` | Hosted-strategy runner. Defined, **not started** this round (spec §5) |
| web | `apps/web` (Vite build) | The dashboard, served as static files |

`ecosystem.desk.config.cjs` defines the pm2 apps. Starting and restarting them is the **operator's** job.

## Layout

| Path | What it is |
|---|---|
| `apps/api` | The bridge: routes, rails (paper / live), P&L jobs, auth |
| `apps/marketdata` | Feed, instrument sync, marks, history |
| `apps/order-gateway` | Claim, split, place, correlate fills, journal |
| `apps/supervisor` | Book hosting on top of `packages/desk-engine` |
| `apps/runner` | Hosted-strategy runner (skeleton; its catalogue is `premium-leg-book` only) |
| `apps/web` | React 19 + Vite dashboard |
| `packages/desk-engine` | The book decide paths (pure): state, dials, presets, triggers |
| `packages/strategies` | `premium-leg-book` (the NSE BULL/LION port) and its golden tape — the BULL-S parity reference |
| `packages/*` | The other pure, tested libraries: core, bus, instruments, marketdata-core, greeks, payoff, pnl, brokers, order-bus, auth, secrets, strategy-kit, strategy-config |
| `bin/` | pm2 entry points and CLIs (`desk-user.mjs`, `desk-reset.mjs`, `desk-payoff.mjs`, `desk-stall-watch.mjs`) |
| `scripts/` | `deploy.sh`, `dryrun-feed.mjs` (a scripted bus feed for rehearsals) |
| `docs/` | See [docs/README.md](docs/README.md) |

## Testing

Run everything at low priority. The api suites use real Mongo test databases (`algomaker_dx_*`).

```bash
npm run typecheck                         # root project + apps/web
cd apps/web && npx tsc -b                 # the dashboard's own build check
DESK_REQUIRE_MONGO=1 nice -n 19 node --test --test-concurrency=2 \
  'packages/*/test/**/*.test.ts' 'apps/*/test/**/*.test.ts'
nice -n 19 npm run test --workspace @algomaker/web -- --maxWorkers=2
```

The root typecheck excludes `apps/web`, and the node glob does not run the dashboard's `.test.tsx`
files, so all four are needed. Tests never reach the network: Delta REST/WS are exercised through
fixtures.

## Safety properties

- **Paper and live are separate rails.** Paper is filled by the simulator, never by a venue.
- **Idempotency is a unique database index**, not a read-then-write.
- **A halt blocks new exposure and never an exit.** Close-all works while the kill switch is on.
- **Nothing incomplete is presented as complete.** A book that cannot mark every leg says so and
  names what is missing.
- **Every order submission is journalled** to `desk-order-events`.

## Upstream fixes

`upstream` is the NSE repo, fetchable but not pushable. To bring an NSE fix across:
`git fetch upstream && git cherry-pick <sha>`.
