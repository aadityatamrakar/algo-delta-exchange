# October housekeeping — old books, series reports, delta-lean review, mirrors, stock books

Date: 2026-10-04 (Sunday). Desk: paper only, four delta-lean index books and
three stock books a month. Operator asked, in one sitting: clean up old books
and the workspace; stop the daily-dated tags fragmenting the Reports page;
review how delta-lean has traded since the hold-and-adjust cut-over and say
whether it needs tuning; reach optionbhai at its origin IP so Cloudflare stops
blocking the mirrors, then switch the mirrors on; start three new stock books
the way the September ones were started. Then commit, review, push.

Five workstreams. Each is independent enough for its own subagent; the merge
is one `make check` on the combined tree (api test suites use fixed Mongo db
names, so they never run in parallel across worktrees).

## State found (facts, all verified read-only on 2026-10-04 16:50 UTC)

- Box rebooted 16:45 UTC today; all five desk processes up on the current
  master build. Disk 89% — but 57 GB of that is other projects under
  `/home/ubuntu` (metatrader-strategies 37G, sensibull_tools 20G), not ours.
- The daily roll ran correctly: 1 Oct created the 10-01 four and erased the
  09-29 four; 2 Oct (Gandhi Jayanti) was a no-op; 3–4 Oct weekend. Nothing was
  missed. Monday's roll will erase the stopped 09-30 four by itself.
- `desk-books-registry` (11 rows): four 09-30 delta-lean (stopped, flat);
  four 10-01 delta-lean (running) — the two SENSEX ones each still HOLD a long
  `SENSEX26O0171800PE` (80 and 40) whose contract expired on 1 Oct; three
  `*-2026-09-29-recenter-relief-r` stock books (TCS, TATASTEEL, KALYANKJIL)
  still `running` four sessions after their contract expired, TCS holding a
  long `TCS26SEP2080PE` ×1125.
- `desk-strategies` has 11 orphan dated rows with no registry row (nine
  `*-2026-08-25-recenter*`, two `NIFTY-delta-lean-*-2026-09-29`).
- SENSEX 1 Oct (expiry day): aggressive −42,591, conservative −19,548. Both
  books' 14:50 passive flatten left the hedge leg resting ("still resting
  after 1 reprice"), no 14:55 urgent flatten decision was ever recorded, and
  after today's gateway restart the order was marked "orphaned by a gateway
  restart". `desk-gateway-orders` for that same order says COMPLETE, 80 filled
  at 149.15 — the two records disagree.
- Delta-lean P&L since the first full hold-and-adjust day (2026-09-23 → 10-01):
  NIFTY-aggressive −3,584; NIFTY-conservative +11,910; SENSEX-aggressive
  −38,766 (+3,825 without 1 Oct); SENSEX-conservative −19,764 (−216 without
  1 Oct). Every large loss day is an expiry day (NIFTY 09-29, SENSEX 09-24,
  SENSEX 10-01). `dl_day_max_loss` is 200,000 and `dl_stuck_loss` 25,000 on
  every book; neither fired at −42k.
- optionbhai: only `desk-runner` talks to it; `https://optionbhai.com` and
  `wss://optionbhai.com` are constants in `apps/runner/src/optionbhai.ts:54-55`
  with no env override. Login got HTTP 403 ~134,000 times between 8 Sep 02:15
  and 10 Sep 07:31 (fixed 5 s retry, no backoff) until all four mirrors were
  switched off. DNS for optionbhai.com answers Cloudflare addresses; the
  origin `13.202.244.113` answers plain HTTP on port 80 with 200 (verified
  once; HTTPS to the bare IP did not answer within 10 s).
- September stock books were made by four API calls each on 2026-09-07
  13:20–13:27 IST: `POST /v1/desk/books/registry` (variant
  `recenter-relief-r`, dials `{margin_cap:5000000, target_pnl:50000,
  delta_shorts_only:true, gamma_shorts_only:true}`), `POST .../start`,
  `PATCH /v1/desk/strategies/:tag {modes:{paper:{enabled:true}}}`, then four
  entry orders via `/v1/desk/submit` (short ATM straddle + long wings ≈ ±9 %
  of spot; 5, 5 and 2 lots) and `POST /v1/desk/seed` recording those four
  legs. Recenter never opens the initial position itself. October monthly
  expiry for all three is 2026-10-27; Friday futures marks TCS 2076.8,
  TATASTEEL 178.65, KALYANKJIL 528.
