# Docs

| Folder | What is in it |
|---|---|
| [`specs/`](specs/) | The Delta desk design: [BULL-S on BTC options](specs/2026-11-03-dx-bull-s-design.md) |
| [`plans/`](plans/) | The build plan, lane by lane: [dx BULL-S plan](plans/2026-11-03-dx-bull-s-plan.md) |
| [`research/delta/`](research/delta/) | Delta Exchange research behind the spec: the API, the market structure (with the 3 Nov chain snapshot), the seams in this code, BULL-S on BTC, and the web survey |
| `runbooks/` | Operating the dx desk. Not written yet: `runbooks/dx-bull-s.md` arrives with plan Task 9 |
| [`reference/nse/`](reference/nse/) | Architecture docs inherited from the NSE desk that are still true of the shared machinery (see below) |

## Inherited from the NSE desk

These describe the machinery as it stood in the NSE desk on 3 Nov 2026 and are not maintained here. Every
process name (`desk-*`), port (87xx) and database (`algomaker`) in them belongs to the **live NSE desk**. This
repo's equivalents are `dx-*`, 8890–8897 and `algomaker_dx`. Never run a command from these pages.

| Doc | Read it for |
|---|---|
| [00 — the live system, mapped](reference/nse/00-live-system-map.md) | Processes, data flow, the order path, who writes which collection |
| [10 — target architecture](reference/nse/10-target-architecture.md) | The design decisions the apps were built to |
| [11 — execution and resilience](reference/nse/11-execution-and-resilience.md) | Failsafe operation, errors surfaced to the UI, chase execution, multi-leg baskets |
| [13 — development workflow](reference/nse/13-development-workflow.md) | The plan → lanes → review → merge loop |
| [15 — Mongo schema](reference/nse/15-mongo-schema.md) | Field-level shape of every collection (the clone keeps the NSE collection names) |
| [BULL strategy spec](reference/nse/strategy-bull.md) | The NSE `bull` family that BULL-S is built from (spec §6.1 cites §3) |

## Citations to NSE documents

Code comments that cite `docs/superpowers/…`, `docs/runbooks/…`, `docs/reports/…`, `docs/DEPLOYMENT.md`,
`docs/GOING-LIVE-RUNBOOK*.md` or `context/…` are citing the NSE repo (`/opt/algomaker`, read-only from here).
Those documents were not carried into this repo.
