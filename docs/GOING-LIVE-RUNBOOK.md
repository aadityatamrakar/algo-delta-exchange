# Going live — the runbook

For the first real-money session: BAJFINANCE 2026-08-25, `recenter-r`, live rail.
Prepared 2026-07-30 for the 07-31 session.

**The order of operations matters.** `recenter` never opens a position — it
manages one that already exists — so the book must be ENTERED BY HAND FIRST and
the supervisor started only after it is confirmed. Starting the supervisor on an
empty or half-built book is the one sequencing mistake that matters.

## Already done (2026-07-30 evening)

| | |
|---|---|
| Broker | `DESK_BROKER=xts` in `.env.local` — verified to survive a plain `make restart` |
| `desk-supervisor-live` | **running**, `mode=live`, own pidfile, `pm2 save`d so it survives a reboot |
| Allowlist | the password-gated LIVE switch on the Strategies page. `DESK_LIVE_TAGS` pin cleared |
| Order pricing | marketable limits (the broker REJECTS market orders) |
| Cancel | `POST /v1/desk/broker/orders/:id/cancel`, and a Cancel button on the Broker tab |
| Broker view | Broker tab: the broker's own orders, trades and positions, 30s snapshot |
| State | books, registry rows, BAJFINANCE strategy row, fills, gateway orders — **all cleared** |

**recenter-r CHANGED on 2026-07-30 and prod has the new version.** It now BUYS:
once spot is 5% from the book's inception spot it covers the winning side's
uncovered shorts with a wing 10% out, once per side, held to expiry. The
variant's own note says to read peak margin first — measured on ASHOKLEY Jun-26
the coupling took peak margin 5.19cr → 7.27cr and max DD 28.0L → 33.5L for
+87k of P&L, because the wing's positive gamma shrinks `|netΓ|`, which shrinks
`allowed` and makes the delta rule sell MORE.

There is ONE `recenter` implementation shared by the backtest and the live
supervisor (`playbooks.py:2306` via `RuleEngine(playbook="recenter")`), and the
live supervisor was started AFTER that change — so tomorrow's book runs it.
**Decide whether you want the hedge before the open**, against a ₹50L cap.

## 1. Pre-open (08:50–09:10)

```sh
ssh -i ~/Documents/dev/aws_keys/wealthcreator.pem ubuntu@3.108.231.230
cd /opt/algomaker-delta && set -a && . ./.env.local && set +a
```

**Broker armed** — must say `xts`, not `simulate`:

```sh
npx pm2 logs desk-gateway --lines 20 --nostream | grep -i "BROKER MODE"
```

**Instrument sync ran at 08:45** and the chain has quotes. `spot`/`future` must
be non-null once the feed is up, or every leg is unpriceable:

```sh
curl -s -H "Authorization: Bearer $DESK_API_TOKEN" \
  "localhost:8790/v1/desk/chain/BAJFINANCE?expiry=2026-08-25" | head -c 300
```

**Margin** in the Jainam account for a 4-lot short strangle — roughly ₹7L at
entry, and recenter SELLS MORE as it manages, up to the ₹50L cap.

## 2. Create the book (fresh, from nothing)

State was cleared on 2026-07-30: no books, no registry rows, no BAJFINANCE
strategy row. So tomorrow starts by CREATING the book, not by finding it.

**a. Register it** — dashboard **Books → Create**, or:

```sh
curl -s -X POST -H "Authorization: Bearer $DESK_API_TOKEN" -H "Content-Type: application/json" \
  -d '{"tag":"BAJFINANCE-2026-08-25-recenter-r","symbol":"BAJFINANCE",
       "expiry":"2026-08-25","mode":"live","variant":"recenter-r",
       "dials":{"lot_size":750,"target_pnl":60000,"margin_cap":5000000}}' \
  localhost:8790/v1/desk/books/registry
```

It is created `desired: stopped` whatever you ask for, and it also creates the
strategy row with LIVE switched **off**. Both are deliberate.

**b. Arm it** — on the **Strategies** page, switch the tag ON for LIVE (this
prompts for your password) and set **`liveLots: 4`**.

