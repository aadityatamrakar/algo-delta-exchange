# context/ — AlgoMaker codebase documentation

Compiled **2026-07-25** from a full audit of the repository: 6 years of history, 3,966 commits,
~380 strategy files, ~670 server-side JS files.

Written to be read by both humans and AI agents starting fresh on this codebase.

> **CORRECTION, 2026-07-28 — documents 01–11 describe a system that is no longer being maintained.**
> On 2026-07-27 the owner chose a **full cutover**: the LoopBack platform under `server/`,
> `common/` and `client_wc/` is retired and frozen in `archive/`, and the live system is the desk
> bridge in `apps/` and `packages/`.

## The live system — read these first (2026-08-15)

| # | Document | What it gives you |
|---|---|---|
| **00** | [Live system map](00-live-system-map.md) | **Start here.** The verified current system at `9d5e7cff`: processes, feed/order/state/push paths, all 29 collections, the Python boundary, packages inventory — plus §7, the list of verified stalenesses in every older doc (including the inverted `DESK_LIVE_TAGS` meaning). |
| 15 | [Mongo schema, as stored](15-mongo-schema.md) | Every collection's fields, types and indexes, inferred from the live data on 2026-10-19 (38 collections), plus what each one keeps and for how long. Doc 00 §5 says who writes and reads each. |
| **14** | [Robustness audit 2026-08-15](14-robustness-audit-2026-08-15.md) | 50+ severity-ranked, source-verified findings and the ranked remediation roadmap. The headline: broker truth never flows back into the desk. |
| 12 | [Dashboard data and push](12-dashboard-data-and-push.md) | The design *reasoning* for the stream/poll model. Stale on specifics — doc 00 §6-§7 corrects it. |
| 13 | [Development workflow](13-development-workflow.md) | How to build/test/deploy here. Partially stale (typecheck now covers apps/web; square-off line refs moved). |

Also current: `../docs/GOING-LIVE-RUNBOOK.md` (the only doc with the correct live-gate model),
`../docs/PYTHON-DESK.md` (mostly right; payload examples incomplete), and the session memory at
`~/.claude/projects/…/memory/` (operational incidents through Aug 2026 — more current than
`../memory/`, which is frozen at 2026-07-27).

## The retired system (01–11) — historical reference

Everything below remains accurate about the retired LoopBack system and is worth reading for the
trading logic it documents — but **do not operate from it**.

| # | Document | What it gives you |
|---|---|---|
| **01** | [System overview](01-system-overview.md) | **Start here.** What the system is, the order-bus insight, runtime shape, directory map, what's live vs dead |
| 02 | [Backend architecture](02-backend-architecture.md) | Boot scripts, `lib/` modules, the 25 data models, broker matrix, order paths, auth |
| 03 | [Frontend architecture](03-frontend-architecture.md) | Route map, controllers, API surface, build pipeline, **feature list for a rewrite** |
| 04 | [Strategy catalog](04-strategy-catalog.md) | Per-family trading logic; the canonical modern file anatomy; duplication assessment |
| 05 | [Legacy and dead code](05-legacy-and-dead-code.md) | Per-directory verdicts with evidence |
| 06 | [Cleanup audit](06-cleanup-audit.md) | Deletion plan by risk tier, secrets report, repo hygiene, tooling gaps |
| **07** | [Verified risks](07-verified-risks.md) | **Severity-ranked findings — verified only.** Includes claims that failed verification, and the open questions |
| **08** | [Overhaul proposal](08-overhaul-proposal.md) | **The upgrade plan awaiting approval**, with 4 explicit decisions |

### Sheets
- [`sheets/strategy-sheet.md`](sheets/strategy-sheet.md) — readable rendering: summary tables, families, full strategy table
- [`sheets/slive-strategies.csv`](sheets/slive-strategies.csv) — **156 rows**, one per production strategy, 16 fields
- [`sheets/legacy-strategies.csv`](sheets/legacy-strategies.csv) — **408 rows**, one per legacy-directory file, 12 fields

The CSVs are authoritative and spreadsheet-importable. Note `.gitignore` has a blanket `*.csv`
rule, so committing them needs an exception (`!context/sheets/*.csv`).

## Two things to know before trusting any of this

**1. `PaperTrade` is the order bus, not paper trading.** Documents 02–06 were produced by survey
agents before this was established, and use "paper" where they should say "bus-routed". A strategy
using `PaperTrade` may well be trading real money — it depends on which forwarding daemons are
running. See §2 of [01](01-system-overview.md). Document 04 carries an inline correction note.

**2. Documents 01, 07 and 08 are the verified synthesis layer.** Every claim in them was
re-checked directly against the code. Documents 02–06 are evidence-dense and useful but were not
individually re-verified line by line; [07 §5](07-verified-risks.md) lists the specific agent
claims that did **not** survive verification, so they don't get recycled as fact.

## Provenance and confidence

- Facts cite `file:line`. Re-check rather than trust.
- Anything unverifiable from the repo alone is labelled **OPEN QUESTION** instead of guessed.
- The biggest known gap: **there is no reliable record of what runs in production.** `dump.pm2` is
  a stale 2023 snapshot. A fresh `pm2 jlist` from the production box is the single highest-value
  missing input — see §8 of [01](01-system-overview.md).

## Related

- [`../MEMORY.md`](../MEMORY.md) + [`../memory/`](../memory/) — the same findings distilled into
  short, high-recall fact files
- `../docs/superpowers/` — existing design specs and implementation plans for the 4 newest
  strategies. Still accurate; the best examples of how strategies should be built here.
