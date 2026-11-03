# Overhaul Proposal — awaiting approval

*Drafted 2026-07-25. **Nothing in here has been executed.** This is a proposal for review.
Decisions needing your input are marked **DECISION**.*

---

## 1. The core argument

The instinct to "upgrade to the latest framework" is right, but the framework is the
*symptom*, not the disease.

**The disease: a strategy is a *file*, not a *config row*.**

Verified consequences of that one design choice:

- 380+ strategy files encode **15–18 distinct trading ideas**. `cheetah-1910.js` vs
  `cheetah-1911.js` differ by **4 diff lines out of 236**.
- Every new client or variant costs a new file, a pm2 process, a full LoopBack boot and a
  Kite websocket. Measured: **150/156** boot LoopBack, **147/156** open their own websocket.
- Because logic is fused to live I/O, a strategy's decisions cannot be replayed or verified
  offline at all — the only way to know what one does is to run it live.
- A bug fix must be applied N times. `otmSelector` (§M2 of `07-verified-risks.md`) is one
  helper silently changing behaviour across 104 files.

**A one-for-one port of 380 files to TypeScript would faithfully preserve all of this.** It
would be months of work for a codebase that is still fundamentally unmaintainable.

**The proposal instead:** make the ~18 ideas into parameterized strategy classes, and make
every one of the 380 files a **config record**. This preserves every behaviour you've built
(as data, which is auditable and diffable) and collapses the process sprawl.

Your own newest code already proves the pattern works. `server/slive/orb-fut-core.js`
exposes `module.exports = function startOrbFut(config)`, and `orb-fut-{bn,nifty,snx}.js` are
**7-line config wrappers** around it. That is the target architecture, already validated in
your codebase. The overhaul is the act of applying it to the other 150 files.

## 2. Target architecture

A pnpm-workspace TypeScript monorepo:

```
apps/
  api/          Fastify + TS          — replaces LoopBack 3 REST
  web/          React + Vite + TS     — replaces client_wc / build_wc
  marketdata/   ONE Kite websocket    — fans out ticks to all consumers
  runner/       hosts N strategies    — replaces ~150 pm2 processes
  scheduler/    cron + lifecycle      — replaces ob_start / xtsOrder launching
packages/
  strategy-kit/ StrategyBase + the golden-master port-verification harness
  strategies/   ~18 parameterized ideas
  brokers/      zerodha | xts | fyers | spark behind one interface
  domain/       zod schemas + mongoose models (shared types, one source of truth)
config/
  strategies/   the 380 files, as config records
```

Four structural changes, in order of value:

**(a) Strategy = class + config.** ~18 classes replace ~380 files. The five config axes are
already visible in the existing code: *underlying* (token + strike step), *OTM/ATM offset*,
*stop-and-target basis* (fixed %, trailing %, fixed points, premium-target), *position sizing*
(flat / pyramid-up / pyramid-down / martingale), and *execution rail* (simulated / live).

**(b) One market-data service.** A single Kite websocket, fanned out over Redis pub/sub (or an
in-process emitter while single-host). Removes ~150 websockets and ~150 LoopBack boots.

**(c) The order bus becomes explicit and typed.** Today the bus is an untyped MongoDB
collection misleadingly named `paper-trade`, and whether an order is real depends on which
daemons happen to be running (§2 of `01-system-overview.md`). Replace with an explicit
`OrderIntent` type carrying a **required `mode: 'sim' | 'live'`** field, so simulated and real
orders can never be confused again. **This alone removes an entire class of
accidental-real-money risk.**

**(d) Verifiable ports.** Strategies consume an abstract `MarketFeed`, so a ported strategy
can be driven over a recorded tick sequence and its emitted orders diffed against the legacy
file's. That is what makes migrating 15 strategies a test rather than a judgement.

*(Not a backtester. A research / P&L backtesting tool was considered and explicitly dropped
2026-07-25 at the owner's request. The replay mechanism exists solely to prove a port is
faithful.)*

## 3. Framework choices

**DECISION 1 — Backend API framework.**

