# Stock books — the monthly TCS / TATASTEEL / KALYANKJIL recenter books

Three `recenter-relief-r` PAPER books a month, one per stock, put on the desk
the way the September ones were on 2026-09-07. `scripts/stock-books.mjs` does
it in two phases; this page is the procedure around it.

| Book (October)                            | Size   | Lot  | Qty per leg |
|-------------------------------------------|--------|------|-------------|
| `TCS-2026-10-27-recenter-relief-r`        | 5 lots | 225  | 1125        |
| `TATASTEEL-2026-10-27-recenter-relief-r`  | 5 lots | 2750 | 13750       |
| `KALYANKJIL-2026-10-27-recenter-relief-r` | 2 lots | 1350 | 2700        |

Dials, exactly September's: `margin_cap 5000000`, `target_pnl 50000`,
`delta_shorts_only true`, `gamma_shorts_only true`. The expiry is the nearest
monthly on or after today, read from the instrument master (2026-10-27 for
all three in October). Everything is `mode: paper`; no flag changes that.

Recenter never opens its own position — it manages delta from the one it is
handed. So the structure is opened by phase 2: a short ATM straddle (the listed
strike nearest the future's live mark) and long wings at the listed strikes
nearest the future × 0.91 (PE) and × 1.09 (CE).

All commands run from `/opt/algomaker-delta`. `.env.local` supplies
`DESK_API_TOKEN`; `--apply` refuses without it.

## 1. Register — any day before the open (Sunday is fine)

```sh
node scripts/stock-books.mjs --register            # dry run: the three bodies, no desk-api
node scripts/stock-books.mjs --register --apply    # read registry, then create, start, switch on
```

`--apply` first reads `GET /v1/desk/books/registry?mode=paper`; if those rows
already carry a `series` field (the series build is deployed) each create
sends `series: <SYMBOL>-recenter-relief-r`, otherwise it is left out (a build
that knows series derives the same name). Then, per book:
`POST /v1/desk/books/registry`, `POST .../:tag/start {"mode":"paper"}`,
`PATCH /v1/desk/strategies/:tag {"modes":{"paper":{"enabled":true}}}`.

Re-runnable: an identical re-register answers 200, a start on a running book
is a no-op, the PATCH is idempotent.

Check after:

- Books page: three new rows, `running`, paper, expiry 2026-10-27, no legs.
- Strategies page: each tag switched ON for paper, OFF for live.
- Within a refresh cycle desk-marketdata subscribes each registered book's
  full chain (`registrySubscriptionBooks`). That is what gives phase 2 live
  quotes for the October contracts — the snapshot has none for them today.

An empty recenter book decides nothing, so registering early costs nothing.

## 2. Open — Monday 2026-10-05, 09:35 IST

```sh
node scripts/stock-books.mjs --open                # preview off the persisted snapshot, no desk-api
node scripts/stock-books.mjs --open --apply        # the real thing
```

`--open --apply` refuses, before a single order is built, when:

- it is not 09:20–15:00 IST, or the engine's calendar says today is not a
  session (weekend, NSE holiday — 2 Oct was one);
- a book is not registered, not paper, not `running`, or its row's
  symbol/expiry/variant differ from the plan;
- a book's paper switch is off (`GET /v1/desk/strategies?mode=paper`), or the
  desk's kill switch is engaged (`GET /v1/desk/killswitch`);
- a book already holds legs, or already has a book document at all
  (`GET /v1/desk/positions?tag=` answers a non-empty `symbol`) — the open
  rests on there being NO document, so the entry fills fold into nothing and
  the seed writes the book;
- its tag has ANY trade (`GET /v1/desk/trades?tag=&mode=paper`) — a
  half-finished earlier open shows only in the trades;
- any of the twelve contracts, or a future, has no FRESH quote in
  `GET /v1/desk/chain/:symbol?expiry=`: the future's mark must be at most
  2 minutes old and every leg's quote from today's session (09:15 IST on).
  All three chains are read and all three books planned before the first
  order of the first book.

Every request has a 15 s deadline. Once the first order has gone, ANY failure
— a refusal, a timeout, a dropped connection, an API restart — stops the run
with: the book, how many of its four orders were submitted, the books already
seeded, and "orders may have ROUTED — check GET /v1/desk/trades?tag=…". Then
go to §3.

To open only some books, name them (repeatable; works for `--register` too):

```sh
node scripts/stock-books.mjs --open --apply --only TATASTEEL --only KALYANKJIL
```

Then, per book (TCS, TATASTEEL, KALYANKJIL): four `POST /v1/desk/submit` —
Buy wing CE, Buy wing PE, Sell ATM CE, Sell ATM PE, `exactLots: true`, no
`orderType` (the desk prices a marketable limit with its own dials) — wait for
the four paper fills, then `POST /v1/desk/seed` with the filled rates, shorts
negative, `replace: false`. Each `clientOrderId` is
`entry-<tag>-<tradingsymbol>-<Side>`, so a resend replays rather than placing
twice.

Friday's marks (TCS 2076.8, TATASTEEL 178.65, KALYANKJIL 528) give:

| Book       | Long CE | Long PE | Short CE + PE |
|------------|---------|---------|---------------|
| TCS        | 2260    | 1880    | 2080          |
| TATASTEEL  | 195     | 162.5   | 177.5         |
| KALYANKJIL | 580     | 480     | 530           |

Monday's strikes come from Monday's live mark and can differ.

For the operator: October's KALYANKJIL wings at ±9 % (480 / 580 around 530)
are much tighter than September's, which sat at about ±14 % (510 / 675 around
590). TCS and TATASTEEL are at ±9 % both months. The script applies one rule
(±9 % of spot) to all three; if KALYANKJIL should keep its wider wings, say so
before Monday.

