# Traders — watch the ODIN traders' books, analyse them, never trade

Status: APPROVED by the operator, 2026-10-19 ("approved.")

Operator, 2026-10-19: "we have 10+ traders who are trading on odin client, in
stock options and do delta hedging based stock book building and adjusting on
monthly options and trade few times in a week … we want to bring there
positions and orders and logs into our application and build payoff graphs,
show greeks and delta neutral how we are showing for stock books, and show
repair option and all the things … it does not auto trade, user will manage
positions … in future we will add notifications etc, and nudge user to adjust
position if it goes out of range delta neutral and we can suggest what to do
based on recenter-relief-r."

Later in the same conversation: "they all are running client on windows pc, we
can build a small watcher app, that pushes positions logs, orders etc to our
cloud app" · "it should be config based we can put token for user, and it will
show in its account only" · "and a admin account which can look at all
accounts" · "we want to give access to all the features we have in the app, but
instead of algo trading, a human will use this as analytics tool" · "We want to
make copy volhedge features exactly" · "make stock book analysis all ways
similar to how other apps have like sensibull and definedge" · "for span margin
we can download span file from nse portal, we can use nsepython server edition"
· "when a trader logs in it should be able to see all the open books stocks in
tabs" · "there should not be complicated naming or thing, implementation should
be easy" · "we can sync full orders/positions odin folder as well … and watch
for changes and sync it as it changes."

