---
name: desk-bridge-new-system
description: "2026-07-27 FULL CUTOVER — algomaker is now a bridge+dashboard for the Python sensibull-desk; old server/ system is discarded, not strangled"
metadata: 
  node_type: memory
  type: project
  originSessionId: 778a130c-8f92-4005-b4bd-d697360ddf23
  modified: 2026-07-27T09:32:56.442Z
---

**Full cutover decided 2026-07-27.** The old system is **discarded**, not strangled. Do not fix
anything under `server/`, `common/`, `client_wc/` — new work goes in `packages/` and `apps/` only.
This supersedes the strangler-fig sequencing in `context/08-overhaul-proposal.md` phases 4-7 and
the framing in [Repo topology](repo-topology-live-vs-dead.md).

## The shape

Python (`/Users/aaditya/Documents/dev/algo-engine/sensibull-desk`) owns **all trading logic** —
rules engine, book, delta management, rolls. algomaker is a **bridge + dashboard**: it routes
orders, computes greeks independently, and reports what actually happened. Multiple Python
processes under pm2.

- `apps/api` — the bridge (HTTP, port 8790). Paper/live books, greeks, diff, kill switch, close-all.
- `apps/marketdata` — one Kite login, socket pool (900 tokens/socket), instrument+freeze sync,
  publishes `md.tick` / `md.spot` / `md.health` on a WS bus (port 8791).
- `apps/order-gateway` — THE live executor. Claims from `desk-gateway-orders`, splits under the
  exchange freeze limit, places via XTS, journals every attempt.
- `apps/web` — React 19 + Vite + astryx dashboard.

**Retired: `xtsOrder.js`, `smp_order_listener.js`.** Never run them alongside the gateway — both
consuming orders places every one twice. That is the most expensive mistake available here.

## Things that cost real debugging to learn

- **Stock options tick ~every 30s.** A per-token mark-age limit near that makes every mark absent
  and the bridge books nothing. Feed liveness must be **feed-wide**; per-token age is reported,
  never used to hide a price.
- **Chain coverage plateaus at ~90%** — some far strikes never trade. Readiness must be "are the
  legs I HOLD marked", not chain coverage. Warm-up after restart is 60-90s.
- **Index spot rows are named differently from their derivatives** — `NIFTY` options vs a
  `"NIFTY 50"` index row. Name matching finds no spot and greeks become uncomputable. Keyed by
  token via `INDEX_SPOT_TOKENS`.
- **Strike steps must be inferred from the listed chain.** BHEL's is 2.5, not the 5 its round
  strikes suggest; ATM at spot 417 is 417.5.
- **`maxLotsPerOrder = floor(VOL_FRZ_QTY / marketLot)`** from NSE `qtyfreeze.csv` + `fo_mktlots.csv`.
  Reproduces the legacy table where the lot is unchanged (NIFTY 27, BANKNIFTY 20) and disagrees
  where it changed (FINNIFTY 30 not 45, MIDCPNIFTY 23 not 56) — the legacy values now EXCEED the
  freeze and get rejected. 215 underlyings, 210 of them stocks. BHEL = 20 lots/order.
- **Orders need durability that ticks do not.** A dropped tick is harmless; a dropped order means
  the desk thinks it placed something that never reached a broker. So: durable collection + WS
  nudge + idle sweep + claim-based pickup. No change streams on the order path.

## Conventions that must hold

- Paper and live are **separate collections**, so a paper order cannot reach a broker by construction.
- Idempotency is a **unique index on `decisionId`**, not a read-then-write — N pm2 clients race.
- Never present an incomplete number as complete: `positions.complete`, `greeks.unpriced`.
- A halt blocks new exposure and **never** an exit. Close-all works while halted.
- Every order submission is journalled to `desk-order-events` (ACCEPTED→PLANNED→SUBMITTED→ACK→
  STATUS, plus FAILED with the broker message and its class).

## Production, as of 2026-07-28 — the facts that cost real time

- **`ubuntu@3.108.231.230`, `/opt/algomaker-delta`.** Deployed over SSH: `make deploy-remote` from the
  laptop, which SSHes in and runs the same `scripts/deploy.sh` on the box. Never as root.
- **Mongo is a STANDALONE. Change streams DO NOT WORK.** Nothing may be designed to depend on them,
  and nothing does (`grep -rn "watch(" apps packages` → zero). This is why the websocket push is a
  POST from `desk-gateway` and an in-process emit from `PaperRail`, not a tailed collection.
- **The web server is CADDY**, serving `apps/web/dist` as static files on `:80`. It does **not**
  proxy the API — the browser calls `:8790` directly, which is why `DESK_CORS_ORIGINS` must name the
  page origin exactly (`http://3.108.231.230`, no `:80` suffix). Earlier docs said "nginx".
- **`desk-runner` SQUARES OFF ON SIGTERM** (`apps/runner/src/runner.ts:671-681`), in paper and in
  live. Restarting it mid-session CLOSES REAL POSITIONS. Safe mid-session deploy: rebuild the web
  bundle and restart only `desk-api` (+ `desk-gateway` if it changed). `deploy.sh` restarts all four
  and refuses during market hours by design.
- **A `desk-api` restart in market hours can cost a signal.** The runner retries a submit 3 times,
  200 ms apart (~600 ms of cover); after that it records OUTCOME UNKNOWN, keeps the
  `clientOrderId`, and the strategy's next tick replays it. Nothing double-routes.
- **`npm run typecheck` at the root does NOT cover `apps/web`** — `tsconfig.json` excludes it and
  globs only `*.ts`. The gate is `cd apps/web && npx tsc -b`. A type error reached production this
  way on 2026-07-28.
- `npm run build --workspace @algomaker/web` fails on the laptop on a missing `esbuild` (broken
  local `node_modules`), and works on the server. Not a regression.

Detail: `docs/DEPLOYMENT.md`, `docs/SERVER-REBUILD.md`, `context/12-dashboard-data-and-push.md`,
`context/13-development-workflow.md`.

## First live symbol

BHEL, August expiry (2026-08-25), lot 2625. Seeded 8-leg ratio structure: 3 short strikes per side
(5 lots each) against one long wing (15 lots), so net contract qty per side is zero. Verified live
2026-07-27: greeks reproduce the operator's own sheet IVs to ~1 vol point.

Plan doc: `docs/superpowers/plans/2026-07-27-desk-bridge.md`. Creds in `.env.local` (gitignored).
