/**
 * THE BROKER'S OWN VIEW — its order book and positions, not the desk's.
 *
 * Every other screen shows what the desk BELIEVES. This one shows what the
 * broker HOLDS, and the value is entirely in reading the two against each
 * other. On 2026-07-30 a smoke-test order rested at the broker with nothing on
 * any desk screen showing it, because nothing ever asked.
 *
 * THE COLUMNS ARE CURATED, AND THIS IS A REVERSAL. They used to be derived from
 * whatever keys arrived, on the argument that a fixed mapping would drop a
 * column nobody anticipated. What that actually produced, measured against the
 * live account on 2026-08-15, was seventeen columns per order in which
 * `AccountID` said `PRO111` four hundred times, `ProductType` said `NRML` four
 * hundred times, `ApplicationType` and `BEP` said nothing at all, and a price
 * cell read `3.6333333333333333`. Every column that always says the same thing
 * costs the operator a horizontal scroll to reach the ones that do not — so the
 * page failed at monitoring, which is the job it is opened for.
 *
 * WHAT THE REVERSAL COSTS, stated plainly: a field XTS starts sending tomorrow
 * will not appear here, and the verbatim row is now only in Mongo. That is
 * accepted because this is a MONITORING surface, not the forensic one — the
 * snapshot document is one query away and loses nothing.
 *
 * WHAT IS NOT CURATED AWAY: an anomaly. `ProductType` is dropped as a column
 * precisely because it is always `NRML`, and rendered as a chip the moment it
 * is not — an MIS position squares itself off at the close, which is a fact the
 * operator has to see, and a chip that only ever appears when something is
 * wrong is read, while a column of `NRML` is not.
 *
 * EVERY UNKNOWN VALUE FALLS BACK TO THE BROKER'S OWN TEXT rather than to a
 * dash. A timestamp in a format this file does not know is printed as sent.
 *
 * STALENESS IS RENDERED AS LOUDLY AS THE DATA. A broker view frozen at 14:00
 * reads as confirmation, which is worse than showing nothing — so an old or
 * failed snapshot says so above the tables.
 */

import { useCallback, useMemo, useState } from 'react'
import { VStack, HStack } from '@astryxdesign/core/Layout'
import { Button } from '@astryxdesign/core/Button'
import { Card } from '@astryxdesign/core/Card'
import { Text, Heading } from '@astryxdesign/core/Text'
import { Badge } from '@astryxdesign/core/Badge'
import { Banner } from '@astryxdesign/core/Banner'
import { Table, proportional, pixel } from '@astryxdesign/core/Table'
import type { ColumnWidth, TableColumn } from '@astryxdesign/core/Table'
import {
  api, explain, inSession, inr, istDate, istDayLabel, money, NOWRAP, sign, signed,
  type BrokerView,
} from './api.ts'
import { usePoll } from './shell.tsx'

/** Matches the gateway's own snapshot cadence; polling faster shows nothing new. */
const POLL_MS = 15_000

/**
 * THE ONE FAILURE THIS PAGE IS ALLOWED TO SAY QUIETLY: the broker session
 * expired while the market was shut.
 *
 * The gateway's XTS token lapses every night. Re-reading a closed exchange with
 * a dead token fails every 30s until the next login, which painted this page
 * red all weekend, every weekend — and a screen that is red when nothing is
 * wrong stops being read at all. That is the only thing being bought here.
 *
 * FOUR CONDITIONS, ALL REQUIRED, all fail-loud when absent:
 *
 *  - the snapshot FAILED at all (`ok === false`);
 *  - the gateway classified it a dead SESSION. An older gateway sends no class,
 *    and an unexplained failure is not a quiet one;
 *  - the snapshot's own `asOf` falls OUTSIDE the session, by `inSession` — the
 *    one client-side session rule. Judged by when it was TAKEN, never by when
 *    it is read: a snapshot that failed at 11:00 on a Tuesday means live orders
 *    were failing, and it must still say so when opened at midnight;
 *  - the gateway does not CONTRADICT that. It stamps its own answer with
 *    `@algomaker/core`'s rule; if the two sides disagree about whether the
 *    market was open, one of them is wrong and someone should look — a
 *    disagreement is never a reason to go quiet.
 *
 * An in-session token failure is untouched: it means live orders are failing
 * right now, which is exactly what the red state is for.
 */
function marketClosedSession(data: BrokerView): boolean {
  return (
    data.ok === false &&
    data.errorClass === 'session' &&
    data.asOf !== undefined &&
    !inSession(data.asOf) &&
    data.sessionOpenAtSnapshot !== true
  )
}

// ------------------------------------------------- reading a broker's field

/** The em dash this page uses for "there is nothing here", in one place. */
const NONE = '—'

/**
 * The first of `keys` the row actually carries. XTS spells the same fact
 * differently by endpoint and by investor-vs-dealer account, so every read goes
 * through a list rather than a name.
 */
function pick(row: Record<string, unknown>, keys: readonly string[]): unknown {
  for (const k of keys) {
    const v = row[k]
    if (v !== undefined && v !== null && v !== '') return v
  }
  return undefined
}

/**
 * A broker number, WHICH ARRIVES AS A GROUPED STRING as often as not.
 *
 * XTS sends `"1,23,456.78"` for amounts and quantities alike; `Number()` of
 * that is `NaN`, which would render every figure past a lakh as a dash — the
 * legacy account model stripped the commas off every single field for exactly
 * this reason (`archive/common/models/xts-account.js`). Null, never zero: an
 * unreadable figure is not a claim that the number is nought.
 */
