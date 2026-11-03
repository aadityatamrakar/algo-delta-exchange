# Strategy detail page: layout and the position book

**Date:** 2026-07-28
**Status:** **SHIPPED** (`2613930c`, `fd42f96a`, 2026-07-28), with one change made during the work:
the split is **50/50**, not the 58/42 below. The order log's Status column was the one being
squeezed — a refusal reason is variable-length and even "COMPLETE" was clipping — so the operator
called it even. See the comment at `apps/web/src/comfort.css:201-213`, which is authoritative.
**Scope:** `apps/web` only. No API change, no `desk-api` restart.

## The problem

Three complaints, one structural cause and two independent ones.

### Whitespace (structural)

Both tables on the strategy page render at the full width of the browser
window. On a ~2000px monitor the data needs ~900px, and every column is a
fixed `pixel()` width **except** `Contract`, which is `proportional()`. A
proportional column absorbs all remaining space, so `Contract` grows by
~1000px and the reader's eye travels that whole distance from the contract
name to the numbers that describe it.

This is not padding. Tightening card padding — attempted in commit
`5ff9db55` — cannot touch it, which is why the complaint survived that
change.

The same cause is present on Positions, Orders, Strategies and Reports.
Those are **out of scope** here: a global max-width is a deliberate
decision to make on its own, not one to smuggle in behind a page fix.

### The Time column wraps

`Time` is `pixel(100)`. `"10:07:50 AM"` does not fit and wraps to two
lines, making those rows double-height and the log ragged.

### Average price is missing

The book shows what was traded (`buyQty`, `buyValue`) but not the price it
was traded at, which is the number compared against LTP to judge a fill.

## Layout

A hand-written CSS grid in `comfort.css`.

```
>= 1200px    [ Net positions       ] [ Order log ]
             [ Intraday P&L        ] [  (grows)  ]
                  ~58%                    ~42%

<  1200px    Net positions -> Order log -> Intraday P&L
```

The order log is the panel that grows without bound — a busy strategy
produces dozens of fills a day, while the position book stays at a handful
of rows. So the log gets the column that can run long, and the two bounded
panels share the other.

When the log outruns the left column the left column simply ends. That
empty space is the cost of giving the growing panel its own column, and it
is cheaper than the alternative: a log squeezed into a full-width panel
that pushes everything else off screen.

**Why not the `Grid` component.** `Grid` takes `columns={{minWidth, max}}`
and produces columns of EQUAL width. Net positions carries eight columns
against the log's six and needs the larger share, so an equal split
recreates the cramping this change exists to remove.

**Mobile order is Positions, Order log, Chart** — what you hold, then what
happened, then the shape of the day. It deliberately does NOT follow the
desktop columns top-to-bottom (which would read Positions, Chart, Log),
because that buries the longest and most-read panel behind a tall chart.

Each table keeps its most important columns leftmost and scrolls
horizontally inside its own container. The page body never scrolls
sideways.

## Net positions columns

```
Contract | LTP | Net qty | MTM | Buy qty | Buy avg | Sell qty | Sell avg
```

Value-now first (LTP, net qty, MTM), then how it got there (the two sides).

`Buy avg` is `buyValue / buyQty`, `Sell avg` is `sellValue / sellQty`, both
computed in the browser from fields the API already returns. Amounts are
dropped: an amount is `qty x avg` and recoverable at a glance, whereas an
average cannot be recovered from an amount without dividing.

**Guard: divide by zero.** A contract traded on one side only has
`buyQty === 0`, and `0/0` is `NaN`. A side with no quantity renders `—`.

**Guard: the total row.** `Buy avg` and `Sell avg` render `—` on the total
row. Averaging averages across different contracts produces a number that
is not the average of anything. Quantities still sum.

**Guard: MTM totals.** Unchanged from the current behaviour — the total
goes `null` (em dash) the moment any open leg is unmarked, rather than
summing the legs that did price into a confident figure short by an unknown
amount.

## Order log

Columns unchanged: `Time | Contract | Side | Qty | Price | Status`.

`Time` switches to 24-hour (`10:07:50`) via `toLocaleTimeString('en-GB')`
and gets `white-space: nowrap`. Shorter, standard for a trading log, and no
AM/PM to parse. The nowrap is belt-and-braces: the format alone fixes
today's overflow, but a narrower viewport would reintroduce it.

## Known limitation: the total row is not a real `<tfoot>`

`TableFooter` exists in the design system but composes only with the
low-level `BaseTable`; the high-level `Table` used here has no footer slot.
The total stays a synthetic final row in `data`, styled bold.

Consequence: it participates in hover and would participate in sorting if
sorting were ever enabled on this table. Accepted — rewriting the table
onto `BaseTable` to gain a semantic `<tfoot>` is disproportionate. If
sorting is added later, this must be revisited, because a total row that
sorts into the middle of the data is worse than no total row.

## Testing

Existing web tests must all still pass (58 at time of writing).

New tests:

- Buy avg and sell avg render from qty and value, and a one-sided contract
  shows `—` rather than `NaN`.
- The total row shows `—` for both averages while still summing quantities.
- The order log renders a 24-hour timestamp.

Not tested: the CSS grid breakpoint. jsdom does not evaluate media queries,
so a test asserting two-column layout would assert nothing. Verified in the
browser instead.

## Out of scope

- Global max-width for the other pages.
- Mobile responsiveness of the navbar, dialogs and other pages — that is
  the separate mobile pass.
- Reconciling `openLegs` (which counts only open legs, because it feeds the
  rollup's `closingPositions`) with the header's "N open, M closed".
