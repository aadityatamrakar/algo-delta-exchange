# Legacy strategy directories — analysis

Evidence base: `dump.pm2` (a pm2 process snapshot pulled from the production
box `/home/ubuntu/algospot`), full git history per directory, filename-level
diffs between duplicate-named files, and repo-wide `require()` greps. One
important caveat that shapes several verdicts below: **`dump.pm2`'s
`created_at`/`pm_uptime` fields top out at 2023-03-05** — it is a ~3-year-old
snapshot, not live truth. It lists 97 processes, and every one of them points
at `server/slive/*.js`, `server/scripts/squareoff_smp.js`, `server/tools/*.js`
or `server/server.js` — nothing in `smp/tob/monks/archive/asmp/wealth/insta`
appears, but the snapshot also predates most files added to those directories
after 2023, so absence from it is suggestive, not conclusive, for anything
created/edited later.

## server/smp (134 files, last commit 2026-07-03)

Not a dead directory — it is a **paper-trading staging area**, actively
edited right up to the day before this analysis. It parallels `slive`
strongly by filename (`bull-300.js`, `lion-*`, `cheetah-*`, `samlion-*`,
`bn-breakout.js`, etc.) and by content: both directories `require('../server.js')`,
`../lib/zerodha.js`, `../lib/KiteTicker.js`, `../tools/optionInstruments.js`
— **same broker (Zerodha/Kite), same account model, same order path
(`PaperTrade.trackOrder_v2` for paper, `Account.placeAllAccount` for a
handful of live ones)**. It is not a different broker or account tier.

## server/tob (66 files, "last commit" 2025-02-12)

"Trade on Book"? — a pre-2023 strategy generation using XTS (Jainam) as well
as Zerodha. 26 of 66 files mention XTS. The directory-level last-commit date
is misleading: `git show --stat` on that commit shows it is a broad,
unrelated repo sweep (adds `stock_bse.json`, `filter-stocks.js`,
`downloadTrades.js`, touches `server/lib/fyers.js`, `package.json`) that
happened to include a 24-line edit to `server/tob/lowrisk.js`. Per-file commit
dates for the other 65 files cluster in 2022–2023 (13 files last touched
2023-09-05, the rest scattered 2021–2024). No filename overlap with
`slive` or `smp`. **Verdict: dead.**

## server/scripts (88 files, "last commit" 2025-05-02)

Two very different populations live here:
- ~85 strategy files (`mStrangle.js`, `strangle_st14.js`, `margin_b10.js`,
  `spider.js`, `STG_8.js`, `hedge.js`, `joker.js`, …) — an **older strategy
  generation that predates both `smp` and `slive`**. Per-file commits are
  uniformly 2021–2022; none share a filename with `smp` or `slive`.
  **Dead.**
- 3 EOD "squareoff" utilities: `squareoff_smp.js`, `squareoff.js`,
  `squareoff_instacorp.js`. `squareoff_smp.js` **is confirmed active** — it's
  in the pm2 snapshot (process name `squareoff_smp`), and the directory's
  most recent commit (2025-05-02, authored by `root@ip-172-31-...`, i.e.
  committed directly from the production box) is the commit that also
  *added `dump.pm2` to the repo* and made a real 2-line edit to
  `squareoff_smp.js` alongside `server/tools/xtsOrder.js`, `server/tools/smp_report.js`,
  and `server/lib/notify.js` — all confirmed-active infra. `squareoff.js`
  (2024-04-30) and `squareoff_instacorp.js` (2022-09-27) are plausible but
  unconfirmed — they aren't in the pm2 snapshot, but EOD scripts are
  sometimes cron-invoked rather than pm2-managed, so absence from pm2 isn't
  proof of death. **Needs a decision.**

## server/monks (26 files, last commit 2022-07-06)

Small, self-contained, Zerodha-based, one file (`saveDailyPNL.js`) references
`platform: 'fyers'` — the lone Fyers touchpoint anywhere in the target
directories. No pm2 presence, no filename overlap with `smp`/`slive`, no
inbound references. **Dead.**

## server/archive + server/archive/xts (28 + 8 files, last commit 2021-09-13)

Explicitly named "archive" — already a graveyard by intent. The `xts/`
subdirectory (`bently.js`, `casino_xts.js`, `chakravyuh_xts.js`,
`gravity_xts.js`, `ipl_xts.js`, `squareoff_xts.js`, `STG_8_XTS.js`,
`supertrend_xts.js`) is an XTS-flavored fork of names that also exist,
Zerodha-flavored, in `server/scripts`. Nothing here is required anywhere
else in the repo. **Dead.**

