# Delta desk — BULL-S paper books on BTC options

Six PAPER books (daily, weekly, monthly, each in a 1-strike and a 2-strike flavour) on Delta Exchange India. Nothing
here can send an order to Delta: the gateway sends to Delta only when a book's mode is exactly `live` and
`DESK_DX_LIVE=1`; no step below sets either. All commands run from `/opt/algomaker-delta`.

## 1. Environment (once)

    bash scripts/dx-bootstrap-env.sh

Writes `.env.local` with fresh secrets, `DESK_VENUE=dx` and db `algomaker_dx`. It refuses to overwrite an existing file
and prints names only. (The script comes from the dx-web lane.)

## 2. Start

    bash scripts/dx-start.sh

Builds the web with `VITE_DESK_VENUE=dx`, then starts `dx-marketdata`, `dx-api`, `dx-gateway`, `dx-supervisor`,
`dx-web`, in that order, stopping at the first error. It refuses if `.env.local` is missing, lacks `DESK_VENUE=dx`,
points at db `algomaker`, or if any ecosystem app is not named `dx-*`. It never starts `dx-runner` or `dx-traders`.

## 3. First dashboard user

In your own SSH terminal (not a `!` command in the chat, so the password stays out of the transcript):

    node bin/desk-user.mjs create <name>

## 4. Delta key

Open http://3.108.231.230:5000, sign in, then Brokers -> Delta -> paste API key and secret -> Test.

## 5. Books

    node scripts/dx-books.mjs            # dry run: prints the six bodies, uses no network
    node scripts/dx-books.mjs --apply    # create, start, paper-enable

Check the printed expiries first. Daily = the next 17:30 IST settlement; weekly = the next Friday on or after it;
monthly = the last Friday of the month. `--apply` aborts if a chain has no listed strikes for an expiry; then name the
real ones: `--expiry daily=YYYY-MM-DD,weekly=...,monthly=...`. `--apply` also refuses when `/v1/desk/feed` is not
`ready` or the kill switch is on. It is safe to re-run.

Tags: `BTC-<expiry>-bull-s-<daily|weekly|monthly>[-2]`.

## 6. What to watch

- Feed: `GET /v1/desk/feed` (bearer) shows `ready: true` and a small `msSinceLastTick`.
- Books page: six rows, running, paper on. The first straddle opens on the first fresh index price after start.
- Each fill carries fees in USD; P&L shows gross, fees, net.
- A stop closes both legs of one straddle; Close book flattens and halts; Re-arm clears the halt.
- Settlement is 17:30 IST. New entries stop 60 minutes before. Next-expiry books are not created automatically yet
  (Task 11); run step 5 again after each settlement.
- Logs: `npx pm2 logs dx --lines 100`.

## 7. Stop

    npx pm2 stop dx

Stops the `dx` namespace and nothing else. Start again with `bash scripts/dx-start.sh`.

## Caddy (dashboard TLS, optional)

The operator applies this by hand.

    delta.example.com {
        reverse_proxy 127.0.0.1:5000
    }
