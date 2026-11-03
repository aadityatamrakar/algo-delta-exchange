# SMPv2 API contract — Phases A, B, C

**Date:** 2026-07-27
**Status:** binding. Backend and frontend are built in parallel against this file.

This exists because the API and the dashboard are being implemented at the same time by
different people. Anything ambiguous here becomes a mismatch nobody notices until the page is
blank. Where a shape is already implemented, it is recorded rather than redesigned.

## 0. Conventions

- All bodies are JSON. All timestamps are **epoch milliseconds**, never strings.
- All dates are **IST calendar days** as `YYYY-MM-DD`. The host may run on UTC; a 15:30 IST fill
  must file under its own trading day. Use `istDate()` / `istDayRange()` from `routes/kit.ts`.
- Errors: `{ "error": "<human sentence>" }` with a 4xx/5xx status. Never a bare string.
- `mode` is `paper` | `live`, always explicit in a query string; it defaults to `paper` when absent.
- Money is a number in rupees. Quantities are **units**, not lots, unless the field says `Lots`.
- A number that could not be computed is `null`, never `0`. This rule is the reason the positions
  endpoint carries `complete`; every new endpoint that aggregates keeps the same discipline.

## 1. Auth (Phase A)

```
POST /v1/auth/login     { username, password }
  200 { token, username, expiresAt }
  401 { error: "invalid credentials" }        // never says which half was wrong
  429 { error: "too many attempts, locked until ...", lockedUntil }

POST /v1/auth/logout    -> 200 { ok: true }
GET  /v1/auth/me        -> 200 { username, kind: "user"|"machine", expiresAt: number|null }
                           401 when the session is absent or expired
```

`login` and `logout` are mounted as **public** routes. `me` is authenticated.

A session token is presented exactly like the machine token: `Authorization: Bearer <token>`.
The gate tries the session store first and the env bearer second, so the Python desk keeps
working unchanged.

**Re-authentication.** Two actions require the operator's password again in the request body as
`password`, and return `403 { error, reauthRequired: true }` without it:

- `POST /v1/desk/killswitch` with `enabled: false` (releasing the halt)
- `PATCH /v1/desk/strategies/:tag` that leaves the row **enabled and live**

Both are already wired in `routes/desk.ts` and call `gate.reauth(principal, body.password)`.
A `machine` principal can never satisfy `reauth`.

## 2. Brokers (Phase A)

```
GET  /v1/desk/brokers
  200 { brokers: [ { kind, label, meta, configured, state, lastVerifiedAt, lastError } ] }

PUT  /v1/desk/brokers/:kind      { label?, meta?, secret: { ...credential fields } }
  200 { ok: true, kind }

POST /v1/desk/brokers/:kind/test
  200 { ok: true,  verifiedAt }
  200 { ok: false, error: "<broker's own message>" }     // a failed LOGIN is not a failed REQUEST
```

- `kind` is `xts` | `zerodha`.
- `state` is `absent` | `ok` | `error` | `unreadable`. **`unreadable` is distinct from `absent`** —
  "no XTS configured" and "XTS configured but the ciphertext will not open" need different
  responses from the operator.
- `configured` is a boolean convenience for the UI.
- **No response ever contains a secret field, at any status, ever.** `meta` holds only
  non-sensitive values (base URL, user id). This is the single testable invariant of this module.
- `secret` omitted or `{}` on PUT **leaves the stored credential untouched**, so the form can save a
  label change without the operator retyping a password.

## 3. P&L (Phase B)

```
GET /v1/desk/pnl?mode=paper
  200 { asOf, mode, strategies: [ {
          tag, label, mode, realised, unrealised: number|null, total: number|null,
          openLegs, unpriced: string[], complete: boolean
        } ],
        totals: { realised, unrealised: number|null, total: number|null, complete: boolean } }

GET /v1/desk/pnl/series?tag=&mode=&from=&to=
  200 { tag, mode, points: [ { ts, realised, unrealised, total } ] }
```

`unrealised` and `total` are `null` when any open leg could not be marked, with the offending
symbols named in `unpriced` and `complete: false`. Phase B §8: a P&L of ₹0 and a P&L of "three
legs could not be marked" must never render identically.

`from`/`to` are epoch ms; both optional, defaulting to the current IST day.

## 4. Reports (Phase B)

```
GET  /v1/desk/reports?date=YYYY-MM-DD
  200 { date, rows: [ { tag, mode, realised, total, maxProfit, maxLoss,
                        orderCount, closingPositions, writtenAt, source } ],
        totals: { realised, total, orderCount } }

GET  /v1/desk/reports/orders?date=YYYY-MM-DD&tag=&failures=
  200 { date, events: [ <desk-order-events row> ] }

GET  /v1/desk/reports/dates
  200 { dates: string[] }       // days that have activity, newest first — populates the picker

POST /v1/desk/reports/prune     { dryRun: boolean, keepDays?: number }
  200 { wouldDelete | deleted: number, days: [ { date, snapshots, action, reason } ] }
```

`source` is `rollup` when the row came from `desk-daily-reports` and `computed` when it was
recomputed from fills because the rollup was missing. A rollup missed while a process was down
must be **repairable, not a permanent hole** (Phase B §5), so the endpoint recomputes and says so
rather than showing a blank row.

`prune` **never deletes a day whose rollup has not been written**, and reports each skipped day
with its reason. `dryRun: true` mutates nothing.

## 5. Submit (Phase C)

