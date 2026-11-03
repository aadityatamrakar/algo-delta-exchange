---
name: repo-topology-live-vs-dead
description: "Which algomaker directories are live vs abandoned strata; smp is staging and slive is production; dump.pm2 is a stale 2023 snapshot"
metadata:
  type: project
---

Verified 2026-07-25 across a 6-year repo (3,966 commits, 2020-11-30 → 2026-07-17).

## Live
- `server/slive/` — **production strategies** (156 files, 37.5k LOC), last commit 2026-07-14
- `server/smp/` — **staging/authoring** (134 files), last commit 2026-07-03
- `server/lib/`, `server/boot/`, `server/tools/`, `common/models/` — shared infra
- `client_wc/` → `build_wc/` — **the only live frontend** (`gulpfile.js:14-15`)
- `server/scripts/squareoff_smp.js` — **active** despite living in an otherwise-dead dir
- `data/` (223 MB CSV), `historical/` (222 JSON) — local research data, untracked

## Dead — abandoned strata, safe to delete
`client`+`build` (2022-10) · `client_am`+`build_am` (2021-10) · `client_ob`+`build_ob` (2024-05) ·
`client_pd`+`build_pd` (2022-10) · `server/tob` (66 files, →2023) · `server/monks` (26, →2022-07) ·
`server/archive`+`xts` (36, →2021-09) · `server/asmp` (23, →2021-08) · `server/wealth` (14, →2021-06) ·
`server/insta` (7, →2022-11) · `extra/` (12) · ~85 of 88 in `server/scripts` ·
empty: `server/standle`, `models`, `memphis`, `greeks`, `logs`

≈130 MB of tracked payload. Deleting from the working tree does **not** shrink `.git` (74 MB).

## smp vs slive — staging and production
`smp` is **not** a dead twin. Strategies are authored in `smp`, promoted into `slive` in the
same commit, and thereafter only `slive` gets feature work. Proof: `bn-breakout.js` — a
2026-07-03 commit touched both identically; the 2026-07-14 "one trade per side per day" commit
touched **only** `slive`. 108 of 134 `smp` files have no `slive` twin, so `smp` is **drift, not
garbage** — needs reconciliation, not deletion.

## dump.pm2 is STALE — do not use as an inventory
Committed 2025-05-02 but its newest internal timestamp is **2023-03-05** (records Node 14.17.0).
It contains **none** of the current strategies — `bn-breakout`, `atr-band-nifty`, `orb-*`,
`candlestrategy`, `snx-orb-1` all absent.

**There is no reliable in-repo record of what runs in production.** Best in-repo signal is
`common/models/strategies.json` (101 entries), launched by `server/tools/ob_start.js` at
09:15:30 — but registration ≠ running, because `ob_start` only `pm2.restart`s *existing*
processes (see [[slive-strategy-conventions]]). A fresh `pm2 jlist` from prod is the single
highest-value missing input for any overhaul planning.

**How to apply:** before porting or deleting any strategy, get ground truth from the prod box.
Never infer "it runs" from `dump.pm2`. Related: [[order-bus-not-paper-trading]],
[[strategy-sprawl-and-config-axes]].