function num(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  if (typeof v !== 'string') return null
  const n = Number(v.replace(/,/g, '').trim())
  return v.trim() === '' || !Number.isFinite(n) ? null : n
}

function str(v: unknown): string {
  return v === undefined || v === null ? '' : String(v)
}

/** Text, or the dash — for a field the broker left out entirely. */
function textOf(row: Record<string, unknown>, keys: readonly string[]): string {
  const s = str(pick(row, keys))
  return s === '' ? NONE : s
}

/** A price, always two places. Null is "no price", which is not `0.00`. */
function price(n: number | null): string {
  return n === null ? NONE : inr(n, 2)
}

/** A quantity, integer, in the desk's own digit grouping. */
function qty(n: number | null): string {
  return n === null ? NONE : inr(n)
}

/**
 * The `Actual*` twin wins when the broker sends both.
 *
 * XTS publishes `BuyAmount` beside `ActualBuyAmount` (and the same for the
 * sell, the average prices and the open quantities). Where they disagree the
 * `Actual*` figure is the one carrying the exchange's own multiplier handling,
 * so it is the one shown — and the twin is not silently dropped, it goes onto
 * the cell's `title` so a disagreement can still be found by hovering rather
 * than by opening Mongo.
 */
function actual(row: Record<string, unknown>, name: string): { value: number | null; other: number | null } {
  const a = num(row[`Actual${name}`])
  const plain = num(row[name])
  if (a === null) return { value: plain, other: null }
  return { value: a, other: plain !== null && plain !== a ? plain : null }
}

// -------------------------------------------------------------- timestamps

/**
 * The date and clock inside a broker timestamp, or null.
 *
 * READ AS TEXT, NEVER PARSED TO AN INSTANT. XTS stamps its rows in IST wall
 * clock with no zone on the string, so `Date.parse` would read them as UTC (or,
 * for `15-08-2026`, as nothing at all) and a browser outside IST would then
 * render a time the broker never said. Re-formatting the digits cannot drift.
 */
function stampOf(v: unknown): { date: string; time: string } | null {
  const s = str(v).trim()
  const iso = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}:\d{2}:\d{2})/.exec(s)
  if (iso !== null) return { date: `${iso[1]}-${iso[2]}-${iso[3]}`, time: iso[4] as string }
  const dmy = /^(\d{2})[-/](\d{2})[-/](\d{4})[T ](\d{2}:\d{2}:\d{2})/.exec(s)
  if (dmy !== null) return { date: `${dmy[3]}-${dmy[2]}-${dmy[1]}`, time: dmy[4] as string }
  return null
}

/**
 * The clock alone for today, `27 Jul 15:12:04` for any other day.
 *
 * A bare `15:12:04` on a row from yesterday names no moment at all, and these
 * tables carry both: the order book is today's, the trade book of a positional
 * account is not. The day is spent only where it is ambiguous, the same rule
 * `localDayTime` follows in the order log — but judged against the IST calendar
 * day, because that is the clock the broker stamped in.
 */
function when(row: Record<string, unknown>, keys: readonly string[], today: string): string {
  const raw = pick(row, keys)
  const st = stampOf(raw)
  if (st === null) return str(raw) === '' ? NONE : str(raw)
  return st.date === today ? st.time : `${istDayLabel(st.date)} ${st.time}`
}

const ORDER_TIME = ['OrderGeneratedDateTime', 'OrderGeneratedDateTimeAPI', 'LastUpdateDateTime', 'ExchangeTransactTime']
const TRADE_TIME = ['ExchangeTransactTime', 'LastUpdateDateTime', 'OrderGeneratedDateTime', 'OrderGeneratedDateTimeAPI']

// ----------------------------------------------------------------- columns

/** A broker row, whatever XTS put in it. */
type Row = Record<string, unknown>

interface Col {
  readonly key: string
  readonly header: string
  /**
   * THE COLUMN'S SHARE OF THE TABLE, and the reason these tables no longer hug
   * the left edge of their card.
   *
   * They were auto-width: the `<table>` sized itself to its content and left
   * half of every card empty. `proportional`/`pixel` are the desk's own width
   * vocabulary (`positions` on the strategy page, the order log).
   *
   * WHICH COLUMNS FLEX IS THE WHOLE DESIGN, and it differs by table. On
   * Positions the four NUMERIC columns are the proportional ones and Symbol is
   * fixed, so spare width arrives as four small gaps; on the two narrow tables
   * everything is fixed except Symbol, which takes the little that is left. The
   * mistake in between — one flexible column beside seven fixed ones — is what
   * put a hand's width of nothing in the middle of the positions table.
   */
  readonly width: ColumnWidth
  readonly cell: (row: Row) => React.ReactNode
  /** Right-aligned, tabular figures — so a column of numbers reads down. */
  readonly numeric?: boolean
  /**
   * WRAPS RATHER THAN OVERFLOWS, which only the two narrow tables ask for.
   *
   * Every other cell here is `nowrap`, because a number split over two lines is
   * unreadable and every other value is short. A contract name in a 45% column
   * is neither: `NIFTY 26AUG2026 CE 25000` needs ~160px and the column has
   * ~130, and with `table-layout: fixed` a nowrap cell does not scroll — it
   * spills its text over the neighbour's. Two lines is the honest answer, and
   * Orders and Trades are a handful of rows, so the height is free.
   */
  readonly wrap?: boolean
  /** The hover text, where a cell has a twin worth surfacing. */
  readonly title?: (row: Row) => string | undefined
}