## server/asmp (23 files, last commit 2021-08-05)

All Zerodha, no XTS/Fyers/other broker mentions, no pm2 presence, no
references. Looks like an early ("a-smp"?) precursor to `smp`. **Dead.**

## server/wealth + server/wealth/archive (8 + 6 files, last commit 2021-06-14)

Small, oldest-touched cluster besides `archive`. All Zerodha. **Dead.**

## server/insta (7 files, last commit 2022-11-09)

Zerodha + 6 of 7 files touch XTS. Likely an early Jainam/XTS integration
pilot ("insta" ≈ instant/InstaTrade?), unrelated to the `candlestrategy-*`
"optionbhai mirror" family noted in prior memory (those live in `smp`, not
here — confirmed no `insta` file references `optionbhai`). **Dead.**

## server/datafeed/market_watch.js + server/parity/merge_datafeed.js

Two singleton utility files. `market_watch.js` (2021-02-15) — no inbound
references anywhere. `merge_datafeed.js` (2022-08-04) is the one file in the
whole survey that talks to **IBKR** (`ticksCache_ibkr`, `connect_ibkr()`) —
it merges an Interactive Brokers MCX/commodities tick stream with the main
feed. No inbound references either. **Both dead**, despite `parity/`'s IBKR
code being the most exotic single integration found in this sweep.

## extra/ (12 files, mixed dates)

Grab-bag: `arham.js`, `diff_strategy.js` (5527 lines — a large
diffing/backtest tool), `fillPrice.js`, and `spark.js`. `extra/spark.js`
(`require('./../server/lib/tradelab')`) is the one Tradelab touchpoint found;
it is a standalone prototype, not proof that Tradelab is live. **Dead**, no
inbound references.

## The server/smp ↔ server/slive relationship (the key question)

**Not a different broker or account model — smp is the staging/paper
sandbox slive strategies get born in, and diverges from slive only after a
strategy is promoted.** Evidence:

1. **26 filenames exist in both dirs.** Every diffed pair (`bn-breakout.js`,
   `rv-40.js`, `samlion-10.js`, `cheetah-st-60.js`, `bull-300.js`, `stgl-s.js`)
   uses identical `require`s (`../server.js`, `../lib/zerodha.js`,
   `../lib/KiteTicker.js`, `../tools/optionInstruments.js`), identical
   `Account`/`PaperTrade` models, and identical strategy logic modulo small
   drift. There is no broker, account-tier, or order-path difference.

2. **smp is where strategies are actually authored.** Git history shows
   brand-new files being added to `smp` first and iterated there through
   several same-day commits (e.g. `cp-ns-2040.js`/`cp-s-2040.js`/`cp-snx-2040.js`
   added 2025-10-24, tweaked 2025-10-24 and 2025-11-10; `cheetah-b1-15.js`
   added 2025-10-27; `snx-orb-1.js` added 2026-04-13). Some of these
   (`cp-s-3370.js`, commit `b7246476`, 2025-12-16) are added to **both**
   `smp` and `slive` in the same commit — the moment of "promotion" to
   production.

