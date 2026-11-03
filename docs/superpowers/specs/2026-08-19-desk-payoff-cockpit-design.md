# Desk payoff cockpit — payoff analyzer + goal-driven repairer — design

**Date:** 2026-08-19
**Repos:** `algomaker` (everything new lives here) and `algo-engine/sensibull-desk`
(source of the cloned algorithms; one small rules-engine patch)
**Status:** design settled with the operator (grilling session 2026-08-19); not built.

## Why

recenter-relief-r manages the live books by moving delta/gamma; the humans
supervise and adjust what it misses. Today the supervisors are blind on shape:
one book hit target and was closed, two are open and drifting, premium is being
added to drag them to profit by expiry — with no payoff curve, no max-loss /
max-profit at a given price or %, and no ranked repair ideas. Sensibull's
builder/analyzer must not be the answer: **no third-party analytics anywhere**.
All math in-house on **Black-76 off the traded future**; data only from our own
pipes (Kite feed, own chain endpoint; the Kite basket-margin endpoint counts as
our own pipe).

## Decisions

| | |
|---|---|
| Scope | Analyzer + repairer built together |
| Curves | Expiry intrinsic + T+0 + mid-date, one chart |
| P&L basis | Whole book since entry: `realised` shifts the whole curve; booked component labeled |
| Markers | ₹0 and the book's `target_pnl` both drawn |
| Table rows | Every strike, breakeven, spot, ±1/2/3/5/8% |
| Vol model | Sticky-strike: per-leg IV solved from live quotes (Black-76 bisection), held across the price scan; neighbor-interpolated for junk quotes |
| Expiries | Single nearest-monthly only (engine generic; mixed-expiry deferred) |
| What-if overlay | v1: hypothetical legs vs current book on one chart; repair plans load into it; placement via existing Manual Order path |
| Machine-mind panel | v1: bot's steering Δ/Γ, dials, distance-to-trigger, next action if idle, its reason strings |
| Repairer goals | REDUCE-LOSS · PROFITABLE-BY-EXPIRY (≥₹0, target as 2nd marker) · CHEAP-TAIL-CAP · MAX-CREDIT-SAFE |
| Combo search | Multi-move (add/shift/hedge/close), max 4 moves per plan, top 3 plans per goal |
| Candidate dials | adds 15–35Δ, shifts to 20–30Δ, hedges ≤10Δ capped ~20% of open credit; liquidity-filtered; all per-book dials |
| Plan columns | credit, new max loss & where, new breakevens, worst_shock, margin delta |
| Margin numbers | SPAN-lite estimate during search; **real Kite basket call** to verify the plan loaded into the overlay |
| Authority | Suggest-only; conflict **flags** vs bot triggers (no bot simulation in v1) |
| Manual/repair legs | **Adopted** into the book with a per-leg `protected` flag: in the bot's net greeks, untouchable by its shift/close logic — a small sensibull-desk rules-engine/driver patch (the only cross-repo change) |
| Language | **TypeScript port** (clone-and-adapt; algo-engine untouched). New `black76` module in `packages/greeks` (gfdl conventions: theta/day, vega/vol-point). **Golden parity tests** vs sensibull-desk Stack B numbers |
| Pricing stacks | Stack A's spot-BS dropped entirely; Stack A candidate grammar ported onto the Black-76 core |
| Surfaces | Routes `/v1/desk/payoff` + `/v1/desk/repair` in desk-api → panel on `#/positions/TAG` (recharts, ~60s auto-refresh) + thin `bin/` CLI (on-demand). Engine+CLI first, panel right after |
| Persistence | Every snapshot → new Mongo collection `desk-payoff-snapshots` (no history UI yet) |
| Deferred (v1.5+) | IV-shift columns, floor/breakeven alerting, bot simulation, mixed expiries, history UI |

## What gets cloned from sensibull-desk (the port map)