/**
 * Figures line up only when every digit is the same width.
 *
 * NO `textAlign` HERE ANY MORE: the alignment is declared once on the COLUMN,
 * which puts it on the `<th>` and the `<td>` together. Setting it on the cell
 * alone is exactly how this page ended up with right-aligned numbers under
 * left-aligned headers.
 */
const NUM_CELL = { ...NOWRAP, fontVariantNumeric: 'tabular-nums' } as const

/** Nothing that is not `NRML` squares off the way the desk assumes it does. */
function abnormalProduct(row: Record<string, unknown>): string | null {
  const p = str(pick(row, ['ProductType', 'productType']))
  return p === '' || p.toUpperCase() === 'NRML' ? null : p
}

/**
 * ONE CELL FOR THE WHOLE FILL STORY, AND THIS REPLACES THREE COLUMNS.
 *
 * The order book used to carry `Filled / Total` beside a `Pending` column,
 * which is the same subtraction printed twice: the shortfall in the fraction IS
 * what is still resting. It also printed `7,875 / 7,875` on every order that
 * had simply worked — a slash and a repeated number where a single figure says
 * more. Between them they cost ~210px on a table that was already scrolling
 * sideways inside a 45% column.
 *
 * THREE SHAPES, AND THEY ARE READ AT A GLANCE:
 *
 *  - `7,875`          — done. Nothing outstanding, so nothing else is said.
 *  - `5,250 / 7,875`  — working or partial. The gap is the pending.
 *  - `0 / 7,875`      — rejected or cancelled untouched. ZERO, NEVER A DASH:
 *                       a dash reads as "unknown" on the page whose whole
 *                       premise is that what it shows is what the broker holds.
 *
 * The long form goes on the cell's `title` — see `orderQtyTitle` — so the words
 * are a hover away without spending a column on them.
 */
function orderQty(row: Record<string, unknown>): string {
  const filled = num(pick(row, ['CumulativeQuantity', 'FilledQuantity']))
  const total = num(pick(row, ['OrderQuantity']))
  // No total to be a fraction OF. The filled figure alone is still the truth.
  if (total === null) return qty(filled)
  if (filled === null) return `${NONE} / ${qty(total)}`
  return filled === total ? qty(filled) : `${qty(filled)} / ${qty(total)}`
}

/** `filled 5,250 of 7,875 — 2,625 pending`, for the cell that only has room
 *  for the digits. A completed order invents no pending. */
function orderQtyTitle(row: Record<string, unknown>): string | undefined {
  const filled = num(pick(row, ['CumulativeQuantity', 'FilledQuantity']))
  const total = num(pick(row, ['OrderQuantity']))
  if (filled === null || total === null) return undefined
  const pending = total - filled
  const said = `filled ${inr(filled)} of ${inr(total)}`
  return pending > 0 ? `${said} ${NONE} ${inr(pending)} pending` : said
}

/**
 * The average traded price, WHICH ONLY EXISTS ONCE SOMETHING TRADED. XTS sends
 * `0` on an untouched order, and `0.00` in this column would read as a fill at
 * zero on the one screen that is supposed to be believed.
 */
function avgPrice(row: Record<string, unknown>): string {
  const filled = num(pick(row, ['CumulativeQuantity', 'FilledQuantity'])) ?? 0
  if (filled <= 0) return NONE
  return price(num(pick(row, ['OrderAverageTradedPrice', 'LastTradedPrice'])))
}

/**
 * Lots BESIDE the contract quantity, when the row itself says the lot size.
 *
 * Never fetched: the instrument master is an API call away and this page must
 * not grow one to decorate a column. `Marketlot` rides on the position row for
 * free, so the lots are shown when it is there and the quantity divides by it,
 * and simply omitted when it is not — a lot count that has to be guessed at is
 * worse than no lot count.
 */
function netQty(row: Record<string, unknown>): string {
  const q = num(pick(row, ['Quantity', 'NetQty', 'netQty', 'NetQuantity']))
  if (q === null) {
    const buy = num(row['OpenBuyQuantity'])
    const sell = num(row['OpenSellQuantity'])
    if (buy === null || sell === null) return NONE
    return signed(buy - sell)
  }
  const lot = num(pick(row, ['Marketlot', 'MarketLot', 'LotSize', 'Lotsize']))
  if (lot === null || !Number.isInteger(lot) || lot <= 1 || q % lot !== 0) return signed(q)
  const lots = Math.abs(q) / lot
  return `${signed(q)} (${inr(lots)} ${lots === 1 ? 'lot' : 'lots'})`
}

/** One side of a position as `qty @ avg`, or a dash when that side is empty. */
function sideCell(row: Record<string, unknown>, side: 'Buy' | 'Sell'): string {
  const q = actual(row, `Open${side}Quantity`).value
  if (q === null || q === 0) return NONE
  return `${inr(Math.abs(q))} @ ${price(actual(row, `${side}AveragePrice`).value)}`
}

/**
 * Sold minus bought — the premium the position has actually banked or paid.
 *
 * BOTH SIDES OR NOTHING. One amount alone is half the answer, and a half
 * answer signed in rupees would read as a real net.
 */
function netPremium(row: Record<string, unknown>): number | null {
  const sell = actual(row, 'SellAmount').value
  const buy = actual(row, 'BuyAmount').value
  return sell === null || buy === null ? null : sell - buy
}

