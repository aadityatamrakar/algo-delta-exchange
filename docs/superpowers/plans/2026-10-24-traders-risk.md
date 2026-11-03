# Plan: traders risk (spec 2026-10-24-traders-risk-design.md)

Integration branch `feat/traders-risk`. Contract commit: the spec, `analytics/risk-wire.ts`, `VolRow.results`.
Every lane first runs `git merge --ff-only feat/traders-risk` in its worktree (worktrees start at the session head),
then `npm ci` (each worktree has its own node_modules). Run tests with `TRADERS_TEST_LANE=<lane>` so the Mongo suites
do not collide. Nothing reaches live ports or optionbhai. No lane runs pm2.

| Lane | Model | Owns | Depends on |
|---|---|---|---|
| A | Sonnet | `scripts/nse_vol_job.py` events step (R9), `--events-only`, tests + fixtures | — |
| C | Opus | `analytics/returns.ts`, `analytics/shock.ts`, `analytics/portfolio-risk.ts`, `routes/risk.ts`, endpoint `risk.view` + ownership case, `get_risk` tool (risk half) (R2–R8, R15, R16) | — |
| B | Opus | `market/events-store.ts`, `analytics/event-risk.ts`, `routes/events.ts`, endpoint `events.view` + ownership case, `VolRow.results`, context field + prompt line, `results-ahead` alert (R9–R15), `get_risk` events half | C's `shock.ts` (B writes against the signature in spec §4; C lands first, B rebases) |
| D | Sonnet | `apps/web/src/traders/risk.tsx`, `pages.tsx`, `api.ts`, `vol.tsx` event cue, book header badge (§3) | wire types only |

Order: A, C, D start together; B starts together too and stubs `shock.ts` locally against the fixed signature,
dropping its stub when C merges. Main session: merges C → B → A → D into the integration branch, resolves
`app.ts`/`endpoints.ts`/`ownership-cases.ts` by hand (no union merge on .ts), runs one `make check`, `npx tsc -b` in
apps/web and the Python tests on the merged tree, dispatches a reviewer, fixes, merges to master, pushes, builds web,
writes runbook §20, and hands over the restart.