- Working tree: five untracked JSON files (`optionConfig_*.json`,
  `cancelledOrders.json`, `rejectedOrders.json`) written 15 Sep by legacy
  `archive/server` tools nothing live reads; three fully merged local branches
  (`design/delta-lean-index-book`, `fix/paper-fill-attribution`,
  `overhaul/foundation`); one old stash of legacy `server/` edits.
- `desk-api-out.log` fills 10 MB every ~3 h 20 min around the clock, weekends
  included; pm2-logrotate keeps 30 files. 445 MB in `logs/`.

## WS1 — Clean up old books, stranded legs, workspace

### 1a. Settle a leg whose contract has expired (api + roll)

Problem: a paper book that misses its flatten keeps an expired leg forever.
The engine keeps emitting "past the flat-by — closing all 1 leg(s)" against a
contract no simulator will ever fill, the roll refuses to retire the book
("holds legs"), and the only exit today is `?purge=1`, which destroys the
history the Reports page is built on.

Design: `POST /v1/desk/books/registry/:tag/settle-expired?mode=paper`.
- Paper only; a live row is a 400 (settlement at the broker is the broker's).
- For each `desk-books` leg whose `expiry` < today's IST date: settlement
  price = intrinsic value against the underlying's close on expiry day,
  taken from the last `desk-marks` tick for the index/stock on that date
  (SENSEX 71909.7 is the mark on file; TCS from its future). If no mark can
  be found for that date, refuse with 409 naming the leg — never guess.
- Book a synthetic close fill (`desk_op: 'settle'`) into the same ledger the
  flatten would have used, so `desk-decisions`, `desk-daily-reports` and the
  book's realised P&L pick it up; remove the leg from `desk-books`; audit-log
  it with price and source.
- Cancel any resting order on that leg in the gateway (the orphaned one).
- Idempotent: a second call finds no expired leg and returns 200 with
  `settled: []`.
- The roll (`delta-lean-roll.mjs`): a retire candidate that holds legs ALL in
  expired contracts is reported as `expired-legs`, and `--apply` calls
  settle-expired first, then proceeds to stop/erase. A leg in a live
  contract is still left alone and alarmed, as today.
- **Expiry cleanup for every paper book, not only delta-lean** (operator:
  "books tabs should get removed automatically after expiry"). The roll gains
  a fourth loop, after the delta-lean retire: any OTHER paper registry row
  whose `expiry` is before the previous trading day is retired by the same
  rule — settle expired legs, stop if running, erase if flat; a leg in a
  live contract alarms and is left alone. The September stock books are the
  first rows this catches. The cron line does not change; the roll already
  runs every weekday morning. The runbook §7 gains the rule.
- Tests: route unit test with a fixture book holding one expired and one live
  leg (only the expired one settles; the live one blocks the erase as
  before); roll plan test for the new action.

### 1b. One-off retirement of what is on the box (ops, via API, after 1a ships)

Order, after the operator restarts desk-api onto the new build:
1. `settle-expired` on `SENSEX-delta-lean-aggressive-2026-10-01`,
   `SENSEX-delta-lean-conservative-2026-10-01`, `TCS-2026-09-29-recenter-relief-r`.
2. Stop the three stock books; erase them (`DELETE ...?mode=paper`, no purge).
3. Erase the four stopped 09-30 delta-lean books (or let Monday's roll do it).
4. Delete the 11 orphan `desk-strategies` rows through
   `DELETE /v1/desk/strategies/:tag/modes/:mode` (and the row when it has no
   modes left) — a `--prune-orphans` flag on the roll that lists rows with no
   registry row and a dated tag shape, dry-run by default.
Everything here is an API call against the running desk; the agent attempts
them and hands the operator the exact commands for anything the box refuses.

### 1c. Workspace

- Delete the five stray JSON files; add `optionConfig_*.json`,
  `cancelledOrders.json`, `rejectedOrders.json` to `.gitignore`.
- Delete the three merged local branches. Leave the stash and remote branches
  (operator's call; listed in the report).
- Find what desk-api logs at ~1 line/sec on a dead weekend and demote it to
  debug or rate-limit it. Not a refactor: one log site, one test if there is
  a natural one.

## WS2 — A stable series name for books in reports and on the Books page

### Decision: keep the dated tag; add a durable `series`

A reused tag breaks the engine (the tag's lifetime `cumRealized` feeds the
day target, backstop and stuck rule — SUP-4), the expiry roll (`expiry` is
part of book identity and immutable), the roll's create-before-retire order,
and the "one clean day per page" rule that killed the E3/E5 pile-ups. So the
tag stays `SYMBOL-variant-YYYY-MM-DD`. What the operator wants — one name to
aggregate a strategy's history across days — is a label, and it must survive
the erase that removes the registry row two sessions later.

### Data

- `series: string` on `BookCreate`/`BookRow` (tag charset, ≤ 64), optional on
  input; when absent the API derives `${symbol}-${variant}`. Immutable: in
  the PATCH forbid list. Not part of identity.
- New collection `desk-book-series`: `{tag, mode, series, symbol, variant,
  createdAt}`, unique `{tag, mode}`, written in the POST new-row branch and
  never deleted by `eraseBook` or by purge.
- Backfill in `migrate.ts`: for every `desk-daily-reports` tag without a
  series row, derive from `desk-audit-log` "registered a book"
  (`detail.symbol + '-' + detail.variant`); for legacy tags with no audit row,
  fall back to the current registry row; anything still unresolved is left
  unlabelled and listed under its own tag (never parse the tag).
- The scripts send `series` explicitly (`planBooks` emits
  `${symbol}-${variant}`); the registration payload test is updated.

### API

- `GET /v1/desk/reports/series?mode=` → `[{series, tags, firstDate, lastDate}]`.
- `GET /v1/desk/reports/history?series=&mode=&from=&to=` → one row per date:
  sums of realised/total/maxProfit/maxLoss/orderCount across the series' tags
  that reported that day, with the existing null discipline (any null total →
  null), plus `tags: [...]` so the UI can open that day's order log.
  `?tag=` keeps working unchanged.
- `/reports/tags` starts honouring `mode` (it is sent and ignored today).
- Registry GET includes `series`.

### Web

- Reports page: the picker lists series first (grouped), then unlabelled tags.
  Picking a series shows the aggregated day rows; clicking a day opens the
  order log for that day's tag(s).
- Books page: `BookCell` shows the series under the tag; rows are grouped by
  series with the running one first.
- No other page changes.

### Strategy rollup across symbols (operator: "consolidate same strategy in nifty/sensex")

The series row carries `symbol` and `variant`, so two groupings fall out of
the same table:
- **series** = `symbol-variant` (NIFTY-delta-lean-aggressive): one line per day.
- **strategy** = `variant` alone (delta-lean-aggressive): NIFTY + SENSEX summed
  per day, each day row listing the tags that contributed.
`/reports/history` accepts exactly one of `tag=`, `series=`, `variant=`.
`/reports/series` returns both the series list and the distinct variants.

### "Easy to look"

The Reports page opens on the strategy view (variants), then series, then
unlabelled tags. Above the day table a summary strip for the selection:
total realised, trading days, winning days, best day, worst day, and a
cumulative column in the table. Expiry days are marked (the book's `expiry`
equals the date) because that is where the losses cluster. Day rows link to
the order log of each contributing tag. Nothing else on the page changes.

### Not doing

Tag parsing anywhere, or renaming existing tags.

## WS3 — Delta-lean intraday review since the cut-over (analysis + defects)

Deliverable: `docs/reports/2026-10-04-delta-lean-review.md`, written from the
data on the box (desk-daily-reports, desk-engine-decisions, desk-decisions,
desk-fills, desk-order-events, desk-gateway-orders, desk-book-marks) for
2026-09-23 → 2026-10-02, with the queries used.

Must answer, with numbers:
1. P&L per series, per day; expiry days vs other days; adjustments per day
   vs P&L; aggressive vs conservative.
2. The 1 Oct SENSEX post-mortem: each decision, what it added, what it cost;
   why `dl_stuck_loss` (25k) and `dl_day_max_loss` (200k) never acted; why
   the 14:50 passive flatten wedged and the 14:55 urgent flatten never fired;
   which record is right about the hedge order (gateway COMPLETE 80 @ 149.15
   vs api WORKING/orphaned) and how much realised P&L is misstated if the
   fill was real.
3. Dial recommendations, each with the exact
   `PATCH /v1/desk/books/registry/:tag` or preset change and the evidence:
   at minimum consider an expiry-day adjustment cutoff, `dl_day_max_loss`
   sized to the book, `dl_max_adjusts_day`, and `dl_open_lots` on SENSEX.
   Recommendations are NOT applied — the operator decides.
4. Code defects found, filed as small fixes in the same branch when they are
   unambiguous: (a) the urgent flatten at `dl_flatten_urgent_min` must fire
   even while a passive package is resting — a resting flatten order cannot
   wedge the book past `dl_flat_by_min`; (b) whatever makes the gateway and
   api disagree about that fill. Each fix with a test pinning the case.

## WS4 — Mirrors: reach optionbhai at the origin, stop the hammering, switch on

- `apps/runner/src/main.ts` passes `baseUrl`/`socketUrl` from env:
  `OPTIONBHAI_BASE_URL`, `OPTIONBHAI_SOCKET_URL` (defaults unchanged), plus
  `OPTIONBHAI_HOST_HEADER`: when set, fetch sends `Host: <value>` and the
  WebSocket is opened with that header, so a direct-IP connection still hits
  the right vhost. `ws` takes `headers` in its options; undici fetch allows
  setting `host` on the request headers.
- Retry: exponential backoff 5 s → 5 min with jitter; after an HTTP 403 the
  next attempt waits at least 10 min, and the body's first 200 chars and any
  `cf-ray` header are logged once per failure burst so the next block is
  diagnosable.
- A `User-Agent: algomaker-desk-runner/<version>` header on every request.
- `.env.local` gets `OPTIONBHAI_BASE_URL=http://13.202.244.113`,
  `OPTIONBHAI_SOCKET_URL=ws://13.202.244.113`,
  `OPTIONBHAI_HOST_HEADER=optionbhai.com`. Plain HTTP carries the login
  password and token in clear across the internet; the report says so and
  names the alternative (a Cloudflare WAF allow rule for this box's egress
  IP keeps TLS). The operator chose the IP; this implements it.
- `docs/DEPLOYMENT.md` gains the three variables and fixes the
  `OPTIONBHAI_TEST3_*` / A010 drift the code map found.
- Enable: after the operator restarts desk-runner (env is read at start),
  `PATCH /v1/desk/strategies/<tag> {"modes":{"paper":true}}` for
  MIRROR_1PBUY, MIRROR_A006, MIRROR_A010, MIRROR_EMA2050 (paper only; live
  stays off). The runner picks the switch up within 15 s. The agent issues
  these after the restart if the session is still open; otherwise the
  commands are in the hand-over.
- Tests: client unit tests for header injection, backoff schedule, and the
  403 cool-off, using the injectable `fetch`/`openSocket` deps that already
  exist.

## WS5 — Three October stock books, the September way, as a script

`scripts/stock-books.mjs`, modelled on `delta-lean-books.mjs` (paper-only
constant, dry run by default, `--apply`, `--json`):
- Books: `TCS-2026-10-27-recenter-relief-r`, `TATASTEEL-2026-10-27-recenter-relief-r`,
  `KALYANKJIL-2026-10-27-recenter-relief-r`; dials exactly as September;
  `series: <SYMBOL>-recenter-relief-r` once WS2 lands (harmless if the API
  predates it — unknown keys are refused, so the script sends it only when
  the registry GET already returns a `series` field).
- `--register`: create, start, switch on (same three calls as September).
  Safe to run on a Sunday; an empty recenter book does nothing.
- `--open`: market hours only (refuses outside 09:20–15:00 IST on a trading
  day). Reads the October future's live mark, picks the ATM strike, wings at
  the strike nearest ±9 % of spot, sizes 5 / 5 / 2 lots (TCS / TATASTEEL /
  KALYANKJIL, as September), submits the four entry orders through
  `/v1/desk/submit` in paper, waits for fills, then `POST /v1/desk/seed`
  with the filled rates — the exact September sequence, written down.
  Refuses if the book already holds legs.
- Runbook section `docs/runbooks/stock-books.md`: Monday 09:35 IST
  `node scripts/stock-books.mjs --open --apply`.
- Tests: pure strike/size selection and the two-phase plan, pinned like the
  delta-lean registration test.

## Delivery

- Opus subagents, one per workstream, each in its own git worktree with its
  own `npm ci`; the api Mongo suites are run only once, on the merged tree.
- Review: each branch gets a code review (correctness first) before merge.
- Merge to master, `make check` on the merged tree, push, build the
  dashboard.
- Hand-over to the operator: the restart (desk-api, desk-supervisor,
  desk-gateway, desk-marketdata, desk-runner — never mid-session), then the
  1b retirement calls, the mirror switch-on, and Monday's stock-book open.