3. **After promotion, only slive keeps evolving.** The clearest case is
   `bn-breakout.js`: commit `20b10898` (2026-07-03, "Remove futures leg
   implementation") edits both copies identically. Commit `0ccf4432`
   (2026-07-14, "one trade per side per day") edits **only**
   `server/slive/bn-breakout.js` — `server/smp/bn-breakout.js` still has the
   older single-`tradedToday`-flag logic. This is exactly why `server/smp`'s
   directory-level last commit (2026-07-03) trails `server/slive`'s.

4. **Older-generation smp files still carry a pre-refactor bootstrap
   pattern.** `rv-40.js` and `samlion-10.js` in `smp` have `// runStrategy();`
   commented out with `CronJob`-scheduled start/stop instead; the `slive`
   copies call `runStrategy()` unconditionally on process load (the newer
   "log in / connect the feed on load, xtsOrder starts/stops the process"
   convention documented inline in the newer `bn-breakout.js`). This
   further confirms smp copies of promoted strategies are frozen at an
   earlier code style, not kept current.

5. **108 of 134 smp files have no slive twin at all** and cannot be
   dismissed as simply dead — many were created or edited in 2024–2026
   (29 files touched 2025-09-19 in one mechanical one-line-per-file
   patch, others touched individually as late as 2026-04-13/07-03).
   Given the stale pm2 snapshot cannot rule these in or out, they are
   classified `possibly-active` (drafts still under evaluation, or
   abandoned experiments — genuinely indeterminate from the repo alone).

6. A `server/datasources smp.json` file (distinct Mongo/loopback datasource,
   last touched 2021-05-30) exists but is never referenced by any `.js` file
   (loopback's env-datasource convention needs a dot, `datasources.smp.json`,
   not a space) — it looks like a dead leftover from an earlier multi-instance
   deployment scheme, not evidence of a currently-differentiated smp runtime.

## Safe to delete

- `server/tob/` — no pm2 presence, no cross-refs, per-file commits 2021–2024,
  no filename overlap with active dirs.
- `server/monks/` — same profile, last commit 2022.
- `server/archive/` + `server/archive/xts/` — already named/intended as a
  graveyard, last commit 2021.
- `server/asmp/` — last commit 2021, no refs.
- `server/wealth/` + `server/wealth/archive/` — last commit 2021, no refs.
- `server/insta/` — last commit 2022, no refs.
- `server/datafeed/market_watch.js` — no refs, last commit 2021.
- `server/parity/merge_datafeed.js` — no refs, last commit 2022 (note: this
  is the only IBKR code in the sweep; keep a copy outside git history if IBKR
  is ever revisited, but it isn't wired to anything today).
- `server/scripts/*.js` strategy files (all except the 3 squareoff_*.js) —
  older generation, last commit 2021–2022, no overlap with smp/slive.
- `extra/` — prototypes/one-offs, no refs (verify `extra/spark.js` isn't a
  design reference someone still wants before deleting).

## Needs a decision (not safe to blindly delete)

- `server/smp/` in its entirety — this is the live drafting ground for new
  slive strategies; deleting it would destroy in-progress work and the
  history of how promoted strategies started. At minimum keep the 26
  slive-twin files (their divergence is meaningful history) and the
  108 smp-only files until someone confirms none are mid-development.
- `server/scripts/squareoff.js` and `server/scripts/squareoff_instacorp.js`
  — plausibly still cron-invoked EOD utilities (siblings of the
  confirmed-active `squareoff_smp.js`), but not verifiable from the repo
  alone; check the production crontab / pm2 list before removing.
- `server/tools/sparkOrder.js` and `server/tools/xtsOrder.js` (outside the
  scope of this sweep but discovered along the way) are both pm2-active and
  both talk to XTS — meaning XTS is **not** dead in the codebase overall,
  just dead specifically inside the target legacy directories. Don't let a
  blanket "remove XTS code" pass touch these.

## Dead broker integrations (inside the surveyed directories)

- **XTS / Jainam** — present in `tob` (26 files), `scripts` (1), `monks` (5),
  `archive`/`archive/xts` (12+8), `insta` (6). All of these are inline,
  standalone XTS client code specific to each old strategy file. The XTS
  integration that is actually live today is centralized elsewhere, in
  `server/tools/xtsOrder.js` and `server/tools/sparkOrder.js` (both pm2
  processes using the `xts-interactive-api` package and dedicated
  `xtsAccount`/`sparkAccount` models) — neither of which lives in the
  directories being retired here.
- **Fyers** — a single mention, `server/monks/saveDailyPNL.js`
  (`platform: 'fyers'`), logging PNL for what was presumably a Fyers-connected
  account. No live Fyers client code found in the target directories (real
  Fyers client lives in `server/lib/fyers.js`, touched by the unrelated
  Feb-2025 bulk commit, outside scope).
- **Interactive Brokers (IBKR)** — one file, `server/parity/merge_datafeed.js`,
  merging an IBKR commodities tick stream. Nothing else references IBKR
  anywhere in the surveyed set.
- **Tradelab** — `extra/spark.js` wraps `server/lib/tradelab.js`. This is a
  prototype, not a deployed integration, and is unrelated to the *other*
  "Spark" (the pm2-active `sparkOrder.js`/`SparkAccount` XTS copy-trading
  bridge, whose name is coincidental).
- **Jainam (named explicitly), Shoonya/noren, Angel, Upstox** — zero hits
  across every target directory. An apparent 3-file "Angel" hit in
  `server/smp` (`snx-orb-*.js`) was a false positive — `ceRangeLow` /
  `peRangeLow` contain the substring "angeL", not a broker reference.

## Summary of scale

408 JS files, ~91,000 lines total, across the 12 directories/subdirectories
surveyed. Verdict split: 271 `dead`, 110 `possibly-active` (nearly all
`server/smp`, plus the two unconfirmed squareoff scripts), 26
`superseded-by-slive` (the smp files with a slive twin), 1 confirmed `active`
(`squareoff_smp.js`).