/**
 * SYMBOL IS FIXED ON THE POSITIONS TABLE, AND THIS IS THE FIX FOR THE VOID.
 *
 * It used to be the only flexible column there, which means it absorbed every
 * spare pixel of the wide grid column on its own: the operator's screenshot of
 * 2026-08-15 shows a hand's width of nothing between `SENSEX 26AUG2026 PE
 * 80000` and `Net qty`, with the four figures huddled against the right edge.
 * Spare width is not one column's to hoard.
 *
 * 200px fits the longest symbol the desk actually trades at this type size
 * (`BANKNIFTY 26AUG2026 PE 55000` is ~185px), and the FOUR NUMERIC COLUMNS are
 * the proportional ones now — so the same spare arrives as four small even
 * gaps instead of a single hole.
 */
const POSITION_SYMBOL_WIDTH = pixel(200)

/**
 * ...AND FLEXIBLE, BUT MODEST, ON THE TWO NARROW ONES.
 *
 * Orders and Trades live in a 45% column with ~596px to spend, which the fixed
 * columns very nearly use up. Symbol takes the remainder and wraps to a second
 * line when a long contract needs one — see `Col.wrap`. The floor is what stops
 * the design system's 120px default from being the whole story on a table that
 * has to fit rather than scroll.
 */
// minWidth 170 and NO wrap: a contract name split over three lines is the
// thing the operator screenshotted (2026-08-16). The room comes from the
// grid track (710px, comfort.css), which is sized so the pixel columns plus
// this floor fit with a little spare — the track pays for the symbol, not
// the symbol for the track.
const SIDE_SYMBOL_WIDTH = proportional(1, { minWidth: 170 })

/**
 * THE BROKER'S ORDER ID IS NOT A COLUMN, on purpose, and this is the note that
 * stops it being added back.
 *
 * It is a twelve-digit number that is identical down the table's most valuable
 * axis and is never read while monitoring — it cost a column on the two
 * narrowest tables on the page. It is still on every row: Cancel addresses the
 * order by it, and the snapshot document in Mongo has it verbatim for the one
 * case (a support ticket) that genuinely needs it.
 */
/**
 * THREE MORE COLUMNS ARE GONE, AND THE REASON IS THAT THE TABLE HAS TO FIT.
 *
 * The two-column layout put this table in 45% of the page, and the set below it
 * overflowed by ~430px: the operator's screenshot shows Time and half of Filled
 * cut off inside the card's scroll box. A monitoring panel that has to be
 * scrolled sideways to be read is not being read.
 *
 *  - `Type`  said `Limit` on every row the desk sends. It is the one dropped
 *            purely for the fit, and the last that would come back.
 *  - `Pending` was `Total − Filled` restated in its own column — the Qty cell
 *            now carries the shortfall, which IS the pending.
 *  - `Limit price` is the number that stopped mattering the moment the order
 *            traded (operator, 2026-08-15: the average is what is read after
 *            the fact). It is still on the row in Mongo for the rare argument
 *            about what was actually sent.
 *
 * HEADERS ARE WORDS, NOT SENTENCES, for the same reason: `Avg price` and
 * `Filled / Total` set the column's minimum wider than the digits underneath
 * them ever needed.
 */
function orderColumns(today: string): readonly Col[] {
  return [
    { key: 'status', header: 'Status', width: pixel(96), cell: (r) => textOf(r, ['OrderStatus']) },
    { key: 'symbol', header: 'Symbol', width: SIDE_SYMBOL_WIDTH,
      cell: (r) => textOf(r, ['TradingSymbol', 'tradingSymbol']) },
    { key: 'side', header: 'Side', width: pixel(48), cell: (r) => textOf(r, ['OrderSide']) },
    // ONE column for the whole fill story — see `orderQty`. `Qty`, not
    // `Filled / Total`: the header was wider than the figures.
    { key: 'qty', header: 'Qty', numeric: true, width: pixel(102),
      cell: orderQty, title: orderQtyTitle },
    { key: 'avg', header: 'Avg', numeric: true, width: pixel(64), cell: avgPrice },
    // Today's book, so a bare clock — the day prefix appears only on the row
    // that needs it, and that row is the exception here.
    { key: 'time', header: 'Time', width: pixel(112), cell: (r) => when(r, ORDER_TIME, today) },
  ]
}

function tradeColumns(today: string): readonly Col[] {
  return [
    { key: 'status', header: 'Status', width: pixel(96), cell: (r) => textOf(r, ['OrderStatus']) },
    { key: 'symbol', header: 'Symbol', width: SIDE_SYMBOL_WIDTH,
      cell: (r) => textOf(r, ['TradingSymbol', 'tradingSymbol']) },
    { key: 'side', header: 'Side', width: pixel(48), cell: (r) => textOf(r, ['OrderSide']) },
    /*
      CUMULATIVE, not this print's quantity — the trade book's rows repeat the
      running total, and summing them double-counts every partial. That fact
      lives on the cell's hover rather than in the header: `Filled (cum)` spent
      a third of the column on a parenthesis that is read once and then never
      again, on a table that had to give the width back.
    */
    { key: 'qty', header: 'Qty', numeric: true, width: pixel(78),
      cell: (r) => qty(num(pick(r, ['CumulativeQuantity', 'LastTradedQuantity']))),
      title: () => "cumulative for the order, not this print's quantity — summing this column double-counts every partial" },
    { key: 'avg', header: 'Avg', numeric: true, width: pixel(64), cell: avgPrice },
    // Wider than the order book's: a trade from another day carries its date.
    { key: 'time', header: 'Time', width: pixel(112), cell: (r) => when(r, TRADE_TIME, today) },
  ]
}

/** The em dash a Total row prints in a column it is not a total of. */
const MUTED_NONE = <Text size="sm" color="secondary">{NONE}</Text>

