# Traders — read-only analytics of a trader's ODIN files

The Traders app reads the trade and order files each trader's ODIN writes, and
shows their books (legs, payoff), orders, trades and a log. It places no order
and imports no order code. This page brings it up without touching the live
desk. Commands run from `/opt/algomaker-delta` unless said otherwise.

## 0. Read this first

- **Plain HTTP, port 80, a bare IP is fine. No HTTPS.** Operator decision,
  accepted: every watcher token, every password, every position crosses the
  network unencrypted, and the session cookie is not `Secure`. Anyone on the
  path can read or replay them. Revisit only if port 443 and a hostname appear.
- **It never touches the desk.** `desk-traders` can be stopped any time with
  `npx pm2 stop desk-traders`; no desk process depends on it. It runs in its
  own pm2 namespace, `traders`, so `make down` and `make clean` (namespace
  `desk`) leave it alone.
- **Two operator steps** (the agent cannot do them): the Caddy change (section 3)
  and one `desk-marketdata` restart (section 4).

## 1. What runs

| Piece | Where |
|---|---|
| `desk-traders` (pm2, own file `ecosystem.traders.config.cjs`) | `127.0.0.1:8794` (`TRADERS_PORT`), 900M memory cap |
| Caddy `:80` site (shared with the desk, by path) | serves `apps/web/dist-traders` at `/traders/`, proxies `/v1/traders/*` to `127.0.0.1:8794` |
| `desk-subscriptions` document `{source:'traders'}` | the tokens desk-traders wants priced, refreshed every 15 s |
| `watcher.exe` on each trader's Windows PC | uploads ODIN's `OnLineBackup` files |

`desk-traders` is NOT in `ecosystem.desk.config.cjs`. Routine desk deploys
(`make deploy`, `make restart`, `make up`) do not start, restart or stop it.

## 2. Before first start (operator)