The feature list in §6 is the one the operator approved ("the feature list
looks good"); this document expands every item and names the problems in it.

## Contents

1. [What this is](#1-what-this-is)
2. [Goals, non-goals, anti-goals](#2-goals-non-goals-anti-goals)
3. [Decisions](#3-decisions)
4. [The shape](#4-the-shape)
5. [Names](#5-names)
6. [Every feature, expanded](#6-every-feature-expanded)
7. [Problems found, ranked](#7-problems-found-ranked)
8. [Phases and what runs in parallel](#8-phases-and-what-runs-in-parallel)
9. [Phase 0 — what we need before building](#9-phase-0--what-we-need-before-building)
10. [Safety and tests](#10-safety-and-tests)
11. [Left to the builder](#11-left-to-the-builder)

## 1. What this is

Ten-plus traders run their own books on ODIN on their own Windows PCs. Each
book is one stock: monthly options plus a delta hedge (futures, possibly
shares), built up and adjusted a few times a week when the market moves. Today
they read their risk in VolHedge (Finideas), SmartDelta (Jainam) and TalkDelta.

We give each trader an account in our app. A small watcher on their PC syncs
ODIN's order and position files to us as they change. The app shows each open
stock as a tab, with everything our own desk has — payoff, greeks, the repair
list — plus VolHedge's screens copied, Sensibull/Opstra-style scenarios, real
NSE SPAN margin, and, on top of all of them, a delta band that says when a book
has drifted and what recenter-relief-r would do about it.

**The app never trades for them.** Nothing a trader account can reach places,
changes or cancels an order. The trader reads, decides, and acts in ODIN.

Why one app: the traders juggle three tools, none of which knows their
playbook; VolHedge says outright it gives no signals. Our desk already has the
engine that does.

## 2. Goals, non-goals, anti-goals

**Goals**

- Every trader sees only their own books, one tab per open stock, refreshed as
  ODIN's files change. One admin sees every trader.
- VolHedge's Analysis, Scenario, Market Watch and Range Calculator screens,
  copied feature for feature (§6 B–E), plus Sensibull/Opstra's target-date and
  IV sliders.
- Margin from NSE's own SPAN files, not an estimate.
- A delta band per book, "To Neutralize" in futures lots, and the
  recenter-relief-r suggestion as advice.
- Simple to build: few new parts, plain names, reuse what the desk already has.

**Non-goals (this spec)**

- Placing, changing or cancelling any order for a trader, ever.
- Running the desk's strategies on trader books.
- Notifications and alerts (designed for, built later — item 33).
- SmartDelta-style market analytics (item 35), reports (34), TalkDelta (36).
- A phone app. The web app works on a phone already.
- Changing how the operator's own desk trades, margins or decides.

**Anti-goals — failure even if everything "works"**

- Any path from a trader account, the watcher, or trader data into an order
  rail (desk-api's `SubmitService`, the order gateway, the supervisor).
- One trader seeing another trader's data.
- Stale prices, greeks or positions shown as live. If the feed is dead, the
  watcher is offline, or a file did not parse, the screen says so.
- Disturbing the live desk: its feed capacity, its CPU, its restarts.
- A book that silently disagrees with ODIN. If our position does not match
  ODIN's net position, the tab says so in red.

## 3. Decisions

**The operator's:**

1. A watcher app on each trader's Windows PC pushes to our app. It is
   configured by a file holding that trader's token; data lands only in that
   trader's account.
2. The watcher syncs ODIN's orders/positions folder and re-syncs each file as
   it changes.
3. One admin account sees all trader accounts.
4. Every feature the app has, as analytics; nothing trades.
5. Copy VolHedge's features exactly; match Sensibull and Definedge (Opstra)
   for stock book analysis.
6. SPAN margin from NSE's SPAN files, downloaded with nsepython server
   edition (`nsepythonserver`).
7. On login, a trader sees all open stocks as tabs.
8. Plain names; easy implementation.
9. The feature list in §6 and its grouping A–I.
10. No broker REST API (neither ODIN's nor XTS): all data comes from the
    trader's PC through the watcher.
11. The watcher is written in Go and compiled straight to a Windows `.exe`.
12. The traders are the firm's own staff; each has their own PC.
13. Trader data goes in the same Mongo database as the desk, not a separate
    one (the watcher uploads through our own endpoint; the box's ports are
    locked to 80).
14. A trader can add a leg by hand — shares, or anything the ODIN files
    miss (item 4a).
15. The watcher posts to the box over plain HTTP on port 80, by direct IP
    if needed — no 443, no HTTPS (operator, 2026-10-19: "Make sure watcher
    can post to direct ip as well without 443 and https", "On port 80").
    The operator accepts that tokens, passwords and positions cross the
    network unencrypted (P14).

**Mine (each is open to the operator):**

- **A separate small app, `apps/traders`, not more routes in desk-api.**
  desk-api is the process that places orders and it is not exposed to the
  internet today. Putting traders inside it means every one of its ~50 routes
  learns about owners, and one missed check leaks a book or reaches an order.
  A separate process with its own collections cannot reach an order rail
  because it never imports one. It reuses the pure packages (`payoff`,
  `greeks`, `desk-engine`, `instruments`) and the same market data bus.
- **The watcher is dumb; the server parses.** The watcher only copies files.
  All reading of ODIN's formats happens on the server, so a format surprise is
  fixed with one deploy on our side, not by reinstalling ten PCs.
- **Release order:** A, B, C, G first; then D, E, F, H; then I (§8).
- **Our own live greeks stay the live numbers.** NSE's IV (item 29) is an
  extra column and a cross-check, not the source.
- **Advice runs the engine from a clean state each time** (problem P4).

## 4. The shape

```
 Trader's Windows PC                     Our box
 ┌──────────────────────┐   HTTPS   ┌──────────────────────────────┐
 │ ODIN client          │           │ apps/traders  (new)          │
 │   writes files ──┐   │  upload   │   ingest: store file, parse  │
 │                  ▼   │ ────────► │   books, analytics, accounts │
 │ watcher.exe (new)    │           │   SPAN calculator            │
 │   watch folder,      │           └──────┬───────────────▲───────┘
 │   upload changes     │                  │ reads ticks   │ HTTPS
 └──────────────────────┘                  ▼               │
                                    desk-marketdata ──► bus │
                                    (+ trader stocks)       │
 NSE archives ──► span job (new, Python, scheduled) ──► files on disk
                                                           │
                                    web app: traders page ─┘
                                    (traders + admin; the desk pages stay
                                     operator-only)
```

- **watcher.exe** — watches one ODIN folder, uploads any changed file (whole
  file, they are small), heartbeats every minute, queues while offline.
- **apps/traders** — one Node process, its own port and its own `traders-*`
  collections. Accounts and tokens, the upload endpoint, parsers, books,
  analytics endpoints, SPAN. No import from desk-api's order code.
- **desk-marketdata** — unchanged in code. apps/traders asks it for the
  trader stocks through `desk-subscriptions`, the way the hosted runner
  already does (item 7).
- **database** — the same Mongo database as the desk, in its own
  `traders-*` collections. apps/traders writes only those and its own
  `desk-subscriptions` document; a test enforces it (P16).
- **span job** — a short Python script on a schedule that downloads NSE's
  SPAN and exposure files with `nsepythonserver` and saves them to disk.
- **web** — a second page in the same Vite app (`traders.html`) that talks only
  to apps/traders and reuses the desk's chart and table components. The desk
  pages are untouched and stay internal.

## 5. Names

Plain words, one name per thing, used the same in code, UI and docs.

| Thing | Name |
|---|---|
| The feature, the app, the page | **Traders** (`apps/traders`, `traders.html`) |
| A person | **trader**; the one who sees all is **admin** |
| The PC program | **watcher** (`apps/watcher`, `watcher.exe`, `watcher.json`) |
| What the watcher holds | **token** |
| One stock a trader holds | **book**, named by the stock: `TCS`. No dates, no variant suffix |
| A position line | **leg** |
| Mongo collections | `traders-users`, `traders-sessions`, `traders-tokens`, `traders-files`, `traders-legs`, `traders-orders`, `traders-trades`, `traders-log`, `traders-settings` |

A book is (trader, stock). It holds every open leg in that stock across all
months. When its last leg closes it leaves the tabs and moves to history.

## 6. Every feature, expanded

Each item: **What** · **How** · **Problems** · **Done when**. "Have",
"partly", "new" are against the app today.

### A. Accounts and getting data in

**1. Trader accounts and one admin** — new
- What: traders log in with username and password; admin creates traders,
  issues and revokes their watcher tokens, and can open any trader.
- How: `traders-users` {username, passwordHash, role: trader|admin, …} and
  `traders-sessions`, using `@algomaker/auth` as is (argon2id, sessions,
  lockout). An admin page: list traders, add, disable, reset password, issue
  token, revoke token, watcher status. Admin's top bar has a trader picker.
- Problems: the desk's login is separate (`desk-users`). Two logins is fine —
  different audiences — but say so on the login page. Password reset is
  admin-only (no email).
- Done when: a trader logs in and sees only their books; admin sees a picker
  with every trader; a disabled trader cannot log in.

**2. Every screen shows only that trader's data** — new
- How: every `traders-*` document carries `trader`. One helper resolves "whose
  data" from the session (a trader: always themselves; admin: the picked
  trader) and every query goes through it. No endpoint takes a trader name
  from a trader's request. One trader = one person = one PC = one active
  token (the operator: staff, each on their own PC). Each leg also stores
  ODIN's client code, so a login that turns out to hold two client codes can
  be split by code later without a migration.
- Problems: this is the one check that must never be missed (anti-goal).
- Done when: a test logs in as trader A and calls every endpoint with
  trader B's book names and ids; every call returns nothing or 404.

**3. The watcher — folder sync** — new
- What: a Windows program that watches ODIN's orders/positions folder and
  uploads each file whenever it changes.
- How:
  - `watcher.json`: `{ "server": "https://…", "token": "…", "folder":
    "C:\\ODIN\\…\\OnLineBackup", "include": ["*/Trades/*TRD.TXT",
    "*/Orders/*.txt", "*/Orders/*.TXT"] }`. Include patterns, not
    "everything" (problem P7); the folder and patterns are item 3a's.
  - Watch the folder recursively, and its Windows `VirtualStore` twin
    (`%LOCALAPPDATA%\VirtualStore\…`: when ODIN sits under Program Files and
    runs without admin, Windows silently redirects its writes there). When a
    file changes, wait for it to be quiet for 2 s, open it allowing read,
    write and delete sharing (ODIN may hold it open), hash it, and upload it
    if the hash changed:
    `POST /v1/traders/upload` (multipart: path relative to the folder,
    modified time, hash, bytes), `Authorization: Bearer <token>`. Whole files;
    a file over 1 MB that only grows (a log) sends just the new bytes.
  - A full re-scan at start-up and every 5 minutes, so a missed change event
    is caught.
  - Heartbeat every 60 s (`POST /v1/traders/heartbeat`: version, folder seen,
    last upload).
  - Offline: keep the latest version of each changed file and send them when
    the network returns. Latest wins; no history on the PC.
  - Runs at Windows logon (a scheduled task the installer creates), with a
    tray icon showing green/red and a local log file.
  - Written in Go and compiled to one `watcher.exe` (operator's decision),
    cross-compiled on our box (`GOOS=windows GOARCH=amd64 go build`; Go 1.27
    is installed). Pure Go, no cgo, so the cross-compile stays one command:
    `fsnotify` for folder events, the standard library for HTTPS and hashing.
    The tray icon only if a library cross-compiles without cgo; otherwise the
    local log and the heartbeat on the admin page are the status.
  - Lives in `apps/watcher` as its own Go module (no `package.json`, so npm
    workspaces ignore it), with Go tests run by `make check`.
- Server side: `traders-files` keeps the latest copy of each file per trader
  (and the last 7 days of versions, for debugging), then hands the file to the
  parser for its type.
- Problems: the folder layout and file formats are unknown until Phase 0
  (P1). File locking and half-written files (P7). Tokens on PCs (P6).
- Done when: on a test PC, a change to an ODIN file shows in the trader's tab
  within 10 s; pulling the network cable for 10 minutes loses nothing.

**3a. What ODIN's `OnLineBackup` folder holds** — from the operator's sample,
2026-10-19 (a real trader's folder, Anand Rathi; Aug 25 – Oct 19)
- Layout: `<ODIN install>\OnLineBackup\<Segment>\Trades\MMDDTRD.TXT` — one
  file per trading day — and `<Segment>\Orders\` with order files named
  `NSE_DDMMYYYYOrd.txt` or `MMDDORD.TXT` (both styles occur, same columns).
  Segments with data: `Nse Derivatives`, `Nse Equities`, `BSE Derivatives`
  (BSE orders `DOR<DDMMYY>-01.0000.TXT`); the commodity and currency segment
  folders are empty. `*.log` files and `Spread/Logs/*_CrossCurr.csv` are noise.
  The watcher watches `OnLineBackup` with include patterns
  `*/Trades/*TRD.TXT`, `*/Orders/*.txt`, `*/Orders/*.TXT`.
- Format: CSV, CRLF, space-padded fields, no header row. NSE derivatives
  trades have 25 fields (older files) or 28 (newer; field 26 `NSE OPT` /
  `NSE FUT`): trade no · instrument `OPTSTK|OPTIDX|FUTSTK` · symbol · expiry
  `27OCT2026` · strike · `CE|PE|''` · trading symbol · user id · side `1`=Buy
  `2`=Sell · qty in shares · price · client code · trade time
  `19 OCT 2026 09:21:09` · order time · exchange order no. NSE equities and
  BSE derivatives each have their own layout; orders carry a status code and
  total/filled quantities. Exact columns are pinned by each parser's task
  against scrubbed excerpts of the sample.
- **There is no positions file.** The net position is the sum of all trades
  across the daily files (see item 4). One client code per folder.
- Write timing: **ODIN appends to the day's TRD file during the session**
  (operator, 2026-10-19: "it grows during the session"), lines in time
  order. So the watcher's append path (send only the new bytes) is the
  normal case for trade files, and tabs update live.
- The trader also holds index options (NIFTY, BANKNIFTY, SENSEX on BSE); a
  book is keyed by the underlying, index or stock.

**4. Books — one tab per open stock** — new
- What: on login, the trader lands on Books with one tab per stock they hold
  (e.g. `TCS | TATASTEEL | KALYANKJIL`). Different stocks each month just
  means different tabs.
- How: the ledger derives legs from every trade in every daily file (stock,
  instrument: option/future/share, expiry, strike, CE/PE, signed qty, average
  price). A contract past its expiry is closed. Average price is VolHedge's
  Net Price rule: walk the contract's trades in file order day by day keeping
  net qty and Σ signed qty × price; when net qty is 0 at the END of a day,
  restart the sum; average = sum ÷ net qty. On the sample this reproduces
  VolHedge's screen for JINDALSTEL Oct: all 8 quantities exactly, 7 of 8 net
  prices to the paisa (1000 PE is ₹0.20 off — probably one trade the copy
  missed). A book is every leg of one underlying; the tab list is every book
  with a non-zero leg. Each leg is matched to our instrument master (P8).
- Not in any trade file, so entered as manual legs (4a): positions opened
  before the folder's first file (the tab says "trade history starts
  <date>"), and shares delivered by physical settlement of stock options at
  expiry.
- Leg kinds: options and futures are priced already (`PayoffLeg.instrument`
  is `'option' | 'future'`); a share leg is priced like a future with no
  expiry.
- Problems: carried positions and average prices (P9); multi-month books
  (P5).
- Done when: the tabs equal the stocks in ODIN's Net Position window, and each
  tab's legs and quantities equal ODIN's.

**4a. Manual legs** — new
- What: a trader (or admin for them) adds a leg by hand when the ODIN files
  do not have it — above all shares held overnight, which sit in holdings and
  not in ODIN's Net Position, but any option, future or share.
- How: an "Add leg" form on the book tab: stock, instrument (share / future /
  option), expiry, strike, CE/PE, signed quantity, average price, a note.
  Stored in `traders-legs` with `source: manual`. Manual legs count in every
  number on every screen, are marked "manual" in the leg table, can be edited
  or deleted by their trader, and are never overwritten by an ODIN file. The
  mismatch check (P9) compares only ODIN legs against ODIN's file. A manual
  leg can also open a new tab (a stock held only as shares).
- Done when: adding 1,000 TCS shares by hand moves the TCS book's delta by
  1,000 and To Neutralize by the right lots, and the next ODIN upload leaves
  the manual leg alone.

**5. Orders, trades and log** — new
- What: an Orders page per trader: the order book (status, qty, price, time,
  rejection reason), the trade book, and ODIN's message log, filterable by
  stock and day.
- How: parsed from the same files into `traders-orders`, `traders-trades`,
  `traders-log`, de-duplicated by ODIN's own order and trade numbers.
- Problems: whether ODIN's files hold history or only today (Phase 0).
- Done when: the page matches ODIN's Order Book and Trade Book for the day.

**6. Trading switched off for traders** — new
- How: the traders page never renders Apply, Manual Order, Place, strategy
  switches or kill switch; apps/traders has no endpoint that could do any of
  them and imports no order code. Repair (31) and advice (32) are shown as
  "what you could do", with a "show it on the payoff" button and nothing else.
- Done when: a test asserts apps/traders imports nothing from
  `apps/api/src/submit*`, `repair-apply`, `apps/order-gateway`,
  `packages/order-bus` or `packages/brokers`.

**7. Trader stocks on our market data feed** — new
- How, with no desk-marketdata code change:
  - **Once:** widen `DESK_UNIVERSE` to every stock with F&O, so the
    instrument master knows any stock a trader might open next month. Today
    the master holds only the universe names, and the universe changes only
    on a restart (BAJFINANCE was missing for exactly this reason,
    `2026-07-30-recenter-r-live-bajfinance-design.md`). One operator restart.
    The builder first checks that the universe drives no subscriptions of its
    own (if it does, the cost is one spot token per name).
  - **Every 15 s:** apps/traders declares the tokens it wants in
    `desk-subscriptions`, the path the hosted runner already uses
    (`apps/marketdata/src/subscription-store.ts`). desk-marketdata subscribes
    them as it does the runner's, and drops them when the declaration goes
    stale.
  - What it declares, per open trader book: the stock's spot, each held
    expiry's future, the strikes held, and ATM ± 15 strikes of each held
    expiry. Not the full chain (P3). Capped at `TRADERS_MAX_TOKENS` (default
    2000): over it the ATM windows narrow to ± 10, ± 5, then the
    at-the-money strike, far months first; spots, futures and held strikes
    are never dropped. A book whose legs have all expired drops out 3 days
    after its last expiry.
- Problems: capacity and bus load (P3); the one restart (P10).
- Done when: a stock no trader held yesterday is priced within a minute of
  its first leg arriving, with no restart, and the desk's own subscriptions
  are unchanged.

### B. Analysis screen — VolHedge's "Analysis" window

The first tab inside each book. VolHedge's layout, our components.

**8. Leg table** — partly
- Columns, as VolHedge v50 (2026-10-19 screenshot): include ☑, illiquid ☐,
  maturity, maturity date, strike, type (F/C/P), units (signed), lots, LTP,
  net price, buy price (best bid), sale price (best ask), gross MTM, synthetic
  future, time value, IV used, market IV, delta, delta value, vega, vega
  value, remarks, gamma, gamma value, theta, theta value. Below the table:
  Total / Month Wise / Option Greeks / Greeks Comparison tabs; Pay In Out;
  To Neutralize as units and a percentage; CF balance; book time value; the
  breakeven range (`BEP = 923.7 - 1403.7`); margin with a peak-margin line.
- How: "value" = greek × units (rupees or shares as VolHedge shows). "IV
  used" defaults to market IV and is editable per leg (item 17).
- Problems: VolHedge's `D. N.` / `V. N.` columns are not explained by the
  screenshot (Phase 0, Q3).
- Done when: for a sample book, every column matches VolHedge within rounding
  on the same prices.

**9. Include/exclude tick per leg** — new
- Unticked legs drop out of every total, chart and scenario on this screen,
  for this viewer only (not saved to the book).

**10. Illiquid tick** — new
- VolHedge: "if a call or put is illiquid, it uses a liquid option at the same
  strike". How: when ticked (or when the leg has no trade for N minutes), the
  leg's IV comes from the other side at the same strike; if that is stale too,
  from the nearest liquid strike. The cell says which.

**11. Month tabs and month-wise greeks** — new
- `All | OCT | NOV` above the table filters legs; the bottom panel has
  VolHedge's `Total | Month Wise | Option Greeks` tabs.

**12. Totals: delta, gamma, vega, theta, volga, vanna** — partly
- How: add `vanna` and `volga` to `packages/greeks` (Black-76 closed forms)
  and to `bookGreeks`. Two rows as VolHedge shows, `T` and `N`.
- Problems: what VolHedge's T and N rows mean is a guess (T at IV used, N at
  market IV?) — Phase 0, Q3.

**13. To Neutralize** — new
- What: how many units of the near-month future make the book delta-neutral,
  shown as units and lots, with the direction ("Buy 1 lot TCS OCT FUT").
- How: −(book delta in shares), rounded to whole lots of the future.
- Done when: matches VolHedge's box on the same book.

**14. MTM block: previous, today, total, expenses, square-off cost,
projected MTM** — partly
- How: Previous = MTM of positions carried from earlier days; Today = MTM of
  today's trades; Expenses = charges on trades done (item 14a); Square-off
  cost = charges to close every leg now at LTP; Projected MTM = current MTM −
  square-off cost.
- 14a. Charges: brokerage per trader (set by admin), plus STT, exchange
  transaction charge, SEBI fee, stamp duty and GST, all from one rates table
  in `traders-settings` that admin can edit when rates change.
- Problems: carried positions' cost basis (P9); brokerage differs per trader
  (Phase 0, Q5).

**15. Margin: initial, exposure, total** — partly
- From item 28. Until 28 ships: show the desk's SPAN-lite figure clearly
  labelled "estimate" (it was 2× off on BHEL), or show nothing. My call: show
  nothing rather than a number known to be wrong.

**16. Gap Up/Down panel** — new (revised 2026-10-19 from VolHedge v50)
- The 2016 `ATM- | ATM | ATM+` panel is gone in the current VolHedge; the
  "Gap Up Down" panel is now two editable scenario rows — price move % and
  vol change in points (e.g. Scenario-1 +10 % / −10 vol → −118009,
  Scenario-2 −10 % / −10 vol → −85168), ticks for using LTP and vol, and
  options to compute vol from the cash price or a synthetic future. It
  replaces the ATM-bucket idea; item 22 folds into it.

**17. Overrides at the top: call vol, put vol, future** — new
- Typing a call-vol or put-vol shift (in vol points) reprices every call or
  put; typing a future price reprices against it. Same engine as item 18.

### C. Scenarios — VolHedge's "Scenario" window, plus Sensibull

The second tab inside each book.

**18. Inputs** — new
- Spot (CMP), call-vol shift, put-vol shift, overall vol ± (step buttons),
  start date, end date, day interval, strike range (± N steps around a middle
  strike), middle strike.
- How: one pure function in `packages/payoff`:
  `scenario(legs, market, { spot, callVolShift, putVolShift, volShift,
  dates[], ivOverrides }) → per (spot, date): P&L and every greek`. The pricing
  under it already handles a different expiry per leg and any valuation date
  (`surface.ts` `yearFrac` per leg); this adds the vol shifts.

**19. Hypothetical legs** — have (what-if)
- Add rows (blank row at the bottom of the scenario table, as VolHedge) that
  join the scenario but never the book.

**20. Grid: spot % rows × date columns** — new
- Rows, as VolHedge v50: "Interval" is the spot step in percent (0.5) and
  "Strike +/-" the number of rows each side (50, so ±25 %), centred on
  M.Strike. Columns: every trading day from start to end (weekends and
  holidays skipped), plus Expiry, each with a tick to hide it. A metric picker over the grid, as VolHedge's tabs:
  P&L, P&L value, delta, delta value, gamma, gamma value, vega, vega value,
  theta, theta value, volga, volga value, vanna, vanna value. Current spot row
  highlighted; losses red, profits green.

**21. Payoff chart with target-date slider and IV shift** — partly
- The desk's payoff chart (`payoff.tsx`) gains a date slider (any date from
  today to the last expiry) and an IV-shift slider, as Sensibull. Today it
  draws three fixed dates and has no IV control.
- Sensibull's payoff table under the chart: P&L at target prices and at
  ±% moves, on the target date and at expiry.

**22. Gap-up/gap-down at the next open** — new; folded into item 16's panel
(VolHedge v50 computes it there as two editable price %/vol rows).

**23. Per share / per lot / whole position** — new
- One toggle on every P&L and greek table.

### D. Market Watch — VolHedge's "Market Watch"

**24. Option chain for three expiries** — new
- What: pick a stock; three stacked chains (near, next, far month), each
  headed by its future's LTP and change. Columns as VolHedge: strike, OI
  change, OI, butterfly, butterfly 2, straddle, ratio, volume, delta, gamma,
  vega, theta, price change (₹ and %), IV, LTP — calls left, puts right,
  colour-scaled; a column-settings dialog.
- How: from the same live chain the desk builds (`buildChain`), with greeks
  per strike.
- Problems: three full chains per stock is the capacity problem (P3) — only
  the stock on screen is subscribed fully, the others get ATM ± 10. OI change
  needs yesterday's OI (P12). VolHedge's BF, BF2 and Ratio definitions are
  guesses (Phase 0, Q3).

### E. Range Calculator — VolHedge's "Range Calculator"

**25. 1σ/2σ/3σ ranges by date** — new
- Inputs: stock, CMP, start date, current vol, days (VolHedge's "Iteration",
  default 30), step.
- Rows per calendar day: change % = vol × √(days/365); 1σ (68%), 2σ (95%),
  3σ (99%) lower and upper = CMP × (1 ∓ k × change %); and the point change
  for each. Checked against VolHedge's screenshot: vol 27.7, day 1 gives
  1.45%, CMP 7229 gives 7124/7334 and 105 points — the formula above
  reproduces all four.
- Problems: none. Pure arithmetic; can be built any time.

### F. Portfolio

**26. All of a trader's books on one page** — new
- One row per book: delta (shares and futures lots), gamma, vega, theta, MTM
  today/total, margin, band status (30); a totals row; a month-wise view.
  Admin gets the same across traders: one row per trader, and per stock
  across all traders.

**27. Named strategies inside a book** — new
- A trader can tag legs into named groups ("Oct straddle", "hedge"); each
  group gets its own totals and payoff. Tags are ours, stored per leg key;
  ODIN knows nothing of them. A leg not tagged is "ungrouped".

### G. NSE data

**28. Real SPAN and exposure margin from NSE files** — new
- How:
  - The span job (Python, `nsepythonserver`, run by pm2 on a schedule)
    downloads NSE's end-of-day SPAN file and each intraday one as NSE
    publishes it, plus the exposure-margin file, into a dated folder.
  - apps/traders parses the SPAN file (risk arrays per contract, scan ranges,
    inter-month spread charges, short-option minimum) and computes, per book:
    scanning risk (worst of the 16 scenarios on the summed risk arrays) +
    inter-month spread charge, floored at the short-option minimum, net of
    option value as the file specifies; plus exposure margin from the
    exposure file's rates on futures and short options.
  - Every margin figure shows which file it came from ("NSE SPAN 13:30").
- Problems: correctness has to be proved against broker numbers (P11); NSE
  can block or slow cloud downloads (P11); Python is a second runtime (P11).
  The desk keeps its own SPAN-lite and broker checks — this spec does not
  touch them.
- Done when: on the golden portfolios from Phase 0, our total is within 1% of
  the broker's figure.

**29. NSE's IV per strike** — new, optional
- NSE's option chain IV as an extra column in the leg table and Market Watch,
  fetched every few minutes per stock on screen. Our live IV stays the
  number everything is computed from.

### H. What none of them has

**30. Delta band and nudge** — new
- What: every book has a band; the tab header shows "In band" or "Out of band
  by 3 lots — To neutralize: Buy 3 lots TCS OCT FUT".
- How: default band = the engine's own corridor (`corridor.ts`) with the
  trader preset (relief-r counting the whole book's delta, P2), converted to
  lots, so the band matches what the advice would act on and agrees with To
  Neutralize. Admin or the trader can override it per book in lots.
  Every band change (in → out, out → in) is written as an event, which is
  what alerts (33) will send later.
- Problems: the corridor reads options only (P2).

**31. Repair list** — have
- The desk's repair search on a trader book: on demand, one search per book
  at a time, at most two searches running across all traders, result kept 60
  s. "Show on payoff" draws it as a what-if. No Apply.
- Problems: CPU (P13); the search assumes one expiry (P5).

**32. recenter-relief-r suggestion** — new, the engine exists
- What: "what relief-r would do now" — e.g. "Sell 2 lots 2140 CE, buy back 1
  lot 2040 PE" with the engine's own reason line, and "show on payoff".
- How: run `decide()` with the trader preset (relief-r counting the whole
  book's delta, P2) on the book's legs, every minute in session, from a clean
  rule state (P4); its actions become the card. Nothing is ever submitted.
- Problems: futures legs (P2), clean state (P4), months (P5).

### I. Later (not built in this spec)

**33. Alerts** — price, greeks, P&L, band breaks (from 30's events), watcher
offline, mismatch with ODIN. Channel to be chosen then.
**34. Reports** — VolHedge's Report menu; contents unknown (Phase 0, Q3).
**35. SmartDelta-style market analytics** — news, ban list, OI build-up, IV
rank, PCR, heatmaps, screeners, FII/DII.
**36. TalkDelta** — unknown; needs a trader to show it.

## 7. Problems found, ranked

**P1. How ODIN's files look — settled.** The operator supplied a real
`OnLineBackup` folder on 2026-10-19; item 3a records its layout and formats,
item 4 the position rule that reproduces VolHedge, and the operator confirmed
the day's trade file grows during the session. The fallbacks below are no
longer needed; the original research notes are kept for the record.

What research found (2026-10-19, public sources only): no vendor or broker
document names the order, trade, net-position or message-log files — they are
described only as windows (Order Book F3, Trade Book F8, Message Log F10, Net
Position Alt+F6). Known facts: ODIN Diet installs to `C:\ODIN\Diet\` or
`%SystemDrive%\OdinIntegrated\DIET\` and writes date-named CSV logs there
(`DietOdin-Logs\…`, `Masters\Logs\…`); its settings live in the registry, not
the folder; **ODIN Client's installer asks for an ODBC data source "ODIN INT
Database"**, so Client may keep orders and trades in a local database rather
than flat files — a file sync would then carry a binary database, and the
watcher would read it over ODBC instead (fallback 1 below). Diet,
Client and Integrated may differ. ODIN now belongs to Synapsewave Innovations
(bought from 63 moons, January 2025); format questions go to them.

*Answer:* Phase 0, Q1 — one afternoon on one trader's PC with Process
Monitor shows exactly which files ODIN writes, when, whether it appends or
rewrites, and whether it locks them. Running VolHedge's 7-day demo under
Process Monitor beside ODIN shows what VolHedge reads, which is the quickest
proof of what is readable.

*No broker REST API* — the operator ruled it out ("we cant use rest api"), so
neither the ODIN REST API nor XTS is a path. Everything comes from the
trader's PC.

*Fallbacks, in order, if the files are thin:* (1) if ODIN keeps orders and
trades in its local "ODIN INT Database", the watcher reads that database over
ODBC on the PC and uploads the rows (Go's `odbc` driver calls Windows'
`odbc32.dll` directly, so it still cross-compiles); (2) the
watcher copies the Trade Book and Net Position windows (right-click, Copy, as
two broker guides describe) on a timer and uploads the text — it works, but
steals focus for a moment and only polls; (3) reading the windows' grid
controls through Windows UI Automation — the last resort, fragile across ODIN
updates. Each of these still uploads to the same endpoint and lands in the
same `traders-legs`, so nothing after ingest changes. Until the watcher
exists, admin can upload a trader's files by hand on the admin page, so B, C
and G can be built against real books from week one.

**P2. The engine's book is options-only.** `LegView` has no futures kind
(`corridor.ts` says "a futures hedge would have to arrive as a typed leg kind
first"), and the traders hedge with futures. Without a fix, the band (30) and
the suggestion (32) would ignore the hedge and call a hedged book naked.
A second catch: the `recenter-relief-r` preset sets `delta_shorts_only` and
`gamma_shorts_only`, and the corridor's filter keeps only sold options
(`corridor.ts`), so even a futures leg kind would be left out under it, and
the band ("out by N", sold options only) would disagree with To Neutralize
(whole book) on the same book.

*Fix (my call — the operator did not choose; whole book over relief-r
exactly):* trader books use **a trader preset: relief-r with
`delta_shorts_only: false`**, so delta counts every leg — options, futures,
shares, manual legs — the way the traders hedge and the way VolHedge's To
Neutralize counts; `gamma_shorts_only` stays on, so a long wing still does not
narrow the band. Add a `future` leg kind to the engine's leg and corridor
(delta = sign × shares, gamma 0; a share leg is the same with no expiry).
Desk books never carry one and keep their own presets, so the existing parity
and engine suites must stay green unchanged. Until this lands, 30 and 32 are
shown only on books with no futures or share leg, with a sentence saying why.

**P3. Market data capacity and bus load.** One Zerodha login feeds the whole
desk; the sharder caps a socket at 900 tokens and Kite caps how many sockets
one login may open. Full chains for 30 trader stocks would be ~3,000–6,000
more tokens. And the bus (`packages/bus`) sends every tick to every client —
desk-api, the order gateway, the runner, the supervisor — each of which parses
it before filtering, so trader ticks cost CPU in the order path (an
anti-goal). *Fix:* declare held strikes plus ATM ± 15 per held expiry (item
7), roughly 70 tokens a stock; Market Watch's three full chains only for the
stock on screen, only while it is open. *Check in Phase 0:* today's token
count, the socket limit for our login, the traders' stock list, and the
gateway's CPU with the extra ticks on a paper day. If the bus load shows,
the next step is server-side topic filtering in `ws-transport.ts` — a desk
change with its own restart.

**P4. The engine's memory assumes its own fills.** Its rule state (credit
bank, LIFO stack, streaks, banned strikes) records what *it* did. A human who
ignores or half-follows a suggestion makes that memory wrong. *Fix:* run each
advice from a clean state, and label the card "from where the book stands
now". This loses relief-r's unwind-in-order behaviour, which is acceptable for
advice.

**P5. One expiry per book in the desk code.** The desk's payoff `assemble` and
the engine manage one expiry; trader books span months, especially around
rollover. *Fix:* the pricing already takes a per-leg expiry; the new book view
solves IV per leg from that leg's own month's chain. The engine and repair
advise on the near month and carry the other months' delta as a fixed offset
(a futures-like leg once P2 lands). Say so on the card.

**P6. Tokens on trader PCs.** *Fix:* a token can only upload and heartbeat
for its own trader — it cannot read anything. Stored hashed; shown once when
issued; revocable and replaceable from the admin page; last-used time shown.

**P7. Syncing a folder can sync the wrong thing.** ODIN's folder may also hold
settings, saved login data or logs with client codes; files may be locked or
half-written. *Fix:* include patterns only, chosen after seeing the folder in
Phase 0; quiet-for-2-s before reading; shared read; the server keeps the last
good parse when a file fails to parse and shows "file did not parse" on the
tab.

**P8. ODIN's contract names → our instrument master.** *Fix:* match on
(stock, expiry, strike, CE/PE/FUT/EQ), never on display text. Share (EQ) legs
match on the NSE symbol in the master's cash segment — the master's own EQ
rows carry the company name where an F&O row carries the symbol, so a
name-based match would miss most shares. Any row that
does not match is listed on the tab as "not understood" and kept out of the
numbers.

**P9. Carried positions and average prices — settled by the sample.** ODIN
writes no net-position file, so positions come from real fills and the cost
basis is the fills themselves (item 4's rule, which matches VolHedge). There
is no ODIN position to check against; instead the tab shows where the trade
history starts, and anything older — or delivered at expiry — is a manual leg.
The anti-goal "never silently disagree with ODIN" is met by showing the
history date and every unmatched row, not by a reconciliation.

**P10. desk-marketdata restarts are the operator's.** Item 7 needs exactly one,
to widen `DESK_UNIVERSE`; after that, new trader stocks need none. *Fix:* do it
on its own, while the desk's books are flat, as with the earlier cut-overs.

**P11. SPAN: correctness, download, runtime.** NSE's SPAN algorithm has more
parts than the desk's 21-scenario estimate, and the only proof is matching
broker numbers. NSE sometimes blocks cloud IPs (the reason `nsepythonserver`
exists). The span job adds Python. *Fix:* golden portfolios with broker
margin from the traders (Phase 0, Q6); a download test from this box by the
operator; keep the Python part to "download and save" only, so all logic stays
in TypeScript; if a download fails, show the last file's time in amber.

**P12. Yesterday's OI for Market Watch's "OI change".** Kite ticks carry
today's OI only. *Fix:* NSE's end-of-day F&O file through the same span job.

**P13. CPU.** The repair search prices hundreds of candidate books; ten
traders pressing it at once, plus payoff refreshes on every open tab, lands on
the same box as the live desk. *Fix:* caps in item 31; payoff and scenario
recomputed at most once a minute per book, shared by every viewer; the
traders app as its own pm2 process so it can be throttled or stopped without
touching the desk.

**P14. The app is not on the internet safely today.** Caddy serves the
dashboard on :80 and the browser calls desk-api on :8790 directly. The operator has the box's ports locked to 80 for the app. *Fix:*
apps/traders goes behind Caddy — its pages and its API on their own hostname
or under `/traders` on port 80 — with CORS to that one origin. desk-api stays
where it is. **HTTPS needs port 443 opened** (Caddy gets the certificate
itself). On 80 alone, every watcher token, password and position crosses the
internet unencrypted, and the session cookie cannot be `Secure`. My
recommendation is to open 443; it is the operator's call (O1). The traders page is built into its **own output folder**
(`apps/web/dist-traders`), served by its own Caddy site: Caddy serves all of
`apps/web/dist` from one root today, so a `traders.html` dropped in there
would put the desk pages on the public hostname too.

**P16. Same box and same database as the live desk.** Mongo runs with no
authentication (`/etc/mongod.conf`: bind 127.0.0.1, no `security` section),
so any local process can write any desk collection — including
`desk-books-registry`, which the supervisor reads to decide what to trade. So
"apps/traders imports no order code" is necessary but not enough: a bug in
the process that parses uploaded files could still write where the
supervisor looks. *Fix:* one module in apps/traders owns every database
write, and it accepts only `traders-*` collection names plus its own
`desk-subscriptions` document; a test drives every endpoint and asserts no
other collection changed. Uploads are size-capped and parsed as plain text,
never executed or unzipped blind. The operator has the box's ports locked to
80, so nothing else on it (Mongo, the bus) is reachable from outside; the
only new way in is the upload endpoint behind Caddy, and it accepts nothing
without a valid token.

**P15. VolHedge semantics we can't read off four screenshots.** T/N rows,
`D. N.`, BF, BF2, Ratio, the ATM± panel, Previous MTM, "EQ." in the margin
box, the Report and Import/Export menus. *Answer:* Phase 0, Q3. Until
answered, those columns ship with our best reading, labelled.

## 8. Phases and what runs in parallel

Seven tracks. Tracks are independent streams of work that only meet where the
list below says so. Whether they run as parallel agents or one after another
in the main session is decided when the implementation plan is written (the
operator said "dont use subagents do in native" on 2026-10-17 and asked for a
subagent for research today); the order inside each track is the same either
way.

| Track | Phase 1 (foundation) | Phase 2 (analysis) | Phase 3 (breadth + edge) |
|---|---|---|---|
| **S — server** | apps/traders: accounts, sessions, admin page, tokens (1, 2, 6); upload + heartbeat endpoints; manual upload; manual legs (4a) | — | portfolio + admin roll-up (26) |
| **P — parsing** | parsers for ODIN files → legs, orders, trades, log (4, 5); instrument matching (P8); ledger + mismatch check (P9) | charges (14a) | — |
| **W — watcher** | watcher.exe (3) | installer polish, auto-start | — |
| **M — market data** | widen `DESK_UNIVERSE` (one restart); `desk-subscriptions` declaration (7); capacity and bus check (P3) | — | Market Watch subscriptions (24), yesterday's OI (P12) |
| **C — calculations** | greeks: vanna, volga (12); scenario function (18); range (25) | multi-month book view (P5); illiquid IV (10); gap (22) | engine `future` leg (P2); advice from clean state (P4, 32); band (30) |
| **N — NSE** | span job download (28); SPAN file parser | SPAN calculator + golden tests (28) | NSE IV (29) |
| **U — web** | traders.html, login, tabs (4), add-leg form (4a), orders page (5), admin page (1) | Analysis screen (8–17), Scenario screen (18–23), payoff sliders (21) | Market Watch (24), Range (25), Portfolio (26), groups (27), advice cards (30–32) |

**Where tracks wait on each other**

- W and P wait on Phase 0's ODIN folder sample (P1). Everything else starts
  on day one.
- U's book tabs need S's endpoints and P's legs. Until P has real parsers, S's
  manual upload plus a hand-written sample file feed U.
- C's scenario (18) feeds U's Scenario screen; C's greeks (12) feed U's
  Analysis screen. Agree the function shapes first, then build both sides at
  once.
- N's calculator needs the golden portfolios (Phase 0, Q6) before it can be
  called done.
- M's universe widening ships alone, with the one operator restart (P10);
  the declaration itself needs no restart.
- Phase 3's engine work (P2) touches `packages/desk-engine`, which the live
  desk runs. It goes last, on its own branch, with the full parity suite.

**What ships when**

- **Release 1 = Phase 1.** Traders log in, see their tabs with today's payoff
  chart and greeks on real ODIN data, add shares or missing legs by hand, and
  see their orders and log. Admin sees all.
- **Release 2 = Phase 2.** VolHedge Analysis and Scenario screens, sliders,
  real SPAN margin, charges.
- **Release 3 = Phase 3.** Market Watch, Range, Portfolio, groups, band,
  To Neutralize nudges, repair and relief-r advice.
- **Later = I.** Alerts first.

Each release is merged, pushed and built as usual; restarts of
desk-marketdata are the operator's. apps/traders and the traders page can be
restarted and rebuilt without touching the desk.

**Left out of this spec — each needs its own spec when its turn comes**

- Alerts and notifications (33): band breaks, watcher offline, mismatch with
  ODIN, price/greek/P&L levels. Release 3 already records band changes as
  events, so alerts plug into them.
- Reports (34), SmartDelta-style market analytics (35), TalkDelta's features
  (36).
- Updating the watcher by itself: Release 1 reports its version on every
  heartbeat; a new version is installed by hand until this exists.
- Corporate actions and lot-size changes on held legs, and the F&O ban list.
- Replaying or backtesting a trader's book.
- Turning on Mongo authentication for the whole desk (P16) and server-side
  filtering on the bus (only if P3's check shows the load).
- relief-r's unwind-in-order memory in the advice (P4 drops it by design).
- Anything that places orders for a trader: a non-goal, not a later item.

## 9. Phase 0 — what we need before building

From the traders (through the operator):

- **Q1. ODIN files.** Answered: the `OnLineBackup` sample (item 3a), and the
  day's TRD file grows during the session (operator, 2026-10-19). The fuller
  procedure below is kept only in case a different ODIN build behaves
  differently.
  1. Help → About: ODIN variant (Diet / Client / Integrated), version and
     service pack; Task Manager → "Open file location" for the exe's folder;
     which broker.
  2. Before the open, list every file with size and time under ODIN's folder,
     `%APPDATA%`, `%LOCALAPPDATA%` (including `VirtualStore`) and
     `%ProgramData%`.
  3. Run Sysinternals Process Monitor filtered on the ODIN exe (file create,
     write, rename). Place and cancel one small order, take one fill, refresh
     Net Position, open the Message Log, log out. This shows which files
     change, when, append or rewrite, and whether they are locked.
  4. Zip the daily orders/positions log folders (today's and two earlier
     days), with screenshots of Net Position (Daily and Expiry), Order Book
     and Trade Book taken at the same moment as today's files, so each file
     can be matched to its window. Note the time each file last changed
     against the time of the last order: written as it happens, or only at
     logout / end of day?
  5. Check `odbcad32` for an "ODIN INT Database" data source and what file it
     points to.
  6. Copy a changed file while ODIN is running (lock test); close and reopen
     ODIN to see whether files are kept, rolled by date, or wiped.
  7. Optional and quickest proof: install VolHedge's demo and run it under
     Process Monitor beside ODIN to see what it reads.
- **Q2. Stock list.** Which stocks each trader typically holds, and how many
  months at once.
- **Q3. VolHedge.** Screenshots of every screen they use, including Summary
  (F9), Open Position (F8), the Report and Import/Export menus, and a sentence
  each on: the T and N rows, `D. N.`, BF/BF2/Ratio, the ATM± panel, Previous
  MTM, "EQ.".
- **Q4. A carried leg.** Answered by the sample (P9): cost basis is the
  fills; VolHedge's Net Price rule reproduced. One open point: JINDALSTEL Oct
  1000 PE shows 22.80 in VolHedge against 23.00 from the files — check
  whether a trade was missing from the copy.
- **Q5. Charges.** Each trader's brokerage (per order or per lot).
- **Q6. Margin.** Three to five real books with the broker's SPAN and
  exposure margin given separately (not just the total), on a known day and
  time, **outside expiry week** — in expiry week brokers add delivery margin
  and their own add-ons, which NSE's SPAN files do not contain, so a mismatch
  there would say nothing about our calculator.
- **Q7. TalkDelta.** It exists (talkdelta.com, Surat; claims 50–70 brokers)
  but publishes neither its features nor how it gets positions. What the
  traders use it for, if they want it later.

From the operator:

- **O1.** A hostname for the traders app, and whether to open port 443 for
  HTTPS (P14).
- **O2.** One test run of the NSE download from this box (P11) — the agent
  cannot reach external services from here.
- **O3.** A Windows PC (or a trader's, with permission) to test the watcher.

From us: the token count and socket limit (P3); the shapes of the scenario
and greeks functions, agreed before tracks C and U split.

## 10. Safety and tests

- apps/traders imports no order code; a test enforces the import rule (item
  6).
- Ownership: the cross-trader test in item 2 runs on every endpoint, and a new
  endpoint without it fails the suite (a list of endpoints in one place that
  the test walks).
- Tests on this box reach live ports: apps/traders tests use their own port
  and in-memory or uniquely named test databases, never `algomaker`, and never
  call desk-api or the supervisor.
- Parser tests are built from the Phase 0 sample files, with client codes
  scrubbed.
- SPAN golden tests from Q6; range calculator test from VolHedge's screenshot
  (item 25); greeks tests for vanna and volga against finite differences.
- The engine change (P2) keeps every existing `desk-engine` and parity test
  green with no edits to their expectations.

## 11. Left to the builder

- Ports, file layout inside `apps/traders`, endpoint names beyond the two
  watcher ones.
- The watcher's installer (or a plain zip plus a one-line scheduled-task
  command), its Go libraries within the no-cgo rule, and the tray icon.
- Default scenario steps, colours, column order within VolHedge's set,
  refresh intervals within the caps in P13.
- Whether `buildChain` and the payoff view helpers move into a package or are
  imported where they are, as long as desk behaviour does not change.
- How long raw file versions and logs are kept (7 days suggested for raw
  files, a year for orders, trades and log).