> **CORRECTION (2026-07-25).** An earlier draft of this document dismissed LoopBack 4 as
> "effectively a dead end". **That was wrong.** Verified against the npm registry:
> `@loopback/core@7.0.14` and `@loopback/rest` were both published **2026-07-16** — nine days
> before this audit. LoopBack 4 is actively maintained. By contrast `loopback@3.28.0` (LB3, what
> you run) last saw a publish in **2024-07-09**. LoopBack 4 is a legitimate option and the table
> below is corrected.

| Option | For | Against |
|---|---|---|
| **LoopBack 4** (`@loopback/*` v7) | Actively maintained. TypeScript-native. **Preserves the model-driven workflow you actually rely on** — 25 models with auto-generated CRUD + OpenAPI/explorer. DI components give the restartable module structure you asked for. | LB3 → LB4 is a **rewrite, not an upgrade**: boot scripts → components/DI, model JSON → decorated TS classes, remote methods → controllers. Heavier; smaller ecosystem than Fastify. |
| **Fastify + TS + Mongoose** | Fast, minimal, few deps, easy to mount alongside LoopBack during migration | You hand-write REST for 25 models that LoopBack would generate for you |
| NestJS + TS | Opinionated structure, strong DI | Heaviest ceremony; least benefit for a single-developer system |
| Modernise LB3 deps in place | Cheapest | LB3 is EOL and unpublished since 2024; fixes nothing structural |

**Recommendation: LoopBack 4 for the dashboard API is defensible and probably the lower-effort
path**, precisely because auto-CRUD over 25 models is real work you'd otherwise redo by hand.
Fastify wins only if you want minimum dependencies.

**But the decision matters far less than it appears, because of the rule below.**

### The non-negotiable architectural rule

**The trading core must not depend on the web framework.**

This is the single worst property of the current system, and the direct cause of the ~150×
duplication: strategies `require('../server.js')` purely to reach `app.models`, so **every strategy
process boots an entire web application** — 150 LoopBack boots, 150 Mongo pools, 150 executions of
all 10 boot scripts.

In the new system, `packages/{core,indicators,bus,strategy-kit,strategies}` and
`apps/{marketdata,runner,scheduler}` must import **none** of the API framework. Data access goes
through a plain repository layer. Then the API framework choice is contained to `apps/api` and can
even be changed later without touching a single strategy.

**DECISION 2 — Frontend.** My recommendation: **React + Vite + TypeScript + TanStack
Query/Table + Tailwind + shadcn/ui**, with `lightweight-charts` for price charts. Rationale:
the app is dense tables + live-updating numbers, which is exactly TanStack Table/Query
territory. Svelte or Vue would work; React has the deepest ecosystem for financial tables.

**DECISION 3 — Keep MongoDB?** My recommendation: **yes.** It's working, the data is there,
and a database migration on top of an application rewrite is two risky projects at once.
Worth revisiting later for time-series P&L specifically.

## 4. What gets preserved

Non-negotiable — it is hard-won and must survive:

- **Every strategy's trading rules**, migrated as config and validated by golden-master
  replay (§6).
- `server/tools/optionInstruments.js` — the option-chain builder and expiry logic.
- `server/lib/fill-price.js` `resolveFill()` — including the symbol→token fallback that fixed
  the 2026-07-13 Dhan-migration bug. This is subtle, tested, and cost real debugging.
- `server/lib/option_greeks.js`, `scholes.js`, `option-pricing.js`.
- `common/models/manager.js` strategy lifecycle semantics.
- `common.js:780-891` `diff_strategy_pnl` — reconciles manual vs algo-tagged fills sharing a
  broker position. Genuinely hard logic, not boilerplate.
- The **pure-logic + `node:test`** convention you already adopted (`atr-band-logic.js`,
  `orb-fut-logic.js`) — this becomes the default, not the exception.
- `docs/superpowers/` specs and plans.

## 5. What gets deleted

Roughly **130 MB** of tracked payload, in risk tiers:

**Tier 1 — zero risk (~77 MB).** `client_am`, `client_ob`, `client_pd`, `build_am`,
`build_ob`, `build_pd`. Verified: zero references anywhere in live code.

**Tier 2 — safe after one fix (~28 MB).** `client/`, `build/` — but **first** repoint or
retire `package.json`'s `"sync"` script, which still targets `build/` (§M5).