/**
 * THE FOUR NUMERIC COLUMNS SHARE THE REMAINDER, EQUALLY.
 *
 * One unit each, so whatever the 55% grid column has spare after Symbol's
 * 200px arrives as four identical gaps rather than one void beside Symbol. The
 * floor is the widest figure each can hold — `-1,200 (60 lots)`, `1,200 @
 * 1,234.56` — so they never collapse under the design system's 120px default
 * and never need the header truncated either.
 */
const POSITION_NUMBER_WIDTH = proportional(1, { minWidth: 115 })

const POSITION_COLUMNS: readonly Col[] = [
  { key: 'symbol', header: 'Symbol', width: POSITION_SYMBOL_WIDTH,
    cell: (r) => {
      if (isTotalRow(r)) {
        /*
          WHAT THE TOTAL IS A TOTAL OF, said under the word — the same shape the
          strategy page's positions table uses. The count is the half an
          operator checks against the badge in the card's heading.
        */
        const n = Number(r[TOTAL_COUNT] ?? 0)
        return (
          <VStack gap={0}>
            <Text weight="bold" size="sm">Total</Text>
            <Text size="xsm" color="secondary">{`${inr(n)} position${n === 1 ? '' : 's'}`}</Text>
          </VStack>
        )
      }
      const odd = abnormalProduct(r)
      return (
        <HStack gap={1} align="center">
          <Text size="sm">{textOf(r, ['TradingSymbol', 'tradingSymbol'])}</Text>
          {odd === null ? null : <Badge variant="warning" label={odd} />}
        </HStack>
      )
    } },
  { key: 'qty', header: 'Net qty', numeric: true, width: POSITION_NUMBER_WIDTH,
    cell: (r) => (isTotalRow(r) ? MUTED_NONE : netQty(r)) },
  /*
    NO TOTAL ON THE TWO SIDES. `Sold` and `Bought` are `qty @ avg`, and an
    average price summed across four different strikes describes nothing.
  */
  { key: 'sold', header: 'Sold', numeric: true, width: POSITION_NUMBER_WIDTH,
    cell: (r) => (isTotalRow(r) ? MUTED_NONE : sideCell(r, 'Sell')),
    title: (r) => {
      const other = actual(r, 'SellAveragePrice').other
      return other === null ? undefined : `the broker also sent SellAveragePrice ${other}`
    } },
  { key: 'bought', header: 'Bought', numeric: true, width: POSITION_NUMBER_WIDTH,
    cell: (r) => (isTotalRow(r) ? MUTED_NONE : sideCell(r, 'Buy')),
    title: (r) => {
      const other = actual(r, 'BuyAveragePrice').other
      return other === null ? undefined : `the broker also sent BuyAveragePrice ${other}`
    } },
  { key: 'premium', header: 'Net premium', numeric: true, width: POSITION_NUMBER_WIDTH,
    cell: (r) => {
      const total = isTotalRow(r)
      const n = total ? (r[TOTAL_PREMIUM] as number | null) : netPremium(r)
      return (
        <Text
          size="sm"
          weight={total ? 'bold' : 'medium'}
          style={{ ...NUM_CELL, ...(n === null ? {} : sign(n)) }}
        >
          {money(n, 2)}
        </Text>
      )
    } },
]

// ------------------------------------------------ the order positions read in

/**
 * THE ORDER XTS ANSWERS IN IS THE ORDER ITS BOOK HAPPENS TO HOLD — which is to
 * say, none. Eighteen legs across four underlyings arrived interleaved, and the
 * operator grouped them by eye every time the page was opened.
 *
 * THE KEY IS DERIVED FROM THE BROKER'S STRING, FOR ORDERING ONLY. Nothing here
 * touches what is displayed: the cell still prints the broker's own spelling,
 * character for character. That is the whole safety argument for parsing a
 * symbol on a page whose entire premise is not to reinterpret the broker —
 * a wrong parse costs a row's POSITION in a list, never its content.
 *
 * A ROW THAT DOES NOT PARSE IS MOVED, NEVER DROPPED. Futures, spreads and any
 * spelling this file has not seen sort to the end in the order they arrived, so
 * the unrecognised are together and obvious rather than scattered or missing.
 */
const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC']

/**
 * `SENSEX 26AUG2026 PE 80000` — underlying, expiry, right, strike.
 *
 * `\s+` rather than a single space: the separator is the broker's whitespace,
 * and a double space would otherwise send an ordinary leg to the bottom of the
 * table with no visible reason for it.
 */
const XTS_OPTION = /^([A-Z][A-Z0-9]*)\s+(\d{1,2})([A-Z]{3})(\d{4})\s+(CE|PE)\s+(\d+(?:\.\d+)?)$/

interface SortKey {
  readonly underlying: string
  /** `2026-08-26` — sortable as text precisely because it is zero-padded. */
  readonly expiry: string
  readonly strike: number
  /** 0 for a call, 1 for a put: CE before PE at the same strike. */
  readonly right: number
}

function sortKey(symbol: string): SortKey | null {
  const m = XTS_OPTION.exec(symbol.trim().toUpperCase())
  if (m === null) return null
  const month = MONTHS.indexOf(m[3] as string)
  if (month < 0) return null
  return {
    underlying: m[1] as string,
    expiry: `${m[4]}-${String(month + 1).padStart(2, '0')}-${(m[2] as string).padStart(2, '0')}`,
    // A NUMBER, not the string: `1000` sorts before `880` as text.
    strike: Number(m[6]),
    right: m[5] === 'CE' ? 0 : 1,
  }
}