`liveLots` REPLACES the requested size on `/v1/desk/submit` — every leg goes out
at exactly that many lots whatever the request says. 4 is right for this condor;
it would be wrong for a book with unequal legs.

## 3. Enter the iron condor (after 09:20, not at 09:15)

Not at the open — the first minutes carry the widest spreads, and a marketable
limit crosses them.

**Wings first, then shorts.** If the shorts fill and a wing does not, the book is
a naked short strangle. The reverse merely costs the wing premium.

Price each leg THROUGH the touch — buy at/above ask, sell at/below bid — on the
0.05 tick grid, never worse than the sheet rate.

| Order | Leg | Token | Side |
|---|---|---|---|
| 1 | BAJFINANCE26AUG1150CE | 22730242 | **Buy** |
| 2 | BAJFINANCE26AUG960PE | 18998018 | **Buy** |
| 3 | BAJFINANCE26AUG1070CE | 22711554 | **Sell** |
| 4 | BAJFINANCE26AUG1030PE | 22706434 | **Sell** |

```sh
curl -s -X POST -H "Authorization: Bearer $DESK_API_TOKEN" -H "Content-Type: application/json" \
  -d '{"tag":"BAJFINANCE-2026-08-25-recenter-r","mode":"live","clientOrderId":"entry-1150ce",
       "instrument":{"tradingsymbol":"BAJFINANCE26AUG1150CE","instrumentToken":22730242,
                     "lotSize":750,"tickSize":0.05,"exchange":"NFO"},
       "side":"Buy","lots":4,"orderType":"LIMIT","limitPrice":<ask+buffer>}' \
  localhost:8790/v1/desk/submit
```

Read **`routedLots`**, not `intendedLots` — a partial route is invisible in the
latter. Confirm each fill on the **Broker** tab before sending the next.

## 4. SEED THE BOOK — do not skip this

**`/v1/desk/submit` does NOT write `desk-books`.** It routes the order and
journals the fill; only `seed.ts` and the supervisor's own `applyDecision` write
the book. So after all four legs fill, the desk still has NO book, and starting
the supervisor would have it manage nothing.

Write `seeds/BAJFINANCE-2026-08-25-recenter-r.json` with **the prices that
actually filled** — read them off the Broker tab's Trades table, not the prices
you asked for:

```json
{
  "tag": "BAJFINANCE-2026-08-25-recenter-r",
  "symbol": "BAJFINANCE",
  "expiry": "2026-08-25",
  "mode": "live",
  "legs": [
    { "strike": 1070, "type": "CE", "qty": -3000, "rate": <actual> },
    { "strike": 1030, "type": "PE", "qty": -3000, "rate": <actual> },
    { "strike": 1150, "type": "CE", "qty":  3000, "rate": <actual> },
    { "strike":  960, "type": "PE", "qty":  3000, "rate": <actual> }
  ]
}
```

```sh
node apps/api/src/cli.ts seed --file seeds/BAJFINANCE-2026-08-25-recenter-r.json
```

Then all three must agree — the desk book, the broker's positions, and your
intent:

```sh
curl -s -H "Authorization: Bearer $DESK_API_TOKEN" "localhost:8790/v1/desk/books?mode=live"
curl -s -H "Authorization: Bearer $DESK_API_TOKEN" localhost:8790/v1/desk/broker
```

**Do not proceed until the broker shows all four legs and the book has four.**

## 5. Start management

```sh
curl -s -X POST -H "Authorization: Bearer $DESK_API_TOKEN" -H "Content-Type: application/json" \
  -d '{"mode":"live"}' \
  localhost:8790/v1/desk/books/registry/BAJFINANCE-2026-08-25-recenter-r/start
```

`desk-supervisor-live` is already running and polls every 30s, so it picks the
book up within half a minute and marks on the 5-minute grid.

Watch it with `npx pm2 logs desk-supervisor-live --lines 50`.

Expect mostly `hold`. The 1070/1030 shorts straddle spot near-symmetrically, so
netΔ starts near zero and recenter only fires when drift pushes `|netΔ|` past
`|netΓ| × 2% × spot`.

