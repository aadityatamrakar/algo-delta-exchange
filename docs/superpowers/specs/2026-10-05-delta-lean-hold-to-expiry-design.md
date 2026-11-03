# Delta-lean hold-to-expiry — a weekly sibling of the intraday books

Date: 2026-10-05. Operator: "the trades in NIFTY and SENSEX that we are running
intraday, we want to run till expiry as well — make a copy of both conservative
and aggressive for hold till expiry, manage daily similar to intraday, but create
the position after expiry day and hold till expiry, or before if the target is reached."

## What exists

Four intraday paper books a day (`NIFTY-delta-lean-aggressive-2026-10-05` …):
`scripts/delta-lean-roll.mjs` creates today's four at 08:50 IST, the engine
(`packages/desk-engine/src/delta-lean/decide.ts`) opens once after warm-up,
adjusts through the day (hold-and-adjust), flattens at 14:50/14:55/15:00
(`dl_flatten_passive_min` / `dl_flatten_urgent_min` / `dl_flat_by_min`), exits
early on `dl_day_target`, `dl_day_max_loss` or the stuck rule, and `rollDay`
resets the day state (`dlStopped`, `dlOpenedMs`, adjust counters) at the first
decision of a new IST date. The roll retires a book by its creation day.

## The new family

Two presets, copies of the intraday ones with ONE new dial:

| key | label | dials |
|---|---|---|
| `delta-lean-hold-aggressive` | Delta lean — hold to expiry, aggressive (25L) | `{ ...DELTA_LEAN_BASE, dl_hold_to_expiry: true }` |
| `delta-lean-hold-conservative` | Delta lean — hold to expiry, conservative (25L) | the conservative column + `dl_hold_to_expiry: true` |

`dl_hold_to_expiry: boolean`, default `false`, declared in the delta-lean dial
schema like every other `dl_*` dial so desk-api, the supervisor and the scripts
all know it. (The registry API stores an unknown boolean or number dial as
given; it is the SUPERVISOR's `resolveDials` that drops a key its engine does
not know — the 2026-09-22 lesson — so a supervisor on an older build steers a
hold book as an intraday one. The roll therefore creates no hold pair unless
the engine on disk knows the dial.)
It is the ONLY thing that distinguishes the family; membership is by this dial,
never by tag text.

Tags carry the contract, not the day: `NIFTY-delta-lean-hold-aggressive-2026-10-13`,
`SENSEX-delta-lean-hold-conservative-2026-10-15`. Series derives as usual
(`NIFTY-delta-lean-hold-aggressive`), so the Reports page groups the weeks.

## Lifecycle (the roll, `scripts/delta-lean-roll.mjs`)

- **Create.** For each symbol, `E` = the nearest listed expiry on or after today
  (`expiriesFrom`). If `E` is today, no hold book is created today (its contract
  dies today). Otherwise, if no registry row exists for the hold tag on `E`,
  create → start → switch on, exactly like the daily four (same three calls, same
  paper layers, the API arms the desk guard). "Create the position after expiry
  day" is therefore the first trading day whose front expiry is new. If a morning
  is missed, the book is still created on the next morning with fewer days left;
  accepted. **First week is short:** on 2026-10-06 (NIFTY expiry day) only the
  SENSEX hold pair is created, for 2026-10-08; NIFTY's first hold pair comes on
  2026-10-07 for 2026-10-13.
- **Daily.** Nothing: the roll does not stop or erase a hold book by its creation
  day. The delta-lean retire loop EXCLUDES rows whose resolved dials carry
  `dl_hold_to_expiry: true`.
- **Retire.** A hold book whose `expiry < todayIst`: flat → erase (stop first if
  running); every open leg on the dead contract → `settle-expired` then erase; a
  leg on a live contract or an unreadable book → alarm, untouched. Same vocabulary
  and the same `applyRoll` ordering as today (creates, then every stop, then every
  erase).
- The roll's `BookPlan` typedef gains `series` (the two pre-existing checkJs
  errors).

## Engine (`decide.ts`, `lean.ts`) when `dials.dl_hold_to_expiry`

1. **The clock exits run only on expiry day.** The passive/urgent/flat-by ladder
   applies when `inputs.dateIst === inputs.expiry`; on every other day the book
   carries overnight. The engine inputs must carry the book's `expiry` (add it to
   `DeltaLeanInputs` and have the supervisor's engine-host pass the registry
   row's expiry if it does not already).
2. **Open once.** `rollDay` does NOT reset `dlOpenedMs` for a hold book: the
   package is opened on the book's first day after warm-up and never re-opened.
   After an early exit the book stays flat and latched.
3. **The exits are book-life exits.** `dlStopped` is NOT reset by `rollDay` for a
   hold book — a target, backstop or stuck exit is terminal for the week. Target
   and backstop are measured on the BOOK's P&L (`cumRealized + Σ mtm`, which is
   already the tag's lifetime bank), and the reasons read "book target" / "book
   backstop" instead of "day …". The dial names stay `dl_day_target` /
   `dl_day_max_loss` (same numbers, no second table to keep in step); the preset
   comment says what they mean here.
4. **Everything else daily.** Per-day counters (`dlAdjustsToday`, cooldowns,
   regime, `dlDayRealized`) still roll with the date; warm-up (`dl_warmup_min`)
   gates the first decision of each day; adjustments, the stuck rule and the
   spread/freshness guards are unchanged.
5. Intraday books (`dl_hold_to_expiry: false`) behave exactly as today — every
   existing engine test stays green unchanged.

## Not doing

A different adjustment cadence for the week, overnight-gap handling beyond what
the supervisor already does for the monthly stock books, or a hold variant for
stocks.

## Tests

Engine: a hold book past 14:50 on a non-expiry day holds (no eod exit); on expiry
day it flattens on the ladder; `rollDay` across a date keeps `dlOpenedMs` and
`dlStopped` for a hold book and resets them for an intraday book; the target exit
latches across the next day's roll; book-life P&L drives target/backstop.
Roll: hold pair created when `E > today` and absent, not created when `E` is
today, converges on an existing row; hold rows excluded from the day retire;
retired by expiry with the four alarm cases; recorded-call ordering.
Registration: payload pin for the hold books (variant, dials incl. the new
dial, series).