Check after:

- The run ends `3 book(s) opened and seeded`, and prints each seed's legs.
- Books page: each book holds four legs — two long wings, two short ATM —
  at the quantities in the table above.
- `GET /v1/desk/positions?tag=<tag>&mode=paper`: four legs, shorts negative.
- Within a minute the supervisor's decisions for each tag start appearing
  (book page, last reason); with no legs it had nothing to say.

## 3. If `--open` stops halfway

The message names the book that stopped, how many of its four orders were
submitted, and which books were already seeded. A seeded book is done — leave
it alone. For the book that stopped, from `/opt/algomaker-delta`:

```sh
set -a; . ./.env.local; set +a          # puts DESK_API_TOKEN in this shell for the curls
T=TATASTEEL-2026-10-27-recenter-relief-r   # the tag the message named
curl -sS -H "authorization: Bearer $DESK_API_TOKEN" "http://127.0.0.1:8790/v1/desk/trades?tag=$T&mode=paper"
curl -sS -H "authorization: Bearer $DESK_API_TOKEN" "http://127.0.0.1:8790/v1/desk/positions?tag=$T&mode=paper"
```

1. **Read what filled.** The trades list every entry order that routed, with
   `status`, `filled_quantity` and `price`. An order the message counted as
   submitted may or may not appear; an order it did not count may still have
   routed if the connection dropped mid-request — the trades are the truth.
2. **Place any missing legs with the Manual Order dialog** (paper, same tag,
   same contracts and size as the plan printed). The Build-book screen is
   acceptable for its Place buttons ONLY. **Never press Build's Record**: it
   seeds just the legs IT placed, `replace: false`, and once the book holds
   legs the full seed below is refused (409, `seed.ts`) — and a corrective
   `replace: true` is refused too while the fills show open positions
   (`routes/desk.ts`). There is no clean way back from a partial Record.
3. **Confirm the book is still empty**: the positions call answers
   `"legs": []`. If it shows legs, something already seeded — stop and look;
   do not seed again.
4. **Send ONE seed with every filled leg**: the rate is each order's filled
   price (quantity-weighted if it filled in pieces), longs positive, shorts
   negative:

   ```sh
   curl -sS -X POST http://127.0.0.1:8790/v1/desk/seed \
     -H "authorization: Bearer $DESK_API_TOKEN" -H 'content-type: application/json' \
     -d '{"tag":"'"$T"'","symbol":"TATASTEEL","expiry":"2026-10-27","mode":"paper","replace":false,
          "legs":[{"strike":195,"type":"CE","qty":13750,"rate":<filled>},
                  {"strike":162.5,"type":"PE","qty":13750,"rate":<filled>},
                  {"strike":177.5,"type":"CE","qty":-13750,"rate":<filled>},
                  {"strike":177.5,"type":"PE","qty":-13750,"rate":<filled>}]}'
   ```

   If it was the script's own seed that failed after four fills, its message
   prints this exact body — but check positions (step 3) first: a 409 can mean
   the legs are already there.
5. **Open the books after the one that stopped** with `--only`. A plain re-run
   refuses for every book, because the stopped book's tag has trades:

   ```sh
   node scripts/stock-books.mjs --open --apply --only KALYANKJIL
   ```

The script will never re-open a tag that has traded; that refusal is the point.

## 4. What this does not do

- It never creates a live row or sends a live order.
- It does not retire last month's books. The `*-2026-09-29-recenter-relief-r`
  three are cleared by the expiry cleanup (settle expired legs, stop, erase).
- It does not adjust anything after the open — the recenter playbook does.
