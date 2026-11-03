---
name: security-backdoor-and-secrets
description: "Unauthenticated /add_the_boss superadmin route in boot/tradelab_auth.js; 4 Atlas URIs with passwords committed; eval() in client socket.js; private repo limits exposure"
metadata:
  type: project
---

Audited 2026-07-25. Repo is **private** on GitHub (`isPrivate: true`, pushed 2026-07-17), so
exposure is to anyone with repo access — not the public. Serious, not an emergency.

> **Paths moved.** Commit `edd08446` ("archive the retired system") relocated the whole legacy tree
> from `server/` to `archive/server/`. Everything below is still tracked and still in history —
> only the prefix changed. Prepend `archive/` to each `server/...` path.

## Critical 1 — unauthenticated superadmin backdoor
`server/boot/tradelab_auth.js:74`

```js
router.get('/add_the_boss', (req, res) => {
  Client.create({ realm: "admin", id: "<fixed>", superadmin: true, live: true, ... })
```

No auth guard. In `server/boot/`, so `loopback-boot` registers it on **every** app start. Anyone
who can reach the dashboard port can mint an admin account by visiting one URL. Only `server.js`
calls `listen()`, so blast radius is that one port — the dashboard's.

**Fix:** delete the route. If bootstrap-admin is needed, make it a CLI script.

## Critical 2 — live DB credentials in git
Four MongoDB Atlas connection strings **with embedded passwords**, at HEAD and throughout history:
`server/datasources am.json:9`, `server/datasources ob.json:9`, `server/datasources smp.json:9`,
and `todo:53` (which also holds **3 plaintext broker passwords and a 2FA seed**).
`server/datasources.json` has a password too (host blank).

**Fix order matters:** rotate first, then move to env vars, then purge history. History rewriting
does not un-leak an exposed password.

## High — `eval()` of server-pushed data in the browser
`client_wc/js/services/socket.js:25` and `:104` call `eval(resp)` on a socket.io payload. Combined
with the backdoor above (anyone can become admin), that's a realistic RCE-in-the-dashboard chain.
Replace with an explicit message-type switch.

## Other hardcoded secrets
`server/boot/tradelab_auth.js:26` broker `clientId` (**runs on every boot, in all ~150 processes**) ·
`server/lib/notify.js` Telegram token · `server/lib/s3upload.js` AWS keys ·
`server/tools/daily_report.js` SendGrid key · `server/tools/tradelab_login.js` broker creds ·
`common/models/client.js:217` hardcoded weak reset password ·
`server/userdata/*.json` 4 Zerodha session cookies incl. `enctoken` (force-added over a later
`.gitignore` rule; expire daily so almost certainly dead) · `README.md:10-11` Jainam demo appKey/secretKey

## False positives — do NOT re-report
- ~30 `token` hits in `extra/diff_strategy.js` are numeric `instrument_token` values.
- `api_key: 'kitefront'` is Kite's **public** web API key, not a secret.

## Also
`.eslintignore` excludes **`/server/`** — the project's only linter has never checked any strategy
or broker code.

**How to apply:** this is Phase 0 of `context/08-overhaul-proposal.md` — cheap, no architectural
dependency, and worth doing regardless of whether the rewrite is approved.
