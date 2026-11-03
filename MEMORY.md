# Project Memory — algomaker

Durable, verified facts about this codebase. Written for humans **and** for future AI sessions.
One file per fact; each carries the evidence (`file:line`) so it can be re-checked rather than
trusted.

Compiled 2026-07-25 from a full-codebase audit, extended 2026-07-27. Narrative documentation lives
in `context/`; this directory holds the distilled, high-recall facts.

> **Read [Desk bridge — the NEW system](memory/desk-bridge-new-system.md) first.** As of 2026-07-27
> the owner chose a **full cutover**: the old `server/` system is discarded, not strangled, and no
> further fixes go into it. The facts below about the legacy codebase remain accurate and are worth
> knowing — but they describe a system being retired, not one being maintained.

## Index

- [Desk bridge — the NEW system](memory/desk-bridge-new-system.md) — **2026-07-27 full cutover.** Python (`sensibull-desk`) owns all trading logic; algomaker is a bridge + dashboard. `apps/api`, `apps/marketdata`, `apps/order-gateway`, `apps/web`. Includes the hard-won operational facts: 30s stock-option tick cadence, index spot naming, inferred strike steps, the NSE freeze-limit formula.
- [Order bus, not paper trading](memory/order-bus-not-paper-trading.md) — `PaperTrade` is the order bus; `xtsOrder`/`sparkOrder`/`fyersOrder` forward bus orders to **real brokers**. Sim-vs-live depends on which daemons run, not on strategy code. **Read this first.**
- [Repo topology: live vs dead](memory/repo-topology-live-vs-dead.md) — which dirs are live vs abandoned strata; `smp` is staging and `slive` is production; `dump.pm2` is a stale 2023 snapshot and must not be used as an inventory
- [Strategy sprawl and config axes](memory/strategy-sprawl-and-config-axes.md) — 380+ files encode only 15–18 ideas; the 5 config axes; `orb-fut-core.js` is the proven factory pattern
- [otmSelector returns zero](memory/otm-selector-returns-zero.md) — 87 of 93 call sites get `0`, so "OTM" sellers trade ATM; `SD_2` returns `undefined` on Thursdays and crashes 6 files
- [Security: backdoor and secrets](memory/security-backdoor-and-secrets.md) — unauthenticated `/add_the_boss` superadmin route; 4 Atlas URIs with passwords in git; `eval()` in the browser
- [In-memory datasource data loss](memory/inmemory-datasource-data-loss.md) — 7 models on a memory connector lose everything on restart, including `strategyPNL`
- [Frontend: builder routes broken](memory/frontend-builder-routes-broken.md) — 5 router states ship without their controller and throw in prod; `npm run sync` targets the dead `build/`

## Cross-references

Project memory is **version-controlled here**, in this directory — that is the source of truth.
Claude Code also keeps a session-scoped copy under
`~/.claude/projects/-Users-aaditya-Documents-dev-algomaker/memory/` for automatic recall; it points
back here rather than duplicating content, so the two cannot drift.

Two of those session notes predate the audit, remain accurate, and are worth reading alongside this
directory:

- `slive-strategy-conventions.md` — the strategy template, `node:test` runner, pm2 process model,
  pure-logic split, `optionConfig` usage, the login-on-load convention, and the autostart registry
- `paper-options-fill-flow.md` — how the **simulator** consumer prices fills. Still accurate, but
  narrower than it appears: see [Order bus, not paper trading](memory/order-bus-not-paper-trading.md),
  which supersedes its framing.