Add to `.env.local` (the page's origin, section 3; no trailing slash, scheme required):

```sh
TRADERS_ORIGINS=https://delta.optionbhai.com
# optional: TRADERS_PORT=8794   TRADERS_SESSION_TTL_MS=...   TRADERS_MAX_TOKENS=2000   TRADERS_MARKET_WATCH_MAX_TOKENS=1000
```

`TRADERS_ORIGINS` is a comma-separated list of exact origins
(`http://203.0.113.10`, or with a port). Boot refuses `*`, `null`, a trailing
slash, a path, or a missing scheme. Empty boots, with a warning in the log, but
then no browser can save anything (log in, add a leg). `TRADERS_MONGO_URL`
defaults to the desk's `DESK_MONGO_URL`. `TRADERS_MAX_TOKENS` (default 2000)
caps the feed tokens desk-traders declares (section 5).
`TRADERS_MARKET_WATCH_MAX_TOKENS` (default 1000, or `TRADERS_MAX_TOKENS` when
lower) caps the part of that declaration Market Watch may use (section 17.2);
set, it must not exceed `TRADERS_MAX_TOKENS`, or desk-traders refuses to start.
pm2 keeps a process's env across restarts: `npx pm2 startOrRestart … --update-env`
adds and changes keys but never removes one (pm2's restart merges the new env
into the one it saved), so a key the ecosystem file passes only when
`.env.local` sets it (`TRADERS_SESSION_TTL_MS`, `TRADERS_MARKET_WATCH_MAX_TOKENS`)
keeps its last value after it is taken out of `.env.local`; to drop it, run
`npx pm2 delete desk-traders`, then `npx pm2 start ecosystem.traders.config.cjs --only desk-traders`
and `npx pm2 save` (operator restart).

## 3. Caddy (operator step)

Editing Caddy is the operator's step. Traders is served over HTTPS on its own
name, `delta.optionbhai.com`; the desk stays on `http://<box-ip>/` as it is
(its page calls its API at `<page hostname>:8790` over plain HTTP, so it cannot
move behind HTTPS without a change of its own). Plain HTTP on the IP would send
traders' passwords and watcher tokens in clear, so traders is not served there.

Before: the domain's DNS record is an A record to the box's IP with the
Cloudflare proxy OFF ("DNS only", the grey cloud) — Caddy gets and renews the
certificate itself, which fails behind the proxy, and the proxy does not carry
the desk's port 8790 either. The instance's security group allows TCP 443 in
(80 is already open for the desk).

`/etc/caddy/Caddyfile` (the desk's `http://:80` block is unchanged):

```
# No HTTP/3: it needs UDP 443 open as well, and a browser that tries it and fails
# shows ERR_QUIC_PROTOCOL_ERROR. TCP 443 (HTTP/1.1 and HTTP/2) is enough.
{
    servers {
        protocols h1 h2
    }
}

delta.optionbhai.com {
    handle /v1/traders/* {
        reverse_proxy 127.0.0.1:8794
    }
    redir /traders /traders/
    handle_path /traders/* {
        root * /opt/algomaker-delta/apps/web/dist-traders
        # the phone-alerts manifest (section 19): Caddy serves .webmanifest with no Content-Type
        @manifest path *.webmanifest
        header @manifest Content-Type application/manifest+json
        try_files {path} /traders.html
        file_server
    }
    handle {
        redir * /traders/
    }
}

http://:80 {
    root * /opt/algomaker-delta/apps/web/dist
    file_server
}
```

- Traders open `https://delta.optionbhai.com/traders/`. The page is built with
  base `/traders/`, so its assets load from `/traders/assets/...` and never
  collide with the desk's `/assets`.
- The watcher's `server` is `https://delta.optionbhai.com` (it posts to `/v1/traders/...`).
- `TRADERS_ORIGINS` is `https://delta.optionbhai.com` (the page's origin, section 2).

Validate, reload, then confirm the desk is untouched (the first HTTPS answer
waits for the certificate, a few seconds):

```sh
caddy validate --config /etc/caddy/Caddyfile
sudo systemctl reload caddy
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1/      # desk page: 200
D=delta.optionbhai.com
curl -s -o /dev/null -w '%{http_code}\n' --resolve $D:443:127.0.0.1 https://$D/traders/            # 200
curl -s -o /dev/null -w '%{http_code}\n' --resolve $D:443:127.0.0.1 https://$D/v1/traders/health   # 200
```

Open the desk page at `http://<box-ip>/` in a browser too and check it loads.
A browser that still shows `ERR_QUIC_PROTOCOL_ERROR` remembers HTTP/3 from the
Cloudflare proxy: a private window, or a browser restart, clears it.
A 20 MB upload body is accepted by the app; Caddy imposes no body limit here.

## 4. Widen `DESK_UNIVERSE` — OPERATOR STEP, one restart of desk-marketdata only

Do it while the desk's books are flat. The universe drives the instrument
sync's row filter, and the enctoken canary's spot token (the first name in the
list). It does not drive subscriptions: those come from books and declarations.
Widening it lets the instrument master know every stock a trader might hold.
After this one restart, a new trader stock needs no restart.

1. Build the list. Keep the current list's order (its first name is the
   canary's), then every F&O underlying after it. The desk's own freeze table
   already names them (NSE's, and SENSEX and BANKEX from BSE's), with no call out:

   ```sh
   mongosh algomaker --quiet --eval 'print(db["desk-freeze-limits"].find({$or:[{source:{$exists:false}},{symbol:{$in:["SENSEX","BANKEX"]}}]}).toArray().map(r=>r.symbol).sort().join(","))'
   ```

   Or, on a machine that may reach Kite:

   ```sh
   curl -s https://api.kite.trade/instruments/NFO | awk -F, 'NR>1 && $11=="NFO-OPT" {gsub(/"/,"",$4); print $4}' | sort -u | paste -sd,
   ```

2. Before: record the desk's subscription, the instrument count, and the
   memory of desk-api, desk-runner and desk-supervisor (they load the master).

   ```sh
   curl -s http://127.0.0.1:8790/v1/desk/feed          # note subscribedTokens
   mongosh algomaker --quiet --eval 'db.instrument.countDocuments({})'
   npx pm2 ls                                         # note the memory column of desk-api, desk-runner, desk-supervisor
   ```

3. Set `DESK_UNIVERSE=<the current list>,<the rest>` in `.env.local`, then sync
   the master by hand and restart desk-marketdata. The restart alone does not
   sync: a desk-marketdata that boots after 08:45 IST counts today's sync as done,
   so without the hand sync the wider master would land at the next 08:45 sync and
   reach the desk processes at the open. The value has `&` in it (`M&M`): never
   `source` `.env.local` in a shell.

   ```sh
   DESK_UNIVERSE="$(grep '^DESK_UNIVERSE=' .env.local | cut -d= -f2-)" node apps/api/src/cli.ts sync
   npx pm2 startOrRestart ecosystem.desk.config.cjs --only desk-marketdata --update-env
   ```

   The sync prints its counts (`inUniverse`, `upserts`; `deletes` 0). On
   20 Oct 2026, 28 names to 225 took the master from 10,105 rows to 43,167.

4. After: `subscribedTokens` is unchanged (desk-traders is not started), the
   instrument count is larger. Watch `npx pm2 ls` memory of desk-api, runner and
   supervisor through their next 15-minute master refresh (desk-api logs
   `instrument master refreshed {"contracts":…}`).

5. **Revert if memory is high.** If any of them is above 80 % of its
   `max_memory_restart` after that refresh — desk-api above 480M (cap 600M),
   desk-runner above 1200M (cap 1500M), desk-supervisor above 720M (cap 900M) —
   put the old `DESK_UNIVERSE` back in `.env.local` and restart desk-marketdata
   again with the same command as step 3. pm2 would otherwise restart that
   process at its cap mid-session.

## 5. Start desk-traders (operator)

desk-traders' declaration joins the desk's Kite feed pool (a socket per 900
tokens; a failing socket re-logs-in and reconnects every socket), and every
tick reaches every bus client, the order gateway included. Per held month it
asks for spot, futures, the held strikes and ATM ± 15 strikes (62 tokens), so
about 20 trader stocks add about 2,600 tokens to the desk's about 1,558.
`TRADERS_MAX_TOKENS` (default 2000) caps it: over the cap the ATM windows
narrow to 10, 5, then 0 strikes each side, far months first; spots, futures
and held strikes are never dropped. Health shows `tokenCap` and
`tokenCapHit`; a narrowed book warns "price coverage reduced".

**First start outside market hours** (before 09:00 or after 15:40 IST, or a
holiday).

1. Before: record the desk's subscription and marketdata's socket count.

   ```sh
   curl -s http://127.0.0.1:8790/v1/desk/feed                               # note subscribedTokens
   grep 'socket count changed' logs/desk-marketdata-out.log | tail -1       # note sockets
   ```

2. Start:

   ```sh
   npm run build --workspace @algomaker/web          # builds dist (desk) and dist-traders (this app)
   npx pm2 startOrRestart ecosystem.traders.config.cjs --only desk-traders --update-env   # not the span job: section 15
   curl -s http://127.0.0.1:8794/v1/traders/health   # tokenCap, tokenCapHit, declaredTokens
   npx pm2 save                                      # so a reboot brings desk-traders back with the desk
   ```

3. Watch for 10 minutes: `tail -f logs/desk-marketdata-out.log | grep 'socket count changed'`
   (one more socket per 900 tokens is expected; repeated changes are not), and
   the gateway's CPU in `npx pm2 monit` (desk-gateway should stay where it was).

4. **IMMEDIATE ROLLBACK** if sockets flap, the gateway's CPU climbs, or the desk
   feed misbehaves:

   ```sh
   npx pm2 stop desk-traders
   mongosh --file scripts/traders-clear-subscriptions.mongo.js
   ```

   The script empties desk-traders' one declaration (`desk-subscriptions`
   `{source:'traders'}`); without it desk-marketdata keeps honouring a stopped
   app's last declaration for 10 minutes. It touches nothing else. Then check
   `subscribedTokens` is back to the value from step 1.

Caddy serves the build off disk, so a web rebuild is live at once, no restart.
After widening `DESK_UNIVERSE`, watch `desk-traders` memory in `npx pm2 ls`
(restarts itself above 900M; `npx pm2 logs desk-traders` shows it).

## 6. First admin

```sh
TRADERS_MONGO_URL=mongodb://127.0.0.1:27017/algomaker node bin/traders-user.mjs create-admin <username>
```

It prompts for a password (avoid `--password`: it lands in shell history).
Other commands: `reset <username>`, `unlock <username>`, `list`.

## 7. Add a trader and issue a token

Sign in at `http://<box-ip>/traders/` as the admin, open the Admin tab:

1. Add trader (a username and password for the trader's own login).
2. Issue token. It is shown ONCE. Over plain HTTP the Copy button may not work;
   the token is selected, so press Ctrl+C. Paste it into that trader's `watcher.json`.
3. Revoke token or issue a new one any time; the old one stops at once. The
   page shows the token's last-used time.

## 8. Install the watcher on a trader's PC

On the box: `make watcher`, giving `apps/watcher/dist/watcher.exe` and the
download `apps/watcher/dist/delta-desk-watcher.zip` (the exe, `install.cmd`,
`install-watcher.ps1`, `README.txt`), served by Caddy at
`https://delta.optionbhai.com/download/delta-desk-watcher.zip` (a rebuild updates it).

**With the installer (usual):** on the PC, download the zip, Properties → Unblock,
Extract All, double-click `install.cmd`, paste the token, confirm the OnLineBackup
folder it finds. It writes `C:\Traders\watcher.json` (server
`https://delta.optionbhai.com`, UTF-8 without a BOM, readable by that user only),
copies the exe, adds a "Delta Desk watcher" shortcut to the user's Startup folder
(no admin needed; it removes the "Traders Watcher" task below if present) and
starts it. Running it again updates; Enter keeps the token and folder.

**By hand:** copy
`watcher.exe` and `watcher.json` to `C:\Traders\` on the PC. It watches ODIN's
`OnLineBackup` folder (inside the ODIN install, e.g. `C:\ODIN\Diet\OnLineBackup`;
under Program Files its VirtualStore twin is watched automatically):

```json
{ "server": "https://delta.optionbhai.com", "token": "<token>", "folder": "C:\\ODIN\\Diet\\OnLineBackup",
  "include": ["*/Trades/*TRD.TXT", "*/Orders/*.txt", "*/Orders/*.TXT"] }
```

`server` is `https://delta.optionbhai.com` with no path (a path is refused; `http` to a bare
IP is accepted). The token is at least 20 characters.

Run it at logon with a scheduled task, then start it now:

```
schtasks /Create /TN "Traders Watcher" /TR "C:\Traders\watcher.exe" /SC ONLOGON /RL LIMITED /F
schtasks /Run /TN "Traders Watcher"
```

How it behaves: it polls the folder every second (no fsnotify), uploads a file
after 2 s of quiet, and for an appended file (ODIN appends to the day's `MMDDTRD.TXT`)
sends only the new bytes. On first start it uploads the folder's whole history.
Failed sends retry every 30 s; a heartbeat goes every 60 s; the folder is
rescanned every 5 minutes. Status: `C:\Traders\watcher.log`, and the heartbeat
on the admin page within 60 s. Updating: copy the new `watcher.exe` over,
`schtasks /End /TN "Traders Watcher"`, then `/Run`.

## 9. What the files give, and what must be added by hand

Legs are the sum of every trade in the folder (VolHedge's net-price rule). The
book says "Trade history starts <date>". Not in any trade file:

- positions opened before that date;
- shares delivered at expiry by physical settlement of stock options.

Fix with the opening balance (section 10) or a manual leg (Add leg on the book).
Expired contracts drop off the tabs the day after expiry.

**Opening balance.** A canonical positions CSV is the positions at the CLOSE of
the date in its file name, `positions-<YYYY-MM-DD>.csv`. A file without a date
is refused. Uploading one REPLACES the trader's whole balance (not a top-up),
so include every position. Trades on or before that day are not counted again.

**Problems show on the book.** Skipped ODIN lines and failed files appear as
warnings on the trader's book (dated when not today). An internal error retries
automatically every 30 s.

## 10. Manual upload

Admin tab, Upload file, for a trader; it also takes an ODIN file with its
relative path. Canonical CSVs (header line exact; `qty` signed shares for
positions; positive for orders and trades, with `side` Buy or Sell; `time` ISO 8601
WITH offset). Example rows use placeholders:

```
positions-2026-10-16.csv
client_code,stock,instrument,expiry,strike,type,qty,avg_price
CLIENT1,TCS,option,2026-10-27,3000,CE,-1125,42.50

orders.csv
order_no,exch_order_no,client_code,stock,instrument,expiry,strike,type,side,qty,price,status,reason,time
1001,,CLIENT1,TCS,option,2026-10-27,3000,CE,Sell,1125,42.50,Traded,,2026-10-19T09:35:00+05:30

trades.csv
trade_no,order_no,client_code,stock,instrument,expiry,strike,type,side,qty,price,time
5001,1001,CLIENT1,TCS,option,2026-10-27,3000,CE,Sell,1125,42.50,2026-10-19T09:35:02+05:30
```

`instrument` is `option`, `future` or `share`; `type` is `CE` or `PE` (blank for
future and share); `expiry` is `YYYY-MM-DD` (blank for a share). Positions
`qty` is signed shares (negative is short).

A positions file is the book at the close of the date in its name, and trades
on or before that date are not counted again. So it is refused while its date
has not closed: a later date, or today before 15:40 IST (the F&O close since 3 Aug 2026). Send the same file
again after the close and it is applied.

## 11. Verification

| Check | Command | Expected |
|---|---|---|
| App is up | `curl -s http://127.0.0.1:8794/v1/traders/health` | 200, `ok:true`, `busConnected:true`, `feedAlive:true`, `masterContracts` large, `declaredTokens` > 0 once a trader has legs, `tokenCap` 2000 (or `TRADERS_MAX_TOKENS`), `tokenCapHit:false` |
| Through Caddy | `curl -s http://<box-ip>/v1/traders/health` | same JSON |
| Desk page unchanged | open `http://<box-ip>/` | the desk loads as before |
| Declaration is refreshing | `mongosh algomaker --quiet --eval "db['desk-subscriptions'].findOne({source:'traders'}).updatedAt"` | within the last 15 s (run twice) |
| Desk subscription rises only after desk-traders declares | `curl -s http://127.0.0.1:8790/v1/desk/feed` | `subscribedTokens` equals the pre-start value (section 4) until desk-traders is started, then rises by about `declaredTokens` |
| Trader login | sign in as a trader | tabs Books and Orders (Orders has Orders, Trades, Log); no Admin tab |
| Admin login | sign in as admin | the extra Admin tab; each trader shows a watcher heartbeat within 60 s of the watcher starting |
| Live trade | a trade in ODIN | on the trader's tab within about 10 s |
| Network loss | unplug the PC's network for 10 minutes | nothing lost; the queue drains on reconnect |
| Same as VolHedge | compare a trader's leg quantities and net prices for the same book | equal (see section 12 for known exceptions) |
| New stock | a trader's first leg in a stock not seen before | priced within a minute, no restart |
| Repo checks | `make check` | green, including the import-rule and ownership suites |

## 12. Questions to settle with a trader

1. ODIN order status codes 1 and 6: we read them as Open and Rejected. Confirm against ODIN's Order Book. Also 3 Partly traded, 4 Traded, 5 Cancelled.
2. The BSE side column: our reading of Buy/Sell. Confirm one SENSEX trade against the BSE Trade Book. BSE order files are stored, not parsed.
3. The equities order file's quantity column: check a partly traded equities order.
4. Did the copy miss a JINDALSTEL Oct 1000 PE trade? VolHedge shows 22.80, the files give 23.00.
5. Is 20 Oct an NSE trading day?
6. VolHedge fields still labelled as our reading in the app.

## 13. Restarts and stops

```sh
npx pm2 restart desk-traders
npx pm2 stop desk-traders
```

Neither touches a desk process. `desk-marketdata` restarts remain the operator's.

## 14. Troubleshooting

- **Watcher "token rejected"**: the token was revoked, or the trader is disabled. Issue a new one (section 7).
- **"did not parse"** on a file: open `GET /v1/traders/files` (signed in) for the reason; ODIN lines it skipped show as warnings on the book.
- **"price coverage reduced"** on a book: the declaration is at `TRADERS_MAX_TOKENS` and that book's ATM window was narrowed (`tokenCapHit:true` in health). Raise the cap in `.env.local` only after section 5's socket and gateway checks pass at the higher count, then `npx pm2 startOrRestart ecosystem.traders.config.cjs --only desk-traders --update-env` (the file reads `.env.local`).
- **"not understood"** on a leg: the underlying is missing from `DESK_UNIVERSE` (section 4), or the strike is not listed.
- **A leg's quantity is short of ODIN's**: a position from before the history start. Upload an opening balance or add a manual leg.
- **Browser cannot save / login fails**: `TRADERS_ORIGINS` is empty or not exactly the page's origin (scheme, IP, port).
- **Boot refuses**: the message names the bad `TRADERS_ORIGINS` entry; `npx pm2 logs desk-traders`.
- **Locked out**: `node bin/traders-user.mjs unlock <username>` (add `TRADERS_MONGO_URL` as in section 6).

## 15. SPAN job (operator)

`scripts/span_job.py` only downloads and saves NSE's files; it computes nothing. The traders app reads what it saves. It runs as the pm2 app `desk-traders-span` (in `ecosystem.traders.config.cjs`, namespace `traders`), from cron every 15 minutes, 08:30-20:15 IST, Mon-Fri.

1. Create the venv (needs the network, operator only):
   ```sh
   python3 -m venv /opt/algomaker-delta/.venv-nse && /opt/algomaker-delta/.venv-nse/bin/pip install nsepythonserver
   ```
2. Run one download by hand (O2): `.venv-nse/bin/python scripts/span_job.py` (add `--date YYYY-MM-DD` for another day). It prints one line per file: `saved`, `not yet` or `failed: <reason>`.
3. Tick V-J1 to V-J4 against what landed: V-J1 the fetch worked through `nsepythonserver`'s headers (a `not yet` line is HTTP 404 only; `failed: HTTP 403` means NSE is blocking the client and the call needs its session cookies: report it); V-J2 the file names and URLs; V-J3 how many intraday SPAN files (`i1`-`i5`) exist and when; V-J4 the unzipped `.spn` size.
4. Start the cron job: `npx pm2 start ecosystem.traders.config.cjs --only desk-traders-span`.

Files land in `$TRADERS_NSE_DIR` (default `/opt/algomaker-delta/data/nse`), one folder per business date, `YYYY-MM-DD/`, each with a `manifest.json` (`name`, `url`, `savedAt` in epoch ms, `bytes`, `sha256` per file). Zips are saved unzipped (`.spn`, `.csv`); a file already in the manifest is not fetched again. Alongside today's files the job saves the previous weekday's end-of-day SPAN, F&O and cash bhavcopy into that day's own folder.

Retention is 7 days: each run removes dated folders older than that. Logs: `logs/desk-traders-span-out.log`, `-err.log`.

**Vol job** (`scripts/nse_vol_job.py`, pm2 `desk-traders-vol`, 20:20 IST Mon–Fri): the held stocks' near/next-month chains (NSE's IV plus the day's FO bhavcopy) and NSE's CMVOLT file into `vol/<date>.json`, kept 400 days; the Vol page and the market context read them. Same venv. Check, start and the backfill order: `docs/superpowers/specs/2026-10-23-traders-vol-addendum.md` §8.

**Disk use.** A day holds up to six SPAN files (`i1`-`i5` and the end-of-day `.s.spn`) at tens of MB each, plus the two bhavcopies and the exposure file: about 6 × 40 MB ≈ 250 MB a day (the review's full-size synthetic `.spn` was 37 MB; V-J4 gives the real size), so about 1.7 GB for the 7 days kept. The box was at 87 % used (22 GB free) when Release 2 was reviewed. After the first full day check both: `du -sh /opt/algomaker-delta/data/nse` and `df -h /opt/algomaker-delta`. If the disk is tight, keep fewer days: retention is the `keep_days=7` default of `prune()` in `scripts/span_job.py` (the next run prunes to it). The app needs only the newest business date's SPAN folder and the previous trading day's bhavcopies, so 4 days covers a long weekend.

**Parse cost (a known Release 2 limit).** desk-traders parses each new SPAN file once, on its one thread: up to a few seconds per file (about 2 s for the 37 MB synthetic one), during which its pages and the watchers' uploads wait. It never parses more than one file a minute, the newest first; a day's older files (they only feed the peak line) are read one a minute after it, and until they are all in the margin box says `Peak = highest of <DD Mon>'s NSE SPAN files — <k> of <n> read so far (our reading of VolHedge's peak-margin line)`. Boot never waits for a parse: the first read starts once the server listens. The desk processes are not affected.

## 16. Release 2 (operator)

Release 2 adds the Analysis and Scenario tabs, the payoff sliders, NSE SPAN and exposure margin, and charges. It places nothing. Its only write is the `charges` document in `traders-settings`. Desk processes are not involved.

In this order:

1. Install, build and restart onto the new build (operator restart). `apps/traders` now imports the new workspace package `@algomaker/span`: without its `node_modules/@algomaker/span` link a bare `npx pm2 restart desk-traders` boots into `ERR_MODULE_NOT_FOUND` and crash-loops while pm2 shows it online, taking the Release 1 screens down with it. If `desk-traders` has never been started, do section 5 first.

   a. **Outside market hours** (before 09:00 or after 15:40 IST), from `/opt/algomaker-delta`:

      ```sh
      npm ci
      ```

      Never in session: `npm ci` deletes and rebuilds `node_modules` under the running desk processes (which is why `scripts/deploy.sh` runs it only when the lockfile changed, before its own restart). The in-session alternative is the one link:

      ```sh
      ln -sfn ../../packages/span node_modules/@algomaker/span
      ```

      The controller created that link when Release 2 was merged, so `ls -l node_modules/@algomaker/span` should already show it; `npm ci` makes it permanent.

   b. Build the page (the controller also builds at merge; building again is harmless):

      ```sh
      npm run build --workspace @algomaker/web          # builds dist (desk) and dist-traders (this app)
      ```

      Caddy serves `apps/web/dist-traders` off disk: the new tabs are live once the build ends.

   c. Restart desk-traders, re-reading the ecosystem's env (a bare `pm2 restart` keeps the old env, so a `TRADERS_NSE_DIR` set in `.env.local` would be missed), then check it is up:

      ```sh
      npx pm2 startOrRestart ecosystem.traders.config.cjs --only desk-traders --update-env
      curl -s http://127.0.0.1:8794/v1/traders/health
      ```

      Expected: HTTP 200 with `ok:true`, `busConnected:true`, `feedAlive:true`, `masterContracts` large, `declaredTokens` > 0 once a trader has legs, `tokenCap` 2000 (or `TRADERS_MAX_TOKENS`), `tokenCapHit:false` — as section 11. If it does not answer, `npx pm2 logs desk-traders --lines 50`; an `ERR_MODULE_NOT_FOUND` naming `@algomaker/span` means step a was skipped.

   The SPAN store is always built: margin appears once the span job has saved a file, with no further restart.
2. Create `.venv-nse` and run ONE download by hand, then tick V-J1 to V-J4: section 15, steps 1 to 3. Do not start the cron job before the hand run is clean.
3. Start the cron job and keep it across reboots:
   ```sh
   npx pm2 start ecosystem.traders.config.cjs --only desk-traders-span
   npx pm2 save
   ```
   Check the next quarter-hour's line in `logs/desk-traders-span-out.log`: `saved`, `not yet` or `failed: <reason>`. `failed: HTTP 403` means NSE blocks the client (section 15, step 3). After the first full day, check the disk (section 15, Disk use).
4. The admin opens Admin, then Charges, checks every seed value against the current statutory rates and against each trader's brokerage (Q5), and saves. Until then the Charges page shows `Seed values — not confirmed. Check each against the current rates before saving.` and every MTM block shows `Rates not confirmed by admin — expenses are estimates`. After the save the Charges banner reads `Confirmed by <admin> on <DD Mon YYYY>` and the MTM banner goes.
5. When the Phase 0 golden SPAN portfolios (Q6) arrive, do Task 8 Step 6: add the cases under `packages/span/test/golden/` (see its README) and flip `MARGIN_CHECKED` in `apps/traders/src/analytics/margin.ts` to `true` in the same change. Until then the golden test reports one skip, and every margin box says `Not yet checked against a broker's margin figure (Phase 0 Q6)`.

What a missing file looks like (nothing is estimated):

- No SPAN file saved yet: the margin box shows no figure and says `No NSE SPAN file yet — margin appears once the span job has saved one`; the other tabs are unaffected.
- No end-of-day file for the previous business day: the MTM block shows Previous and Total as `—` with `NSE end-of-day file <name> for <DD Mon> is missing — Previous MTM unknown`, and the Scenario grid says `Grid, chart and table: P&L against net price — yesterday's close is unknown (see the MTM block)`.
- A book whose options trade on BSE (SENSEX, BANKEX): `<STOCK> trades on BSE; NSE's end-of-day files do not cover it — Previous MTM unknown`.
- A contract or a rate the margin cannot place: Tot. Marg. reads `<lakhs> (partial)` and a note names it — `not in the SPAN file: <contract> — the figure is partial`, or `exposure rate for <SYM> missing from <file> — the figure is partial`.
- Before 09:15 IST on a trading day, and all day on a weekend or holiday, the MTM block ("Day MTM") has no day figure: Gross, Expense, Day MTM and Proj. MTM read `—` (tooltip `market opens 09:15` or `market closed today`) with the note `Day MTM is not shown — <reason>`. Before the open the only LTP is the last session's tick, and that tick against yesterday's NSE close is basis noise, not P&L. After the 15:40 close the day's figures stay.
- Three P&L names, three definitions (spec G5): "Day MTM" is the block's total, carried legs from yesterday's close plus today's trades less the charges on today's fills only (the open cycle's earlier charges are in "Charges (series)", not in it); "Open P&L" is the open legs against their net price, before charges (under the greeks and on the Portfolio page; the Gap panel's "vs value now" is a different figure, with the model at spot where a leg has no LTP); "Series P&L" is open + booked − charges. A page never shows one under another's name: where the Day MTM is unknown it reads `—`.

Rollback: `npx pm2 stop desk-traders-span`. There is nothing else to undo: Release 2 writes only the `traders-settings` charges document, and the older `desk-traders` build needs no change to it.

## 17. Release 3 (operator)

Release 3 adds Market Watch, the portfolio and group views, the delta band with its events, advice, and repair search. It places nothing: no Apply, Place or Submit control exists on any of it. It needs one `desk-traders` restart (operator) and the web build (`dist-traders`). desk-marketdata needs none. Band events start on the first session minute after the restart. It writes three things, all in `desk-traders`' own database: `traders-events`, `traders-groups`, and `traders-settings` documents of kind `band`. Its only desk write is the one token declaration it already makes.

If desk-traders has never been started, do section 5 first. If section 16 is not done, do its step 1 a–c; one restart covers both.

Release 3 also edits `packages/desk-engine` (the `trader` preset and the optional future leg kind). That takes effect at the desk's own next restart, not at this one. Desk decisions are identical: a desk leg never carries `kind`, and every existing engine test passes unedited.

In this order:

1. Restart onto the new build, then build the page (operator restart), from `/opt/algomaker-delta`. Release 3 adds no workspace package, so there is no `npm ci` step.

   a. **Outside market hours** (before 09:00 or after 15:40 IST), restart desk-traders first, re-reading the ecosystem's env (Release 3's ecosystem file passes `TRADERS_MARKET_WATCH_MAX_TOKENS` when `.env.local` sets it, and a bare `pm2 restart` keeps the old env), then check it is up:

      ```sh
      npx pm2 startOrRestart ecosystem.traders.config.cjs --only desk-traders --update-env
      curl -s http://127.0.0.1:8794/v1/traders/health
      ```

      Expected: as section 16 step 1c. If it does not answer, `npx pm2 logs desk-traders --lines 50`.

      The restart goes before the build, or in the same window: the Release 3 server only adds endpoints, so a Release 2 page works against it, but a Release 3 page against a Release 2 server shows errors. Do both outside market hours.

   b. Build the page (the controller also builds at merge; building again is harmless):

      ```sh
      npm run build --workspace @algomaker/web          # builds dist (desk) and dist-traders (this app)
      ```

      Caddy serves `apps/web/dist-traders` off disk: the page itself is live once the build ends, with no restart. The pages call endpoints the old `desk-traders` does not have, so step a comes first.

2. Do the checks below, in session if you can: the band and advice need live quotes.

Checks after the restart:

- Market Watch for TCS and for NIFTY shows three chains each (table under Market Watch below).
- A book's Advice sub-tab shows a card whose notes start with the history line (`historyFrom`: positions come from trade files, so anything opened before the history starts, and shares delivered at expiry, count only as manual legs).
- The first "Find repairs" on a book returns plans, and `npx pm2 logs desk-traders --lines 50` shows no worker error. The repair search runs in 2 worker threads inside `desk-traders`, about 70 MB once both have run.
- `GET /v1/traders/portfolio` as a trader answers 200.

New collections written (all by `desk-traders`, nothing by a desk process):

- `traders-events`: a band event each time a book goes in or out of its delta band, written from the first session minute after the restart. None is written outside the session.
- `traders-groups`: a trader's groups of legs within a book.
- `traders-settings`, documents of kind `band`: one per trader, `{ kind: 'band', trader, bands: { <STOCK>: <lots> }, updatedAt }`, the per-book band overrides. The collection's unique index is on `{ kind, trader }`, hence one document per trader.

Left out of Release 3: Task 16, NSE's IV column in Market Watch. It was skipped because the operator's NSE download test (section 15 and section 16 step 2) has not passed yet. Nothing in the page is missing for it; the column is simply not there.

Rollback: `git checkout 0e07dd91` (Release 2) in `/opt/algomaker-delta`. That checkout is also the desk's, so it moves the desk's code and `packages/desk-engine` too; do it only with the desk's own restart rules in mind (the desk processes keep running the code they loaded until their own restart). Then rebuild the page (`npm run build --workspace @algomaker/web`), and run the same `npx pm2 startOrRestart ecosystem.traders.config.cjs --only desk-traders --update-env`. Nothing needs undoing in the data: the older `desk-traders` does not read `traders-events`, `traders-groups` or the `band` settings documents, and leaves them as they are.

### 17.1 Repair search

A book's Repair card (`POST /v1/traders/books/<STOCK>/repair`) runs the desk's repair search (`searchRepairs`, the same four goals as the desk's panel) inside `desk-traders`, in **2 worker threads** (node:worker_threads). There is no new process, pm2 entry, env var or collection: it is there once `desk-traders` runs a build that has it (operator restart, as in section 16 step 1c). It is read only — a plan offers only "Show on payoff", which opens the book's Scenario tab with the plan's legs as hypothetical rows. Nothing is placed or stored.

The caps (P13):

- At most **2 searches at once** across every trader; one search per book at a time.
- A book's result is **kept 60 s** and served to every viewer of that book: the answer says `cached: true` and `computedAt` is when the search ran. A leg written in that minute (an upload, a manual leg) changes the key, so the next request searches again.
- A request waits up to **20 s** for a slot.
- A search still running after **30 s** is stopped and its worker replaced; the card says `the repair search failed — try again`, and the log has `repair search failed` with `the repair search took longer than 30 s and was stopped`.

**HTTP 429 `{ "error": "busy", "retryAfterMs": 2000 }`** (with `Retry-After: 2`) means busy, not broken: both slots stayed taken for 20 s, or that book already has a search running on other inputs (its legs just changed, or another tail cap). The page offers a retry. Every request 429 for minutes means two searches are taking their full 30 s in turn: look for `repair search failed` in `npx pm2 logs desk-traders --lines 200`.

What the card works on, in its own words:

- The book's **near expiry** (the earliest option expiry still held; for an index usually a weekly), priced off that expiry's forward. Every other leg (other expiries, shares, other futures) is held as one fixed future of their combined delta, entered at the forward, so its P&L starts at 0; plans that trade it are dropped, and the card counts them (`N plans touched the other expiries' fixed offset and were dropped`).
- `P&L already booked is not counted in these figures` — always shown.
- Outside market hours: `market closed — the plans are priced off the last session's quotes`. In session with a dead feed: `the price feed is not ticking: every price below is the last one seen, not a live one`.
- No search at all: `no option legs to repair: <STOCK> holds only shares` (or futures), `no forward for <expiry> yet`, and `the repair search failed — try again` (logged as `repair search failed`).

Cost: one search is about half a second of one core on an index weekly with ~270 quoted strikes, less on a stock. The workers start with the first search and end when `desk-traders` stops. Each adds about 35 MB to the process, which counts towards its pm2 `max_memory_restart` (900M): about 70 MB once both have run.

### 17.2 Market Watch

`GET /v1/traders/market/<NAME>` (the Market Watch page) shows an underlying's first three listed expiries on or after today, near, next and far; where an index lists weekly expiries, these are weeklies. Each chain is priced off its own forward, as Analysis is: the expiry's own future, else put-call parity, else spot carried. A stock shows every listed strike. An index (NIFTY, BANKNIFTY, FINNIFTY, MIDCPNIFTY, SENSEX) shows ATM ± 40 strikes around spot. It is market data: any signed-in trader or admin may open any listed name, stock or index.

What it subscribes (P3):

- While a page polls (every 5 s), the underlying's tokens join desk-traders' one declaration (`desk-subscriptions` `{source:'traders'}`): spot, the nearest listed future, each shown expiry's future, and every shown CE and PE. A new underlying is declared on its first poll. An underlying leaves the declaration 60 s after its last poll, at the next 15 s pass. desk-marketdata picks the change up on its own 30 s refresh: no restart of desk-marketdata or desk-traders.
- `TRADERS_MARKET_WATCH_MAX_TOKENS` caps Market Watch's tokens across all viewers, first come first served. Unset, it is 1000, or `TRADERS_MAX_TOKENS` when that is lower. A stock costs 1 + its futures + 2 × its strikes × 3 (about 300 for 50 strikes a month); an index at most about 490. An underlying that does not fit shows only the strikes already ticking for some other screen (open books' held strikes and ATM windows, the desk's own) and says `Market Watch is already watching 1,000 contracts for other screens; this one shows only the strikes already watched for open books` (the number is `TRADERS_MARKET_WATCH_MAX_TOKENS`, also when it is the books that leave no room). An underlying already on screen whose strikes no longer fit (an index whose window moved with spot) leaves the declaration at once and is shown the same way. A price that is not live (older than a minute, or the stored snapshot) is flagged stale.
- These tokens are inside `declaredTokens` in health. Market Watch yields to open books (Ruling R3-18). Its room is `min(TRADERS_MARKET_WATCH_MAX_TOKENS, TRADERS_MAX_TOKENS − the books' own demand)`, where the books' own demand is what their spots, futures, held strikes and full ATM ± 15 windows took at the last declaration (every 15 s). The room is conservative: every Market Watch token counts against it, including those a book already declares, so close to the cap an underlying can be refused even though a book already has its strikes ticking. So Market Watch never narrows a book's ATM window (section 5) and never pushes the declaration past `TRADERS_MAX_TOKENS`. When the books grow into the room, the underlyings that came on screen last leave first, and are shown as above at their next poll. When the books fill the cap, no underlying fits and Market Watch shows only the strikes already watched. If the books grow between two declarations (an upload), that pass declares none of Market Watch's tokens rather than narrow a book, and `npx pm2 logs desk-traders` says so once when it starts and once when it ends:
  - `[traders] traders feed cap: other screens' tokens left out — the books' full windows need the room {"cap":…,"wanted":…,"left":…,"sources":["market-watch"]}`
  - `[traders] traders feed cap: other screens' tokens no longer left out {"cap":…,"declared":…}`
- To change the cap: set `TRADERS_MARKET_WATCH_MAX_TOKENS=<n>` in `.env.local`, then `npx pm2 startOrRestart ecosystem.traders.config.cjs --only desk-traders --update-env` (operator restart). A value that is not a positive whole number stops desk-traders at boot with `TRADERS_MARKET_WATCH_MAX_TOKENS is not a positive whole number: <value>` in `npx pm2 logs desk-traders`. A value set larger than `TRADERS_MAX_TOKENS` stops it with `TRADERS_MARKET_WATCH_MAX_TOKENS (<n>) is over TRADERS_MAX_TOKENS (<m>): Market Watch's tokens join the same declaration`. Left unset it never does: the default is then the lower of 1000 and `TRADERS_MAX_TOKENS`. Taking a value out of `.env.local` needs section 2's delete and start, not a restart, which keeps the old value.

Desk side, in session (P3). NIFTY's weekly chains (about 488 tokens) are the busiest on the feed. The first time Market Watch is used in a session, check the desk's side:

1. Before: section 5 step 1 (note `subscribedTokens` and the sockets line).
2. Open NIFTY in Market Watch and keep it open for 10 minutes. Watch `tail -f logs/desk-marketdata-out.log | grep 'socket count changed'` and desk-gateway's CPU in `npx pm2 monit`; it should stay where it was.
3. Socket lines are expected when a page opens or closes: `shard.ts` grows its plan by a socket when the tokens pass a multiple of 900 and trims a trailing empty socket when the page closes, and `feed-pool.ts` logs `socket count changed` each time. It never closes a socket that has tokens. One line on open and one on close is normal. Repeated lines while a page stays open, or the gateway's CPU climbing, are not: use the kill switch.

Kill switch: set `TRADERS_MARKET_WATCH_MAX_TOKENS=1` in `.env.local` and run the same `npx pm2 startOrRestart ecosystem.traders.config.cjs --only desk-traders --update-env` (no underlying fits, so Market Watch declares nothing), or do section 5 step 4. This is the one exception to section 5's rule that repeated socket count changes mean an immediate rollback: that rule applies to repeats with no page opening or closing.

OI change and price change are against the previous trading day's NSE end-of-day F&O file, from the span job (section 15). Kite ticks carry no previous close. What it says when they are not known (the cells are blank, never 0):

- No F&O file for that day: `NSE end-of-day file <name> for <DD Mon> is missing — OI change and price change unknown`; a file that did not parse: `… could not be read (<reason>) — …`.
- SENSEX (any BSE underlying) is always blank: `SENSEX trades on BSE; NSE's end-of-day files do not cover it — OI change and price change unknown`.
- A dead feed in session: `the market data feed is dead: every price below is the last one seen`. Outside the session: `market closed — last session's prices`.

BF, BF2 and Ratio are labelled `our reading of VolHedge, unconfirmed (Phase 0, Q3)` until a trader confirms them (section 12, question 6).

Checks after the Release 3 restart:

| Check | Command | Expected |
|---|---|---|
| A stock | open Market Watch, pick TCS | three chains, each headed by its future; IV and greeks in every quoted row |
| An index | pick NIFTY | three weekly chains of 81 strikes; a weekly with no future is headed `forward … (parity)` |
| It subscribes | `curl -s http://127.0.0.1:8794/v1/traders/health` before and while a page is open | `declaredTokens` rises by the underlying's tokens within 15 s, and falls back about a minute after the page is closed |
| An unlisted name | pick a name with no F&O | `no F&O contracts listed for <NAME>` |

## 18. AI desk (operator)

Spec: `docs/superpowers/specs/2026-10-23-traders-ai-desk-design.md`, addendum `…-traders-vol-addendum.md`. An advisory
assistant in the Delta Desk page (key `i`, or the top-bar button): it reads the signed-in trader's books, market
context, levels and vol through tools, and proposes adjustments that our own engines compute. It places no order and
changes no book. **Plan search** (goal chips → ranked plans) works with no model and no key.

**1. Key and switches** — in a real SSH terminal (never through `!`: the key would land in the chat), append to
`/opt/algomaker-delta/.env.local`:

```
TRADERS_AI_ENABLED=1
TRADERS_AI_PROVIDER=anthropic
TRADERS_AI_API_KEY=<the Claude API key>
# optional — defaults shown
TRADERS_AI_MODEL=claude-opus-5-5
TRADERS_AI_EFFORT=medium
TRADERS_AI_DAILY_USD=25
TRADERS_AI_TRADER_DAILY_USD=5
```

Any provider plugs in the same way: `openai`, `google`, or `openai-compatible` with `TRADERS_AI_BASE_URL` (OpenRouter,
a local vLLM/Ollama). A model with no built-in price needs `TRADERS_AI_PRICE_IN_PER_MTOK` / `…_OUT_PER_MTOK`, or the
assistant stays off (a cap that cannot be priced cannot be enforced). Kill switch: `TRADERS_AI_ENABLED=0`, then step 2's
command (removing a key instead needs section 2's delete and start: pm2 keeps the old value across restarts).

**2. Restart onto the new env** — `npx pm2 startOrRestart ecosystem.traders.config.cjs --only desk-traders --update-env`
(a plain `pm2 restart` keeps the old env and the assistant stays off). Health: `curl -s 127.0.0.1:8794/v1/traders/health`. In the page press
`i`: the drawer shows the model and today's spend, or the reason it is off.

**3. History backfill (once, ~15–20 min, NSE archives)** —
`cd /opt/algomaker-delta && .venv-nse/bin/python scripts/span_job.py --backfill-history 260`. Exit 1 = it stopped short (10
unpublished weekdays or 5 failures in a row); rerun later, finished days are skipped. IV rank/percentile need 60 days.

**3b. Index close in the history (once, after this build's span job is on disk; ~15–20 min, NSE archives)** — an
index's `c` in `data/nse/history/<day>.json` is its near future's close; the index's own close, which an expired index
option settles at, is the new field `ic`. New days get it from the daily job. To add it to the days already there:
`cd /opt/algomaker-delta && .venv-nse/bin/python scripts/span_job.py --backfill-history 260 --rewrite --date 2026-10-22`.
It re-reads each day's two bhavcopies (the dated folder first, else NSE: the few days still in a dated folder are read
from disk, the other 256 cost about 510 requests, 1 s apart) and adds `ic` to the index entries, changing no other field. A day that has an `ic` is skipped, so
exit 1 (it stopped short) is fixed by running the same command again. `--backfill-history 320 --rewrite` also fetches
the older days back to Jul 2025 for the older legs to settle.

**4. Vol job** — check once after 15:45 IST: `.venv-nse/bin/python scripts/nse_vol_job.py --symbols TCS --dry-run`;
then `npx pm2 start ecosystem.traders.config.cjs --only desk-traders-vol && npx pm2 save` (one-shot, cron 20:20 IST
Mon–Fri, `autorestart: false`). If NSE blocks the box, everything still works from the bhavcopies (`ivSource:
bhavcopy`).

**What leaves the box** — to the model provider: stock symbols, contracts, quantities, prices, greeks, P&L, margin,
market data. Never: client codes, trader names, notes, file names, leg keys (aliased L1…). Confirm with compliance
before enabling for every trader.

**Records** — every chat turn and plan search is kept in `traders-assistant` (traders can hide, never delete), with
👍/👎 feedback. Admin export (≤ 31 days, NDJSON):
`GET /v1/traders/admin/assistant/export?from=YYYY-MM-DD&to=YYYY-MM-DD`; spend per trader per day:
`GET /v1/traders/admin/assistant/usage?days=7`.

**Limits** — per turn ≤ 10 model calls, ≤ 3 searches, 120 s; one turn per trader, 4 in all; spend reserved up front and
charged per call, including calls cut off by Stop or a hang-up; caps reset at IST midnight.

**Troubleshooting** — "assistant off: …" names the variable to fix; 429 = a turn running or a cap reached; 503 = off;
model errors log one line (`assistant model error`, status + message, never the request body).

## 19. Settlement, Booked, Daily, MTM labels, 15:40, phone alerts (operator)

Spec: `docs/superpowers/specs/2026-10-23-traders-gaps-design.md` (rulings G1–G8).

**1. Restart after the 15:40 close**, not during the session. desk-api's displayed greeks move to 15:40; the engine's
clocks stay 15:30 (G6), so desk-runner, desk-supervisor, desk-gateway and desk-marketdata need nothing.

```sh
cd /opt/algomaker-delta && npx pm2 restart desk-api desk-traders
```

**2. Then build the web** (the new pages call routes only the restarted server has):

```sh
cd /opt/algomaker-delta && npm run build --workspace @algomaker/web
```

**3. Caddy:** add the two `@manifest` lines of section 1 inside `handle_path /traders/*`, validate and reload.

**4. Index close and older history** (once; NSE archives, ~15–20 min; a stopped run resumes):

```sh
cd /opt/algomaker-delta && .venv-nse/bin/python scripts/span_job.py --backfill-history 320 --rewrite --date <last trading day>
```

Index options held to expiry then settle, and expiries from Jul 2025 get closes.

**5. Opening positions (optional):** jignesh's and test's records start 26/25 Aug 2026 with no opening balance, so
none of their contracts listed before then settle (G2 guard). A positions file dated the day before
(`positions-2026-08-25.csv`, …-08-24), uploaded from Admin → the trader's row → Upload file, settles them.

**6. Phones:** each user opens the page → Phone alerts → On (iPhone: Add to Home Screen first, then open it from
there) → Send test. The box needs outbound HTTPS to fcm.googleapis.com, *.push.apple.com,
updates.push.services.mozilla.com.

**Checks after the restart**
- Log: one `settlement recomputed` line (traders, fills, unsettled) at boot and on each new history day, no client codes.
- A book with an expired contract: the warning names the unsettled ones and why; settled ones are gone, delivered
  shares show as a share leg.
- Booked: jignesh JINDALSTEL 27-Oct booked −51,344 before charges. The Booked page itself was hidden on 23 Oct at the
  operator's request (no menu entry, no `g k`, its URL opens Books); `GET /v1/traders/booked` still answers, and putting
  the entry back in `apps/web/src/traders/pages.tsx` restores it.
- Before 09:15 the strip's Today (formerly Day MTM) is "—" with "market opens 09:15".
- Since 23 Oct (spec 2026-10-23-traders-pnl-simplify) the pages show two figures only: **P&L** (series net, since the
  first trade, after charges) and **Today**. Pay In Out, CF Balance, Sq. off Exp., Proj. MTM and Open P&L totals are
  gone; per leg is "Leg P&L". The strip and the P&L block read the same live frame (`seriesNet`, `mtmCharges`): restart
  desk-traders for that and for the Portfolio P&L column (it shows "—" until then).
- Admin → Data status: jignesh flagged 13–14 Oct.
- The first daily rows appear at 15:45 IST on the next trading day.

**What stays unsettled, and why:**
- SENSEX: a BSE index, not in the NSE files.
- TATAMOTORS 28-Oct-25: absent from the history after the demerger.
- Any contract whose cycle has a trading day with no F&O trade (a trade file may be missing; mohammad has 73 such days).
- Contracts listed before a trader's record began, with no opening balance.

## 20. Risk page: portfolio stress, results-event risk, vol event cue (operator)

Spec `docs/superpowers/specs/2026-10-24-traders-risk-design.md`. The new sidebar page is **Risk**. It shows the stress
grid (NIFTY move × vol shift, each stock moved by its beta), the results table (implied vs past results-day moves, the
IV crush, and the book's change if the stock gaps), the historical replay (VaR 95/99, the worst days), concentration,
and correlated clusters. Every rupee figure on it is a **Change** or a **Loss** from now, never a P&L. The Vol page's
cue reads **event** when results fall before the near expiry it ranks. Books show a "Results <date>" badge, and the
`results-ahead` alert goes to phones from 09:15 IST on the day before.

1. Restart desk-traders onto the build: `npx pm2 restart desk-traders --update-env`. The page is already live on
   the web build, but `/risk` and `/events` answer only after the restart.
2. Write the results calendar now, without waiting for the evening job:
   `.venv-nse/bin/python scripts/nse_vol_job.py --events-only`. One calendar request plus one per held stock,
   written to `data/nse/events.json`. After this it runs with the vol job at 20:20 IST, and each stock's past
   meetings are cached for 7 days.

**Checks**
- Risk → Results lists PAYTM 26 Oct, MARUTI 27 Oct and ADANIPORTS 28 Oct, each with 4 past reactions. Legs of an
  expiry on or before the results date are left out of the outcomes, with a note saying so.
- Vol: those three read **event** when their near IV covers the date.
- Risk → Notes is empty or names only stocks with too little history (under 60 days → no beta, left out of the grid).
- A "NSE did not answer N requests" note means the last events run was partial. Run step 2 again.
