---
name: strategy-sprawl-and-config-axes
description: "380+ strategy files encode only 15-18 distinct ideas; the 5 config axes that would collapse them, and orb-fut-core.js as the proven factory pattern"
metadata:
  type: project
---

**The core structural problem in algomaker: a strategy is a *file*, not a *config row*.**

## Evidence
- 380+ strategy files across `slive` (156) + `smp` (134) + legacy dirs encode **15–18 distinct
  trading ideas**.
- `cheetah-1910.js` vs `cheetah-1911.js` differ by **4 diff lines out of 236**.
- ATM-crossover strangle/straddle selling alone spans **~90 files**: lion (30), bull/bulln (20),
  eagle (12), stgl-mid/s (12), samlion (4), jk (3), biglion/dolphin/nifty-s/fox (5).
- **150 of 156** `slive` files `require('../server.js')` → each boots the entire LoopBack app and
  all 10 `boot/*.js` scripts.
- **147 of 156** construct their own `KiteTicker` → ~150 concurrent Kite websockets.
- Each strategy process also opens ~3 MongoDB change streams.
- ~120 of 146 legacy files use **zero** `CronJob` (older always-on/change-stream pattern) vs 36
  using cron.

Consequences: every new client/variant costs a file + pm2 process + websocket + LoopBack boot; a
bug fix must be applied N times; and a strategy's decisions **cannot be verified offline** at all.

## The 5 config axes (already visible in the existing code)
1. **Underlying** — spot token + strike step. NIFTY 256265/50, BANKNIFTY 260105/100, SENSEX 265/100, FINNIFTY 257801/50, MIDCPNIFTY 288009/50
2. **Offset** — ATM vs OTM distance (see [[otm-selector-returns-zero]] — in practice almost always 0)
3. **Stop/target basis** — fixed %, trailing %, fixed points, or premium-target
4. **Position sizing** — flat / pyramid-up / pyramid-down / martingale (capped or uncapped)
5. **Execution rail** — simulated vs live (see [[order-bus-not-paper-trading]])

## The proven pattern — already in the repo
`server/slive/orb-fut-core.js` exposes `module.exports = function startOrbFut(config)`, and
`orb-fut-{bn,nifty,snx}.js` are **7-line config wrappers** around it. That is the target
architecture, already validated here. The overhaul is applying it to the other ~150 files.

The 10 "modern" files (1,445 LOC, 3.8% of `slive`) are the good lineage: commented, pure-logic
split into `*-logic.js`, unit-tested with `node:test`. See [[slive-strategy-conventions]].

## How to apply
- Do **not** port 380 files one-for-one to TypeScript — that preserves the disease.
- Port ~18 classes; make the 380 files **config records**.
- Validate every port by **golden-master replay**: record a session's ticks, run old file and
  new class+config, diff the emitted order intents — they must match exactly.
- A logic/IO split is what makes golden-master port verification possible. NOTE: a research
  backtester was explicitly dropped 2026-07-25 at the owner's request — do not propose one.

Full analysis in `context/04-strategy-catalog.md` and `context/08-overhaul-proposal.md`.