function sortPositions(rows: readonly Row[]): Row[] {
  const keyed = rows.map((row, i) => ({
    row,
    i,
    key: sortKey(str(pick(row, ['TradingSymbol', 'tradingSymbol']))),
  }))
  keyed.sort((a, b) => {
    if (a.key === null || b.key === null) {
      // Arrival order among the unparsed, and behind everything that parsed.
      if (a.key === null && b.key === null) return a.i - b.i
      return a.key === null ? 1 : -1
    }
    return (
      a.key.underlying.localeCompare(b.key.underlying) ||
      a.key.expiry.localeCompare(b.key.expiry) ||
      a.key.strike - b.key.strike ||
      a.key.right - b.key.right ||
      a.i - b.i
    )
  })
  return keyed.map((k) => k.row)
}

// ------------------------------------------------------------- the total row

/**
 * DECLARED FIELDS, not smuggled ones — the same rule the strategy page's total
 * row follows. The total is a row in the table rather than a line under it so
 * the figure sits beneath the column that produced it, which is what makes it
 * checkable rather than merely stated.
 *
 * The `__desk` prefix is what keeps it from ever colliding with a broker key.
 */
const TOTAL_ROW = '__deskTotalRow'
const TOTAL_COUNT = '__deskCount'
const TOTAL_PREMIUM = '__deskPremium'

function isTotalRow(row: Row): boolean {
  return row[TOTAL_ROW] === true
}

/**
 * The rows, plus a Total — appended AFTER the sort so it stays last.
 *
 * UNKNOWN THE MOMENT ONE ROW CANNOT BE NETTED, which is the rule every other
 * total on this desk obeys: a sum over the rows that DID net is a confident
 * number understated by an unknown amount, and this is the page that exists to
 * refuse confident-looking wrong answers.
 */
function withTotal(rows: readonly Row[]): Row[] {
  if (rows.length === 0) return [...rows]
  const premiums = rows.map(netPremium)
  return [...rows, {
    [TOTAL_ROW]: true,
    [TOTAL_COUNT]: rows.length,
    [TOTAL_PREMIUM]: premiums.some((p) => p === null)
      ? null
      : premiums.reduce((n: number, p) => n + (p ?? 0), 0),
  }]
}

/** Terminal statuses, matching the gateway's own list. */
const CLOSED = ['Filled', 'Replaced', 'Cancelled', 'Rejected']

function RowTable(props: {
  rows: readonly Record<string, unknown>[]
  /**
   * ALREADY IN THE DESIGN SYSTEM'S SHAPE, and built by the caller rather than
   * here — see `useBrokerColumns`. Mapping `Col`s inside this component would
   * hand the table a new array of new column objects on every poll, which is
   * the thing the memoisation exists to avoid.
   */
  columns: readonly TableColumn<Row>[]
  empty: string
  /** The shape the reply had, when the list came back empty. */
  shape?: string | undefined
  /** The snapshot failed on a dead session, off-hours — see `marketClosedSession`. */
  marketClosed?: boolean | undefined
}): React.ReactElement {
  if (props.rows.length === 0) {
    // `array(0)` is the broker genuinely saying "nothing". Anything else means
    // the reply was not a list at all, and an empty table would be a lie.
    const read = props.shape === undefined || props.shape.startsWith('array(')
    if (read) return <Text size="sm" color="secondary">{props.empty}</Text>
    /**
     * SAME FACT, DIFFERENT WEIGHT. There is still nothing readable here, and
     * the box still refuses to let the empty table pass as "the broker holds
     * nothing" — but off-hours with a dead session the reason is known and
     * expected, and three red boxes saying it teaches the operator to skip
     * them. The one that matters, in-session, keeps its red.
     */
    if (props.marketClosed === true) {
      return (
        <Banner
          status="info"
          title="Market closed — this list could not be read"
          description={
            `The broker session had expired when the snapshot was taken, so it answered ` +
            `${props.shape} rather than a list. This is not "the broker holds nothing": ` +
            `nobody asked it successfully.`
          }
        />
      )
    }
    return (
      <Banner
        status="error"
        title="This list is empty because the reply could not be read"
        description={
          `The broker answered with ${props.shape}, not a list. Do NOT read this as ` +
          `"the broker holds nothing" — that is the mistake that reconciles a live order away.`
        }
      />
    )
  }
  /*
    THE DESIGN SYSTEM'S TABLE, NOT A HAND-ROLLED ONE.

    The hand-rolled `<table>` this replaces sized itself to its content, so it
    sat in the left half of its card with the rest of the card empty; it drew
    its own header opacity, its own padding and its own scroll box, none of
    which matched the positions table or the order log. `density="compact"` and
    `hasHover` are what those tables ask for, and the row dividers, the header
    weight and the horizontal scroll container all come with them — so this page
    now inherits a change to the desk's table styling instead of drifting from
    it.

    `compact` IS THE FLOOR, and there is no tighter step to ask for: the design
    system's three densities are compact / balanced / spacious, and compact is
    already 4px block by 8px inline (`TableCell.tsx`). Every pixel the narrow
    tables needed had to come out of the COLUMN SET, not out of the padding.
  */
  return (
    <Table
      data={props.rows as Row[]}
      columns={props.columns as TableColumn<Row>[]}
      density="compact"
      hasHover
    />
  )
}

/**
 * Cancel, as a real column — first, and fixed-width.
 *
 * Only a LIVE order can be cancelled. Offering it on a filled one invites a
 * click that can only ever report "already gone".
 */
