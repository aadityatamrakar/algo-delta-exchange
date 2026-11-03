# archive/ — the retired system

Frozen as of **2026-07-27**, when the desk system became the default. Nothing here runs, and
nothing here should be edited or fixed. New work goes in `packages/` and `apps/`.

## Why it is kept rather than deleted

1. **The golden-master tests drive it.** `packages/strategies` proves each ported strategy class
   emits the same orders as the legacy file it replaces, by executing the real, unmodified file
   through `LegacyShadowRunner`. That safety net only works while the originals exist. The 15
   files in `server/slive/` are exactly those under test.
2. It is the record of what was tried. Several ideas here are not in the active set.

The archive is **self-contained** — `server/lib/zerodha.js` and `KiteTicker.js` are present here
because the legacy strategies `require('../lib/...')` them. The new system has its own vendored
copies under `packages/marketdata-core/vendor/`; the two are independent, and this one is frozen.

## Removed on 2026-07-27

Five config-only clones, all already collapsed in the new system into one class plus configs, and
none driven by any test (git history retains them):

| Removed | Superseded by |
|---|---|
| `candlestrategy.js`, `-a006.js`, `-test3.js` | `MIRROR_1PBUY` / `MIRROR_A006` / `MIRROR_EMA2050` |
| `bull-snx-1.js` | `BULL_SNX_1` |
| `cheetah-b1-snx.js` | `CHEETAH_B1_SNX` |

The three `candlestrategy` files were byte-identical apart from account and tag, and each carried a
**plaintext optionbhai username and password**. Removing them takes those credentials out of the
working tree — they remain in git history, so **they still need rotating**.

## Layout

| Path | What it was |
|---|---|
| `server/` | LoopBack app, strategies (`slive`), daemons (`tools`), libs |
| `common/` | LoopBack models, incl. the `paper-trade` order bus and `xts-account` login |
| `client_wc/`, `build_wc/` | AngularJS 1.x dashboard and its build output |
| `legacy/` | strategies already archived before this cutover |
| `scripts/` | one-off root scripts |
| `data/`, `data-csv/`, `historical/` | research data |
| `ecosystem.config.cjs` | the old pm2 inventory |
| `dump.pm2` | a stale 2023 process snapshot — never a reliable inventory |