## During the session — do not do these

- **Do not restart `desk-runner`.** Its SIGTERM handler SQUARES OFF POSITIONS.
  `scripts/deploy.sh` refuses during market hours for exactly this; do not use
  `FORCE=1`.
- **Do not run `make restart`, `make up` or `make deploy`.** They bounce every
  process, `desk-runner` included.
- Restarting `desk-supervisor-live` alone IS safe — SIGTERM stops its loop
  without touching a book.
- **There is no variant code to change any more, and no restart to plan
  around.** The Python `variants.py` registry is gone with the Python
  supervisor; presets ship in `@algomaker/desk-engine/presets` and are a
  PREFILL and nothing more — picking one copies numbers into the book's own
  dials, and what the engine reads is always the dials. To change what a book
  does, patch its dials from the Dials panel: it lands on the next evaluation,
  no restart. (`GET /v1/desk/variants` still serves the stored `desk-variants`
  catalogue, read-only, so books registered under a published variant keep a
  record of what knobs they had.)

## The day guard (per-strategy daily target and stop-loss)

Each row on the Strategies page carries two optional lines, set in its Settings
dialog: a daily target and a daily stop-loss, both stated as POSITIVE rupees
(`3000` means "stop for the day at a ₹3,000 loss"). They are read against the
same P&L number the cards show, per rail — a strategy running on paper and live
is judged twice, independently, against the same two figures. When one is hit,
desk-api switches THAT rail off and records it in `desk-daily-guard`; the row's
switch shows off and the table says `guard: stop hit -₹3,150 at 11:04 —
stopped for the day`. A hosted strategy is squared off by the runner's own
switch-off flatten; a MIRROR_* tag, which nothing else squares off, is flattened
by the guard itself. **Paper rails re-arm by themselves the next morning at
08:45 IST; a LIVE rail never does** — auto-arming live would put real money back
on the wire with nobody's password behind it, so you re-enable it by hand, with
the badge in view. Editing or clearing the limits on a row that is switched on
for live asks for your password, exactly like the live switch does.

## Known gaps to work around

- **AMO is not supported.** `timeInForce` is hardcoded `DAY`; neither this code
  nor the legacy has ever set anything else.
- **The supervisor's orders bypass `liveLots`.** Still true; the endpoint named
  here was not. `POST /v1/desk/actions` was removed in the D9 cutover — the
  supervisor's decisions arrive at `POST /v1/desk/engine/decisions`, and that
  path never consults `liveLots` either (the override lives in
  `submit-plan.ts`, on the `/v1/desk/submit` path only). So the engine's sizing
  is limited by `margin_cap` (₹50L) and nothing else. This is deliberate rather
  than an oversight — the engine's sizes are derived from the book's own legs,
  and a `liveLots` override would resize half a shift and leave the other half
  at the size it was planned at (see `repair-apply.ts:#request`, which sets
  `exactLots: true` for the same reason).
- **XTS accepts after-hours orders and rests them.** Verified 07-30: a DAY order
  placed at 18:13 was accepted, not rejected. It was gone by 18:45, but do not
  assume an out-of-hours order is a no-op.
- **The order socket disconnects out of hours** (`XTS order socket
  DISCONNECTED — fills will lag`), so fill correlation lags outside the session.

## What the backtest says to expect

`recenter-r` on BAJFINANCE lost money in simulation: **−₹4.87L** net on a book
2.2× this size, max DD ₹4.97L, peak margin ₹2.11cr against ₹15.4L at entry.
Scaled to a 4-lot book that is roughly −₹2.2L against ₹1.2L of entry credit.

The ₹50L `margin_cap` is what stops the margin path repeating — the sim ran
uncapped at ₹10cr.

## Emergency stop

1. Switch the tag OFF for LIVE on the Strategies page — every subsequent order
   is refused at the gate, immediately, no restart.
2. `npx pm2 stop desk-supervisor-live` — stops management without touching the
   book.
3. Close positions from the Jainam terminal if they must go.

Step 1 is the fastest and the one to reach for first.