function cancelColumn(
  onCancel: (id: string) => void,
  cancelling: ReadonlySet<string> | undefined,
): Col {
  return {
    key: 'cancel',
    header: '',
    // 80, not 92: this column is pure chrome on a table that had to give width
    // back to the broker's own figures, and a ghost `sm` button fits it.
    width: pixel(74),
    cell: (r) => {
      const id = String(r['AppOrderID'] ?? '')
      const live = !CLOSED.includes(String(r['OrderStatus'] ?? ''))
      if (!live || id === '') return null
      return (
        <Button
          label={cancelling?.has(id) === true ? 'Cancelling…' : 'Cancel'}
          variant="ghost"
          size="sm"
          isDisabled={cancelling?.has(id) === true}
          onClick={() => onCancel(id)}
        />
      )
    },
  }
}

/**
 * A `Col` as the design system reads it.
 *
 * `align` IS DECLARED ON THE COLUMN, which is the fix for headers that did not
 * line up with their cells: the table puts one `text-align` on the `<th>` and
 * the `<td>` together, so a numeric column's dash, its figures and its label
 * all land on the same edge.
 *
 * A cell that renders to a bare string is wrapped in the desk's own `Text` so
 * it matches every other table's type; a cell that already returns markup is
 * left exactly as it built itself.
 */
function toTableColumn(c: Col): TableColumn<Row> {
  return {
    key: c.key,
    header: c.header,
    width: c.width,
    ...(c.numeric === true ? { align: 'end' as const } : {}),
    renderCell: (r: Row) => {
      const body = c.cell(r)
      const content =
        typeof body === 'string'
          // `wrap` is the narrow tables' Symbol, and only that — see `Col.wrap`.
          ? <Text size="sm" style={c.numeric === true ? NUM_CELL : c.wrap === true ? undefined : NOWRAP}>{body}</Text>
          : body
      const hover = c.title?.(r)
      // The twin figure the broker also sent, kept reachable by hovering rather
      // than by opening Mongo — see `actual`.
      return hover === undefined ? content : <span title={hover}>{content}</span>
    },
  }
}

// ------------------------------------------------- columns that outlive a poll

/**
 * THE COLUMNS ARE BUILT ONCE, AND THIS IS NOT A MICRO-OPTIMISATION.
 *
 * The design system's table memoises each row and compares, among other things,
 * the identity of the `columns` array it was handed (`areRowPropsEqual` in
 * `BaseTable.tsx`); the row's own data is compared by VALUE, so a poll that
 * changes nothing costs nothing — unless the columns are new objects, in which
 * case every cell of every row is rebuilt. This page rebuilt all three column
 * sets, and every `renderCell` closure inside them, on every render. With a
 * 15s poll and an eighteen-leg book that is the whole page re-rendering four
 * times a minute for a snapshot that usually has not changed.
 *
 * POSITIONS DEPEND ON NOTHING, so they are mapped here, at module scope.
 * Orders and trades depend only on `today` — the IST day their Time cells date
 * a row against — so they are memoised on it and rebuilt exactly when it rolls
 * over. Exported for the test that keeps this property from regressing.
 */
export const POSITION_TABLE_COLUMNS: readonly TableColumn<Row>[] =
  POSITION_COLUMNS.map(toTableColumn)

export function useBrokerColumns(
  today: string,
  onCancel: (appOrderId: string) => void,
  cancelling: ReadonlySet<string>,
): { orders: readonly TableColumn<Row>[]; trades: readonly TableColumn<Row>[] } {
  const orderCols = useMemo(() => orderColumns(today).map(toTableColumn), [today])
  const trades = useMemo(() => tradeColumns(today).map(toTableColumn), [today])
  /*
    The cancel column carries the handler and the in-flight set, so it is the
    one that legitimately changes — but only when a Cancel is actually clicked,
    never on a poll. `onCancel` is stable by `useCallback` at the call site;
    without that this memo would rebuild on every render and take the orders
    table with it.
  */
  const orders = useMemo(
    // Cancel sits LAST: leading the row put an empty cell before Status on
    // every non-cancellable order, which read as a layout bug (operator
    // screenshot, 2026-08-16). An action belongs at the end of the row.
    () => [...orderCols, toTableColumn(cancelColumn(onCancel, cancelling))],
    [onCancel, cancelling, orderCols],
  )
  return { orders, trades }
}

function age(ms: number): string {
  const s = Math.round(ms / 1000)
  if (s < 90) return `${s}s ago`
  return `${Math.round(s / 60)}m ago`
}