**Tier 3 — dead server strata, needs your sign-off.** `server/tob` (66), `server/monks` (26),
`server/archive` + `xts` (36), `server/asmp` (23), `server/wealth` (14), `server/insta` (7),
`extra/` (12), and ~85 of 88 in `server/scripts` — **keeping `squareoff_smp.js`, which is
active.** Empty dirs: `server/standle`, `models`, `memphis`, `greeks`, `logs`.

**Tier 4 — needs a decision, do not delete.** The 108 `server/smp` files with no `slive`
twin (§7 of `01-system-overview.md`).

Note: deleting from the working tree does **not** shrink `.git` (74 MB). That needs a history
rewrite, which should happen **after** credential rotation anyway.

## 6. How we avoid breaking a system that trades real money

**Strangler-fig, never big-bang.** The old system keeps running throughout; new services are
introduced alongside and cut over one at a time.

**Golden-master replay is the safety net.** Before a ported strategy is trusted:

1. Record live ticks for a session.
2. Replay through the old file and the new class+config.
3. Diff the emitted order intents. **They must match exactly.**

This turns "did I port 150 strategies correctly?" from a matter of faith into a test suite —
and it's only possible *because* the new design separates logic from I/O.

**Phase 0 must ship before any rewrite work.** It is small, high-value, and independent:

| Phase | Work | Why it's first |
|---|---|---|
| **0. Safety** | Delete the `/add_the_boss` backdoor (C1); rotate the 4 Atlas credentials (C2); move secrets to env; remove `eval` (H1); restore a lockfile; wire `npm test`; un-ignore `/server/` in eslint; fix M3's Thursday crash | Cheap, no architecture dependency, closes the actual dangers |
| **1. Ground truth** | Fresh `pm2 jlist` from prod; answer the 6 open questions in `07-verified-risks.md`; decide the `smp` reconciliation | **Blocking.** Don't port what isn't running |
| **2. Cleanup** | Tier 1–3 deletions | Shrinks the surface before touching it |
| **3. Foundation** | Monorepo scaffold, `domain` package (zod + mongoose mirroring the 25 models), CI. LoopBack keeps serving | Zero user-visible change |
| **4. Market data + runner** | One websocket; port the 4 modern strategies first (they're already logic-split); run **in parallel** with the old ones and diff | Proves the model on your best code |
| **5. Strategy migration** | Remaining ideas → classes; the 380 files → configs; golden-master each | The bulk; incremental and verifiable |
| **6. Frontend** | React app, route by route, against the new API | Old dashboard stays up until parity |
| **7. Decommission** | Retire LoopBack, `slive`, `smp` | Only when nothing depends on them |

Phases 0–2 are worth doing **regardless** of whether you approve the rewrite.

## 7. Honest assessment of cost and risk

**This is a large project.** Phases 3–7 are a multi-month effort for one developer. I'd rather
say that plainly than have it discovered in month two.

**The main risk is a half-finished migration** — two systems, both live, neither authoritative.
Mitigations: strict phase gating, the old system authoritative until golden-master parity, and
every phase independently valuable if you stop there.

**A legitimate alternative** if appetite is lower than the plan assumes: do **Phase 0 + 2 only**
(security, cleanup, tooling), then adopt the `orb-fut-core.js` factory pattern for *new*
strategies only, letting the legacy files age out naturally. Much cheaper, no rewrite risk,
but the ~150-process ceiling stays.

**DECISION 4 — appetite.** Full overhaul (phases 0–7), foundation-only (0–4, keep old
strategies running), or minimal (0 + 2)?

## 8. What I recommend

1. **Do Phase 0 now**, this week, independent of any other decision. The backdoor and the
   database credentials are real and cheap to fix.
2. **Then Phase 1** — get ground truth on what runs in production. Everything downstream
   depends on it, and only you can supply it.
3. **Then decide** on DECISION 4 with real information in hand, rather than committing to a
   multi-month rewrite up front.

The one thing I'd push back on: don't start with the frontend. It's the most visible layer and
the most tempting, but it's also the least dangerous part of the current system. The backdoor,
the credentials, and the ambiguity about which orders are real are what deserve attention
first.