```
POST /v1/desk/submit
  { tag, mode, clientOrderId, instrument: { tradingsymbol, instrumentToken?, lotSize?, exchange? },
    side: "Buy"|"Sell", lots, orderType?: "MARKET"|"LIMIT", limitPrice?, triggerPrice?,
    reducesExposure?: boolean, meta? }

  200 { accepted: true,  clientOrderId, orders: [ { clientOrderId, qty } ] }   // freeze tranches
  200 { accepted: false, clientOrderId, reason: "<which gate refused, by name>" }
  403 { error }   // unregistered tag only — same rule as /actions
```

`clientOrderId` is the caller's idempotency key, exactly like `decisionId` on `/actions`: the same
id submitted twice places once and replays the first answer.

A refusal is `accepted: false` **with 200**, not a 4xx — the request was processed and the body says
precisely what happened, and a 4xx would invite the strategy to retry an order that may have partly
routed.

Gates applied, in this order, each naming itself in `reason`: unknown tag (403) → strategy switch →
kill switch (new exposure only) → live allowlist → freeze split.

## 6. Strategies (Phase A, extended in C)

Already implemented; Phase C only adds fields.

```
GET   /v1/desk/strategies         -> { strategies: StrategyRow[] }
PATCH /v1/desk/strategies/:tag    -> StrategyRow | 404

StrategyRow = { tag, kind: "external"|"hosted", label, enabled, mode, liveLots,
                autostartAt, lastSeenAt, disabledReason, updatedAt }
```

Phase C adds, read-only, to the GET response only:

```
runtime?: { state: "stopped"|"waiting"|"running"|"squared-off"|"failed",
            startedAt: number|null, lastError: string|null, openPositions: number }
```

`runtime` is **absent** for `external` rows. We do not supervise Python processes and must not
render a state we cannot observe.

## 7. Frontend routes

Hash routing, as today. `apps/web/src/shell.tsx` owns the table.

| Route | Page |
|---|---|
| `#/paper`, `#/live` | book tabs per stock (exists) |
| `#/strategies` | registry: on/off, mode, live lots, autostart, last seen |
| `#/strategies/:tag` | that strategy's positions, order log, intraday P&L chart |
| `#/reports` | date picker → rollup table → order log → chart |
| `#/brokers` | XTS and Zerodha cards, edit and test |
| `#/orders`, `#/feed`, `#/controls` | exist |
| `#/login` | reached by the auth gate, not by the nav |

---

# Addendum — 2026-07-27b: per-mode strategy switches

Requested by the operator: **a strategy can run in paper and live at the same time**, the
registry list will grow so it shows **only what is switched on**, new rows are added **from a
form**, and **paper and live are separate pages so it is unambiguous which one you are looking
at**.

## 1. `mode` + `enabled` become `modes`

```ts
StrategyRow = {
  tag, kind: 'external' | 'hosted', label,
  modes: { paper: boolean, live: boolean },   // REPLACES `enabled` and `mode`
  liveLots, autostartAt, lastSeenAt, disabledReason, updatedAt,
  runtime?: { ... }                           // hosted rows only, never external
}
```

`enabled`/`mode` cannot survive alongside `modes` as an alias. Two fields that can disagree about
whether live trading is on is precisely the state a gate must never have to arbitrate — and the
re-auth bypass already fixed once in this file came from exactly that kind of split. Reading a
stored document maps the old pair forward:

```
modes.paper = enabled && mode === 'paper'
modes.live  = enabled && mode === 'live'
```

A row that cannot be read maps to `{ paper: false, live: false }`. Every unreadable field falls
back to the SAFE value; a half-written row is not a permission to trade.

## 2. Gating is per mode

`gateStrategy(tag, row, mode)` allows only when `row.modes[mode] === true`. The asymmetry with the
kill switch is unchanged: the strategy switch blocks **exits too**, and `close-all` remains the
operator's exemption.

`/v1/desk/submit` keeps its separate check that the ROW permits the mode the request states — a
caller holding a stale mode must not route on it.

## 3. API

```
GET  /v1/desk/strategies?mode=paper|live   only rows with modes[mode] === true
GET  /v1/desk/strategies?all=1             every row — the management surface
GET  /v1/desk/strategies/available          catalogue tags with no row yet, for the add form

POST /v1/desk/strategies                    { tag, kind, label?, autostartAt?, liveLots? }
  201 -> the created row, ALWAYS { paper: false, live: false }
  409 -> tag already registered
  400 -> kind 'hosted' with a tag the runner has no implementation for

PATCH /v1/desk/strategies/:tag              { modes?: {paper?, live?}, liveLots?, autostartAt?,
                                              disabledReason?, password? }
```

**A created row is switched OFF in both modes.** Creating a row and granting it permission to
trade are separate acts; a form that did both would make a typo a live order.

**`POST` exists now, and the old "there is no POST" reasoning is superseded** — but only its
conclusion. The reason behind it stands and is why `kind: 'hosted'` is validated against the
runner catalogue: a hosted row whose tag no implementation matches is a switch that looks armed
and runs nothing.

**Turning `modes.live` ON still requires the password** (§1 re-auth). Turning `modes.paper` on does
not — it cannot move money.

## 4. Frontend

Paper and live strategies are **separate pages**, matching how books already work: "am I looking at
real money?" is answered by where you are, not by a control you have to notice.

| Route | Page |
|---|---|
| `#/strategies` | strategies switched on for PAPER |
| `#/strategies-live` | strategies switched on for LIVE, badged red |
| `#/strategies-all` | every registered row + the add form — the management surface |
| `#/strategies/:tag` | one strategy: positions, order log, P&L chart |

The two mode pages list **only rows switched on for that mode**, because the registry will grow
well past what is useful to scroll. Everything else lives on the management page.

A row switched on for both appears on both pages. That is the point of the change, not a bug to
de-duplicate.