export function BrokerViewPage(): React.ReactElement {
  const { data, error, refresh } = usePoll(() => api.brokerView(), POLL_MS)
  const [cancelling, setCancelling] = useState<ReadonlySet<string>>(new Set())
  const [cancelError, setCancelError] = useState<string | null>(null)

  /**
   * `useCallback` SO THE ORDERS COLUMNS SURVIVE A POLL — see
   * `useBrokerColumns`. A fresh handler each render would rebuild the cancel
   * column, and with it the whole orders column array, every 15s.
   *
   * `refresh` is the only thing it closes over; the two setters are stable.
   */
  const cancel = useCallback((id: string): void => {
    setCancelling((s) => new Set([...s, id]))
    setCancelError(null)
    void api
      .cancelBrokerOrder(id)
      // The gateway performs it within ~2s, so re-read shortly after rather
      // than claiming success here — the order leaving the table is the proof.
      .then(() => setTimeout(refresh, 2500))
      .catch((e: unknown) => setCancelError(explain(e)))
      .finally(() =>
        setTimeout(() => setCancelling((s) => new Set([...s].filter((x) => x !== id))), 3000),
      )
  }, [refresh])

  /*
    HOOKS BEFORE THE EARLY RETURNS, which is why `today` is read up here rather
    than beside the tables it feeds. It is the IST calendar day the Time columns
    date their rows against — taken once per render so two tables cannot
    disagree about what "today" is.
  */
  const today = istDate()
  const { orders: orderCols, trades: tradeCols } = useBrokerColumns(today, cancel, cancelling)

  if (error !== null) return <Banner status="error" title="Could not load the broker view" description={error} />
  if (data === null) return <Text size="sm" color="secondary">Loading the broker's view…</Text>

  if (!data.available) {
    return (
      <VStack gap={2}>
        <Heading level={2}>Broker</Heading>
        <Banner
          status="info"
          title="No broker view available"
          description={
            data.reason ??
            'The gateway publishes a snapshot only against the real broker, not in simulate mode.'
          }
        />
      </VStack>
    )
  }

  const orders = data.orders ?? []
  const positions = data.positions ?? []
  const trades = data.trades ?? []
  const stale = data.stale === true
  const closed = marketClosedSession(data)
  // The loud failure state, which `closed` carves the one quiet case out of.
  const failed = data.ok === false && !closed

  return (
    <VStack gap={2}>
      <HStack gap={1} align="center">
        <Heading level={2}>Broker</Heading>
        <Badge
          // Neutral, not green, when the market is shut: the snapshot did fail,
          // and a success badge over a failed read would be the confirmation
          // this page exists to refuse.
          variant={closed ? 'neutral' : stale || failed ? 'error' : 'success'}
          label={data.ageMs === undefined ? 'unknown age' : age(data.ageMs)}
        />
      </HStack>

      {/* ONE LINE. The longer version cost two rows of the fold on a page whose
          whole value is how many rows of the broker's book fit on the screen. */}
      <Text size="sm" color="secondary">
        What the broker holds, not the desk's record of it — where they disagree, the broker is right.
      </Text>

      {cancelError !== null ? (
        <Banner status="error" title="The cancel request was not accepted" description={cancelError} />
      ) : null}

      {failed ? (
        <Banner
          status="error"
          title="The last snapshot did not complete"
          description={`These lists may be incomplete, or empty for the wrong reason — ${data.error ?? ''}`}
        />
      ) : null}

      {closed ? (
        <Banner
          status="info"
          title="Market closed — the broker session has expired"
          description={
            "The gateway's token lapsed outside trading hours, so the broker refused these " +
            'reads. It re-logs in and answers again from the next session. Nothing below is ' +
            'current — but nothing here is a fault either.'
          }
        />
      ) : null}

      {stale && !failed ? (
        <Banner
          status="warning"
          title={`This snapshot is ${data.ageMs === undefined ? 'old' : age(data.ageMs)}`}
          description="The gateway refreshes every 30s, so it has missed several. Treat this as history, not as current."
        />
      ) : null}

      {/*
        THE THREE CARDS, IN TWO COLUMNS ON A WIDE SCREEN.

        POSITIONS LEADS, AND IT IS THE ONE THAT NEEDED THE ROOM. It is the
        tallest and the most-read section — an eighteen-leg book against five
        columns — while Orders and Trades are usually a handful of rows each
        and were pushing it below the fold. It takes the larger share of the
        wide layout; the other two stack in a column beside it.

        DOM ORDER IS THE NARROW-VIEWPORT ORDER: Positions, then Orders, then
        Trades. The columns come from explicit grid placement in comfort.css,
        not from reordering this markup, so the collapse below 1200px — and a
        screen reader, which follows the DOM and not the grid — both get the
        order that was actually chosen. The wrappers are plain `div`s because
        the classes have to land on the GRID ITEMS themselves, and a `Card` is
        free to render whatever element it likes underneath.
      */}
      <div className="broker-grid">
        <div className="broker-grid-positions">
          <Card>
            <VStack gap={1}>
              <HStack gap={1} align="center">
                <Heading level={3}>Positions</Heading>
                <Badge label={String(positions.length)} />
              </HStack>
              <RowTable
                rows={withTotal(sortPositions(positions))}
                columns={POSITION_TABLE_COLUMNS}
                empty="The broker reports no open positions."
                shape={data.emptyDiagnostic?.positions}
                marketClosed={closed}
              />
            </VStack>
          </Card>
        </div>

        <div className="broker-grid-side">
          <Card>
            <VStack gap={1}>
              <HStack gap={1} align="center">
                <Heading level={3}>Orders</Heading>
                <Badge label={String(orders.length)} />
              </HStack>
              {/* One short line each, not a paragraph: every row of caption is
                  a row of the broker's book that fell off the screen. */}
              <Text size="xsm" color="secondary">Today's book — resting and completed alike.</Text>
              <RowTable
                rows={orders}
                columns={orderCols}
                empty="The broker reports no orders today."
                shape={data.emptyDiagnostic?.orders}
                marketClosed={closed}
              />
            </VStack>
          </Card>

          <Card>
            <VStack gap={1}>
              <HStack gap={1} align="center">
                <Heading level={3}>Trades</Heading>
                <Badge label={String(trades.length)} />
              </HStack>
              <Text size="xsm" color="secondary">What actually executed, cumulative per order.</Text>
              <RowTable
                rows={trades}
                columns={tradeCols}
                empty="The broker reports no trades today."
                shape={data.emptyDiagnostic?.trades}
                marketClosed={closed}
              />
            </VStack>
          </Card>
        </div>
      </div>
    </VStack>
  )
}
