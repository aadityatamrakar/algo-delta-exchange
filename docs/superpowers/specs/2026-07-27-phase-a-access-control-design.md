# Phase A — Access & control — Design Spec

**Date:** 2026-07-27
**Status:** approved in brainstorming
**Depends on:** nothing. First to build.

## 1. Purpose

One login guards the service. Broker credentials move from `.env.local` into Mongo, encrypted.
Every trading source — the Python desk today, hosted strategies later — gets an on/off switch from
the portal.

## 2. Locked decisions

| # | Decision |
|---|---|
| A1 | **Single operator, single broker account.** No tenancy, no per-account lot allocation. |
| A2 | **Internet-facing, password only.** No TOTP. See the risk note in §7. |
| A3 | Broker credentials **encrypted at rest**; the key lives in env, never in Mongo. |
| A4 | A disabled strategy's orders are **rejected immediately with a reason**, never queued. |
| A5 | Strategy parameters are hardcoded in strategy files and are **not editable from the UI**. |

## 3. Components

### `packages/secrets`

AES-256-GCM seal/open. Key from `DESK_MASTER_KEY`.

- Ciphertext carries its own IV and auth tag, so a tampered record **fails to open** rather than
  decrypting to garbage.
- Refuses a key that is not 32 bytes rather than padding one.
- The key is env-only. If it lived in Mongo, the database alone would be a full compromise.

### `packages/auth`

- argon2id password hashing.
- Session token mint/verify, short-lived.
- Login rate limiter with lockout.

Pure functions over injected time and randomness, so expiry and lockout are testable without
waiting.

### Collections

```
desk-users      { username, passwordHash, createdAt, lastLoginAt, failedAttempts, lockedUntil }
desk-sessions   { token, username, createdAt, expiresAt, lastSeenAt }
desk-brokers    { kind: 'xts'|'zerodha', label, secret: <sealed>, meta, updatedAt,
                  lastVerifiedAt, lastError }
desk-strategies { tag, kind: 'external'|'hosted', label, enabled, mode, liveLots,
                  autostartAt, lastSeenAt, disabledReason, updatedAt }
```

`desk-brokers.secret` is the whole credential blob sealed as one value. `meta` holds only
non-sensitive fields (base URL, user id) so the Brokers page can render something useful without
opening anything.

`desk-strategies` starts with `external` rows only (one per Python book). Phase C fills in
`hosted` rows for the runner, reusing the same row — strategy management is one surface, not two.

## 4. The strategy switch

Enforced inside `applyDecision`, at the same point as the kill switch. An action from a disabled
tag returns as a skip: `"strategy DESK_BHEL is disabled"`. Nothing queued, nothing routed, every
rejection journalled to `desk-order-events` so the portal shows what was blocked while it was off.

Three gates now stack, with deliberately different scopes:

| Gate | Blocks | Exits still allowed? |
|---|---|---|
| Strategy switch | one strategy, both modes | **no** — off means off |
| Kill switch | new exposure, all strategies | yes |
| Live allowlist | live routing only | n/a |

The strategy switch is the one that *does* block exits: "stop this strategy trading" means exactly
that. Flattening is `close-all`, a deliberate operator action that runs as you, not as the strategy.

**An unknown tag is rejected**, never implicitly allowed — a Python client with a typo in its tag
must fail loudly rather than trade under a name nobody configured.

## 5. API

```
POST /v1/auth/login          { username, password } -> session token
POST /v1/auth/logout
GET  /v1/auth/me

GET  /v1/desk/brokers                 ALWAYS redacted — no endpoint ever returns a secret
PUT  /v1/desk/brokers/:kind           store credentials (sealed on write)
POST /v1/desk/brokers/:kind/test      real login; records lastVerifiedAt / lastError

GET   /v1/desk/strategies
PATCH /v1/desk/strategies/:tag        enabled, mode, liveLots, autostartAt
```

`test` performing a real login is what makes "are my credentials right?" answerable from the UI
instead of by restarting a process and reading logs.

**Re-authentication is required** for the two dangerous actions: enabling a live tag, and releasing
the kill switch. This is the compensation for A2 — password-only means a single leaked password is
full control, so the two paths that can move real money ask for it again.

## 6. Consumers

`apps/marketdata` and `apps/order-gateway` read credentials from Mongo at boot, falling back to env
when absent. The fallback keeps the current working setup alive during the transition and is
deleted once credentials have been entered through the UI.

## 6b. Frontend (`apps/web`)

Each phase ships its own UI. Phase A adds three surfaces plus a gate.

**Login page.** Username + password. On success the session token is held in memory and refreshed
on activity, not written to `localStorage` — a token in local storage is readable by any script
that ends up on the page, and this one can move money. A failed login says only "invalid
credentials", never which half was wrong.

**Auth gate.** Every existing route redirects to login when there is no valid session, and a 401
from any call drops back to it. The gate wraps the router rather than each page, so a page added
later cannot forget to be protected.

**Brokers page.** One card per broker (XTS, Zerodha) showing label, non-sensitive `meta`, and
`lastVerifiedAt` / `lastError`. Editing opens a form that WRITES credentials but never displays
them — the API cannot return a secret, so the field is always blank on open and an empty submit
leaves the stored value untouched. A "Test connection" button calls the test endpoint and shows the
real result, which is what makes "are my credentials right?" answerable without reading logs.

**Strategies page.** The list from `desk-strategies`: tag, kind, enabled toggle, mode, live lots,
autostart time, last seen. This is the on/off switch, and it is the immediately useful part — the
Python desk is running today and currently has no way to be stopped from the portal.

Enabling a **live** tag and releasing the kill switch both prompt for the password again (§5). The
prompt states plainly what is about to become possible.

Nothing on these pages edits strategy parameters (A5).

## 7. Error handling

- A missing or malformed `DESK_MASTER_KEY` **fails at boot**, loudly. Starting with unopenable
  credentials would surface later as a confusing broker error.
- A credential that will not open is reported as a broker in `error` state, never as absent:
  "no XTS configured" and "XTS configured but unreadable" need different responses.
- Login failures are rate-limited and locked out; the response does not distinguish unknown user
  from wrong password.

**Risk note (A2).** Password-only was chosen over password + TOTP. A single leaked or guessed
password is full control of a live trading account, including `close-all` and live order routing.
Mitigations built in: argon2id, rate limiting with lockout, short sessions, and re-authentication
on the two dangerous actions. Adding TOTP later is additive and does not change these interfaces.

## 8. Testing

- seal/open round-trip; tampered ciphertext rejected; wrong key rejected; short key refused.
- password verify; lockout after N failures; session expiry on an injected clock.
- Integration: the brokers endpoint **never** emits a secret field.
- Disabled tag rejects and journals; enabled tag passes; unknown tag rejects.
- The strategy switch is independent of the kill switch — each blocks on its own.
- Disabling does **not** retroactively affect an already-routed order.
- UI: an unauthenticated route redirects to login; a 401 mid-session returns to login; the broker
  form never renders a secret and an empty submit does not overwrite one.

## 9. Out of scope

Multi-user, roles, tenancy. TOTP. Supervising external processes.