Two repair stacks exist there. **Stack B** (`sensibull_tools/sim/optimizer/*`)
is the numerical core to port — already fully local, Black-76 off the future,
the same math the live rule engine uses. **Stack A** (`sensibull_tools/basket/*`)
contributes its richer candidate grammar but its spot-BS pricing and every
Sensibull call (chain fetch, IV snapshot, builder what-ifs) are dropped.

Port sources (file:line in `algo-engine/sensibull-desk`):

- Black-76 price/greeks/IV: `sensibull_tools/gfdl/greeks.py` — `price` :49,
  `greeks` :53, `implied_vol` :96 (bisection bounds 1e-4..5.0).
- Price×date surface + worst_shock: `sim/optimizer/surface.py:133`
  (`worst_shock` = min P&L at spot×{0.90,0.95,1.05,1.10}, :181-183); richer
  cell grid shape in `basket/surface.py:112` (cells + per-greek cells,
  breakevens, POP, booked shift at :149).
- Exact expiry payoff/breakevens: `sim/book.py` — `expiry_pnl_at` :62,
  `expiry_breakevens(legs, spot, realized=)` :85 (realized shifts the curve).
- SPAN-lite margin estimate: `sim/margin.py` — `_span_core` :81,
  `portfolio_margin` :158 (7 price × 3 vol scenarios).
- Candidate grammar: `basket/candidates.py:126 generate_candidates`
  (add-premium, rolls, close, protect, verticals, ratio, fly, strangles,
  sell-to-floor, 2-move combos; cap 40) + `sim/optimizer/generate.py:114`
  (futures hedges, lot ladders). The goal-driven ≤4-move beam search is **new**.
- Leg model reference: `sim/optimizer/legs.py:1-16` (side/lots-positive
  convention) — algomaker's `BridgeLeg` (`apps/api/src/contract.ts:120`) uses
  signed qty; the port adapts to BridgeLeg.

## What algomaker already provides (reuse, don't build)

- Book legs + realised: `GET /v1/desk/positions?tag=&mode=`
  (`apps/api/src/service.ts:1304`) — legs, greeks, steering, spot, `realised`.
- Registry dials incl. `target_pnl`, `shift_margin_frac`:
  `desk-books-registry` (`apps/api/src/books-registry.ts:41`).
- Bot's declared steering Δ/Γ: `desk-declarations` (`apps/api/src/store.ts:180`);
  reason strings via `GET /v1/desk/books/registry/{tag}/decisions`.
- Chain quotes, whole expiry auto-subscribed for open books:
  `GET /v1/desk/chain/:underlying?expiry=` (`apps/api/src/chain.ts:66`;
  `DESK_FULL_CHAIN=1`). Future price via `OptionMaster.future()`
  (`packages/instruments/src/master.ts`).
- BS + bisection IV + carryYield: `packages/greeks/src/index.ts` (extend with
  explicit `black76`, don't lean on carryYield).
- Single-point payoff + breakevens (web): `apps/web/src/positions.ts:508,:569`.
- Hypothetical-basket margin: `apps/marketdata/src/book-margin/`
  (`basket.ts basketOrders(legs)`, Kite BASKET_URL in `kite.ts:38`).
- Charting: `recharts` already in `apps/web` (`src/chart.tsx` pattern —
  theme tokens via `useTheme().token()`).
- Placement seam: Manual Order dialog (`apps/web/src/manual-order.tsx`) +
  `POST /v1/desk/submit`.

## Known hazards to respect

- Mixing spot-BS and future-Black-76 already caused a production net-delta
  sign-flip (`sensibull-desk live/desk/translate.py:759`). One math stack only.
- `gamma_shorts_only`/`delta_shorts_only` is set on every live relief-r book —
  the machine-mind panel must show shorts-only steering greeks, not whole-book.
- Dashboard flatten of bot-managed legs diverges ledgers (see mirror-sync
  incident); hence adopt-with-`protected`, never a parallel manual sleeve.
