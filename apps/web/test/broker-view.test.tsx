/**
 * The broker view's ONE quiet case: a session that expired while the market was
 * shut.
 *
 * Everything else on this page is loud on purpose — a broker view that reads as
 * confirmation while it is frozen or failed is worse than no broker view at
 * all. But the gateway's token lapses every night, and re-reading a shut
 * exchange with a dead token is not a fault: it painted the page red every
 * weekend, which is how an operator learns that red here means nothing.
 *
 * THE TEST THAT MATTERS IS THE MIRROR ONE. The same failure inside a session
 * means live orders are failing right now, and it must stay red.
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { expect, test, describe, vi, afterEach } from 'vitest'
import { act, render, renderHook, screen, within } from '@testing-library/react'
import { BrokerViewPage, POSITION_TABLE_COLUMNS, useBrokerColumns } from '../src/broker-view.tsx'
import { installFetch } from './http.tsx'

/** Sat 2026-08-01, 11:00 IST — session hours, but the exchange is shut. */
const WEEKEND = new Date('2026-08-01T11:00:00+05:30').getTime()
/** Tue 2026-07-28, 11:00 IST — mid-session. */
const IN_SESSION = new Date('2026-07-28T11:00:00+05:30').getTime()

/** A snapshot that failed with a dead token, taken at `asOf`. */
function failed(asOf: number, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    available: true,
    asOf,
    ageMs: 20_000,
    stale: false,
    ok: false,
    error: 'orders: Invalid Token; positions: Invalid Token',
    orders: [], positions: [], trades: [],
    emptyDiagnostic: { orders: 'undefined', positions: 'undefined', trades: 'undefined' },
    errorClass: 'session',
    sessionOpenAtSnapshot: false,
    ...over,
  }
}

async function mount(now: number, body: Record<string, unknown>): Promise<void> {
  vi.useFakeTimers()
  vi.setSystemTime(now)
  installFetch(({ path }) => (path === '/v1/desk/broker' ? { body } : { body: {} }))
  render(<BrokerViewPage />)
  // `findByText` polls the timers `useFakeTimers` replaced, so it never
  // resolves on its own — the fake clock is advanced from out here instead.
  await act(async () => { await vi.advanceTimersByTimeAsync(0) })
}

afterEach(() => { vi.useRealTimers() })

describe('a session that expired outside market hours', () => {
  test('reads as "Market closed", not as a failure', async () => {
    await mount(WEEKEND, failed(WEEKEND))
    expect(screen.getAllByText(/Market closed/).length).toBeGreaterThan(0)
    expect(screen.queryByText('The last snapshot did not complete')).toBe(null)
  })

  test('the empty lists say the market is shut, not that the reply was unreadable', async () => {
    // `undefined` is not `array(0)`, so these boxes normally shout that the
    // reply could not be read. Off-session with a dead token there is nothing
    // to read, and saying so three times in red teaches the operator nothing.
    await mount(WEEKEND, failed(WEEKEND))
    expect(screen.queryAllByText(/reply could not be read/)).toEqual([])
  })
})

describe('the same failure inside a session', () => {
  test('stays red — a token failing at 11:00 on a Tuesday is orders failing', async () => {
    await mount(IN_SESSION, failed(IN_SESSION, { sessionOpenAtSnapshot: true }))
    screen.getByText('The last snapshot did not complete')
    expect(screen.getAllByText(/reply could not be read/).length).toBeGreaterThan(0)
    expect(screen.queryByText(/Market closed/)).toBe(null)
  })

  test('is judged by the SNAPSHOT, not by when the page is looked at', async () => {
    // Read on Saturday, taken on Tuesday: the orders it could not see were live
    // orders, and the weekend does not make that better.
    await mount(WEEKEND, failed(IN_SESSION, { sessionOpenAtSnapshot: true }))
    screen.getByText('The last snapshot did not complete')
  })
})

describe('a snapshot nobody classified', () => {
  test('an OLDER gateway sends no errorClass, and the page stays loud', async () => {
    // FAIL-LOUD DEFAULT. The quiet state is earned by a field that says so;
    // silence is not consent to be quiet.
    const body = failed(WEEKEND)
    delete body['errorClass']
    delete body['sessionOpenAtSnapshot']
    await mount(WEEKEND, body)
    screen.getByText('The last snapshot did not complete')
  })

  test('a non-session failure off-hours is still a failure', async () => {
    // "ClientID cannot be empty" does not stop being a bug because it is
    // Saturday — nothing about the clock explains it.
    await mount(WEEKEND, failed(WEEKEND, { errorClass: 'fatal', error: 'ClientID cannot be empty.' }))
    screen.getByText('The last snapshot did not complete')
  })

  test('the gateway saying the market was OPEN overrides the clock, loudly', async () => {
    // The two sides disagree about the session. A disagreement is never a
    // reason to quieten: whichever is wrong, someone should look.
    await mount(WEEKEND, failed(WEEKEND, { sessionOpenAtSnapshot: true }))
    screen.getByText('The last snapshot did not complete')
  })
})

/*
  THE CURATED TABLES.

  The page used to print every key the broker sent, verbatim: seventeen columns
  per order, `3.6333333333333333` in a price cell, and `AccountID` repeating
  `PRO111` down the whole table. The numbers below are the real ones from the
  2026-08-15 screenshot that prompted the curation — they are kept exactly as
  the broker sends them (strings with commas, unrounded floats, zeroes that mean
  "nothing") because every one of those shapes is a way the formatting can go
  wrong.
*/

/** A snapshot that succeeded, mid-session, carrying whatever rows are given. */
function good(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    available: true,
    asOf: IN_SESSION,
    ageMs: 5_000,
    stale: false,
    ok: true,
    error: '',
    orders: [], positions: [], trades: [],
    ...over,
  }
}

/** Partially filled, resting — and carrying five noise fields. */
const ORDER = {
  AppOrderID: 1240043411,
  OrderStatus: 'PartiallyFilled',
  TradingSymbol: 'NIFTY 26AUG2026 CE 25000',
  OrderSide: 'SELL',
  OrderType: 'Limit',
  OrderQuantity: 7875,
  CumulativeQuantity: 5250,
  LeavesQuantity: 2625,
  OrderPrice: 3.6333333333333333,
  OrderAverageTradedPrice: '8.266666666666667',
  OrderGeneratedDateTime: '28-07-2026 10:24:31',
  AccountID: 'PRO111',
  ProductType: 'NRML',
  ApplicationType: 4,
  ExchangeInstrumentId: 43521,
  OrderUniqueIdentifier: 'ORB_SCALP|c-9',
}

/** Executed yesterday — so the Time column has to say which day. */
const TRADE = {
  AppOrderID: 1240043399,
  OrderStatus: 'Filled',
  TradingSymbol: 'BANKNIFTY 26AUG2026 PE 55000',
  OrderSide: 'BUY',
  OrderType: 'Limit',
  OrderPrice: 0,
  ProductType: 'NRML',
  CumulativeQuantity: 105,
  OrderAverageTradedPrice: '3.6333333333333333',
  ExchangeTransactTime: '2026-07-27T15:12:04',
  AccountID: 'PRO111',
}

/** A short, sold-only: the Bought side is a real "nothing", not a zero price. */
const POSITION = {
  TradingSymbol: 'SENSEX 26AUG2026 PE 80000',
  Quantity: '-40',
  Marketlot: 20,
  OpenBuyQuantity: '0',
  OpenSellQuantity: '40',
  BuyAveragePrice: '0',
  SellAveragePrice: '8.266666666666667',
  BuyAmount: '0',
  SellAmount: '330.66666666666663',
  ActualBuyAmount: '0',
  ActualSellAmount: '330.66666666666663',
  AccountID: 'PRO111',
  ProductType: 'NRML',
  ApplicationType: 4,
  BEP: '0.00',
  ExchangeInstrumentId: 1141234,
  Multiplier: 1,
}

/**
 * The cells of the one body row naming `symbol`, in column order.
 *
 * Read positionally rather than by text, because the assertions that matter
 * here are about a SPECIFIC column: "Pending is a dash" and "the page contains
 * a dash somewhere" are not the same claim, and only the first one is a test.
 */
function cellsFor(symbol: string): string[] {
  const row = screen.getAllByRole('row').find((r) => (r.textContent ?? '').includes(symbol))
  if (row === undefined) throw new Error(`no row for ${symbol}`)
  return [...row.querySelectorAll('td')].map((td) => td.textContent ?? '')
}

describe('the orders table', () => {
  test('prices are rounded to two places, never printed raw', async () => {
    await mount(IN_SESSION, good({ orders: [ORDER] }))
    expect(cellsFor('NIFTY 26AUG2026 CE 25000')).toContain('8.27')
    expect(screen.queryByText('3.6333333333333333')).toBe(null)
    expect(screen.queryByText('8.266666666666667')).toBe(null)
  })

  test('a stamp from today is the clock alone', async () => {
    await mount(IN_SESSION, good({ orders: [ORDER] }))
    expect(cellsFor('NIFTY 26AUG2026 CE 25000')).toContain('10:24:31')
  })

  test('the 1.162 build\'s "dd-mm-yyyy HH:MM:SS.fff" stamp renders as a clock, millis dropped', async () => {
    // Symphony's change log 1.160 -> 1.162: every DateTime gains a space and
    // milliseconds, and AppOrderID becomes a 20-digit string (relayed as text
    // by this page; its exactness is pinned in packages/brokers). The Time
    // column must still read as a clock — with the day, since it is not today.
    const v2 = {
      ...ORDER,
      AppOrderID: '18001251480000036744',
      OrderGeneratedDateTime: '05-01-2026 12:47:43.492',
      LastUpdateDateTime: '05-01-2026 12:51:15.736',
      ExchangeTransactTime: '05-01-2026 12:51:15.000',
    }
    await mount(IN_SESSION, good({ orders: [v2] }))
    const cells = cellsFor('NIFTY 26AUG2026 CE 25000')
    expect(cells.some((c) => /Jan 12:47:43$/.test(c))).toBe(true)
    expect(cells.some((c) => /\.492/.test(c))).toBe(false)
  })

  test('the noise columns are gone', async () => {
    await mount(IN_SESSION, good({ orders: [ORDER] }))
    for (const noise of ['AccountID', 'ApplicationType', 'ExchangeInstrumentId', 'OrderUniqueIdentifier']) {
      expect(screen.queryByText(noise)).toBe(null)
    }
    expect(screen.queryByText('PRO111')).toBe(null)
    expect(screen.queryByText('43521')).toBe(null)
    expect(screen.queryByText('ORB_SCALP|c-9')).toBe(null)
  })

  /**
   * THE BROKER ID IS NO LONGER A COLUMN — it is still in the row.
   *
   * A twelve-digit number that is never read while monitoring cost a column on
   * the narrowest table on the page. It stays in the data because Cancel is
   * addressed by it, and it is one Mongo query away when a support ticket
   * genuinely needs it.
   */
  test('the broker id is not a column, and Cancel still works without one', async () => {
    await mount(IN_SESSION, good({ orders: [ORDER] }))
    expect(screen.queryByText('Broker ID')).toBe(null)
    expect(screen.queryByText('1240043411')).toBe(null)
    screen.getByRole('button', { name: 'Cancel' })
  })

  test('the status, symbol and side lead the row', async () => {
    await mount(IN_SESSION, good({ orders: [ORDER] }))
    const cells = cellsFor('NIFTY 26AUG2026 CE 25000')
    expect(cells.slice(0, 3)).toEqual([
      'PartiallyFilled', 'NIFTY 26AUG2026 CE 25000', 'SELL',
    ])
  })
})

/*
  THE COLUMN SET THAT FITS.

  On the deployed two-column page the order book overflowed its 42% column and
  scrolled sideways: Time and half of Filled were off the right edge of the
  card, on the panel whose entire job is to be glanced at. Three columns were
  paid for and never read — Type is `Limit` on every row the desk sends,
  Pending is `Total − Filled` restated, and Limit price is the number that
  stopped mattering the moment the order traded.
*/

describe('the columns that went, so the rest could fit', () => {
  test('Pending is gone: the shortfall inside Qty IS the pending', async () => {
    await mount(IN_SESSION, good({ orders: [ORDER] }))
    expect(screen.queryByRole('columnheader', { name: 'Pending' })).toBe(null)
    // 2,625 survives only in the hover text, never as a cell of its own.
    expect(cellsFor('NIFTY 26AUG2026 CE 25000')).not.toContain('2,625')
  })

  test('Limit price is gone: after the fact the average is what is read', async () => {
    await mount(IN_SESSION, good({ orders: [ORDER] }))
    expect(screen.queryByRole('columnheader', { name: 'Limit price' })).toBe(null)
    // 3.63 was this order's limit. Its average, 8.27, is still there.
    expect(cellsFor('NIFTY 26AUG2026 CE 25000')).not.toContain('3.63')
    expect(cellsFor('NIFTY 26AUG2026 CE 25000')).toContain('8.27')
  })

  test('Type is gone too — it is the last column the fit needed back', async () => {
    await mount(IN_SESSION, good({ orders: [ORDER] }))
    expect(screen.queryByRole('columnheader', { name: 'Type' })).toBe(null)
    expect(cellsFor('NIFTY 26AUG2026 CE 25000')).not.toContain('Limit')
  })

  test('the headers are words, not sentences', async () => {
    await mount(IN_SESSION, good({ orders: [ORDER], trades: [TRADE] }))
    expect(screen.getAllByRole('columnheader', { name: 'Qty' })).toHaveLength(2)
    expect(screen.getAllByRole('columnheader', { name: 'Avg' })).toHaveLength(2)
    for (const long of ['Avg price', 'Filled / Total', 'Filled (cum)']) {
      expect(screen.queryByRole('columnheader', { name: long })).toBe(null)
    }
  })
})

/*
  THE ONE QTY CELL.

  `Filled / Total` beside a `Pending` column made the reader do the same
  subtraction the page had already done, and printed `7,875 / 7,875` on every
  order that had simply worked. The cell now says the whole story in the
  fewest characters that can carry it, and the long form is a hover away.
*/
describe('the smart Qty column', () => {
  /** The one order row's Qty cell — td[4] with the cancel column at td[0]. */
  function qtyCell(symbol: string): string {
    // Cancel moved to the END of the row, so Qty is the 4th cell (0-indexed 3).
    return cellsFor(symbol)[3] as string
  }

  test('a partial fill is the fraction: the shortfall is the pending', async () => {
    await mount(IN_SESSION, good({ orders: [ORDER] }))
    expect(qtyCell('NIFTY 26AUG2026 CE 25000')).toBe('5,250 / 7,875')
  })

  test('a filled order is ONE number — 7,875 / 7,875 says nothing twice', async () => {
    await mount(IN_SESSION, good({
      orders: [{ ...ORDER, TradingSymbol: 'ITC 26AUG2026 CE 480',
        OrderStatus: 'Filled', CumulativeQuantity: 7875, LeavesQuantity: 0 }],
    }))
    expect(qtyCell('ITC 26AUG2026 CE 480')).toBe('7,875')
  })

  test('a terminal order that never traded is 0 / 7,875, not a dash', async () => {
    // ZERO IS THE FACT HERE. A rejected order filled nothing, and a dash would
    // read as "unknown" on the one page that exists to be believed.
    await mount(IN_SESSION, good({
      orders: [{ ...ORDER, TradingSymbol: 'DLF 26AUG2026 PE 900',
        OrderStatus: 'Rejected', CumulativeQuantity: 0, LeavesQuantity: 0 }],
    }))
    expect(qtyCell('DLF 26AUG2026 PE 900')).toBe('0 / 7,875')
  })

  test('the long form is on the cell, for the operator who wants the words', async () => {
    await mount(IN_SESSION, good({ orders: [ORDER] }))
    expect(screen.getByTitle('filled 5,250 of 7,875 — 2,625 pending').textContent)
      .toBe('5,250 / 7,875')
  })

  test('a completed order\'s hover says so without inventing a pending', async () => {
    await mount(IN_SESSION, good({
      orders: [{ ...ORDER, TradingSymbol: 'ITC 26AUG2026 CE 480',
        OrderStatus: 'Filled', CumulativeQuantity: 7875, LeavesQuantity: 0 }],
    }))
    screen.getByTitle('filled 7,875 of 7,875')
  })
})

describe('the trades table', () => {
  test('a stamp from another day carries its date', async () => {
    await mount(IN_SESSION, good({ trades: [TRADE] }))
    expect(cellsFor('BANKNIFTY 26AUG2026 PE 55000')).toContain('27 Jul 15:12:04')
  })

  test('the always-zero order price and the always-NRML product are dropped', async () => {
    await mount(IN_SESSION, good({ trades: [TRADE] }))
    expect(screen.queryByText('NRML')).toBe(null)
    const cells = cellsFor('BANKNIFTY 26AUG2026 PE 55000')
    expect(cells).toEqual(['Filled', 'BANKNIFTY 26AUG2026 PE 55000', 'BUY', '105', '3.63', '27 Jul 15:12:04'])
  })

  test('the broker id is gone from here too', async () => {
    await mount(IN_SESSION, good({ trades: [TRADE] }))
    expect(screen.queryByText('Broker ID')).toBe(null)
    expect(screen.queryByText('1240043399')).toBe(null)
  })

  test('the header is just "Qty"; that it is cumulative is said on hover', async () => {
    // `Filled (cum)` spent a third of the column on a parenthesis that only
    // matters once — and the fact still has to be somewhere, because summing
    // this column double-counts every partial.
    await mount(IN_SESSION, good({ trades: [TRADE] }))
    expect(screen.getByRole('columnheader', { name: 'Qty' })).not.toBe(null)
    expect(screen.getByTitle(/cumulative/i).textContent).toBe('105')
  })
})

describe('the positions table', () => {
  test('the net quantity is signed, and carries its lots when the row says the lot size', async () => {
    await mount(IN_SESSION, good({ positions: [POSITION] }))
    expect(cellsFor('SENSEX 26AUG2026 PE 80000')[1]).toBe('-40 (2 lots)')
  })

  test('the sold side reads "qty @ avg"; a side with nothing on it is a dash', async () => {
    await mount(IN_SESSION, good({ positions: [POSITION] }))
    const cells = cellsFor('SENSEX 26AUG2026 PE 80000')
    expect(cells[2]).toBe('40 @ 8.27')
    // No buys at all. `0 @ 0.00` would read as a real trade at a real price.
    expect(cells[3]).toBe('—')
  })

  test('net premium is sold minus bought, signed', async () => {
    await mount(IN_SESSION, good({ positions: [POSITION] }))
    expect(cellsFor('SENSEX 26AUG2026 PE 80000')[4]).toBe('+330.67')
  })

  test('NRML wears no chip — a column of it teaches nothing', async () => {
    await mount(IN_SESSION, good({ positions: [POSITION] }))
    expect(screen.queryByText('NRML')).toBe(null)
  })

  test('MIS DOES, because it squares itself off and the operator must see that', async () => {
    await mount(IN_SESSION, good({
      positions: [POSITION, { ...POSITION, TradingSymbol: 'DLF 26AUG2026 CE 900', ProductType: 'MIS' }],
    }))
    screen.getByText('MIS')
    expect(cellsFor('DLF 26AUG2026 CE 900')[0]).toContain('MIS')
  })

  test('the account, application type, BEP and instrument id are gone', async () => {
    await mount(IN_SESSION, good({ positions: [POSITION] }))
    for (const noise of ['AccountID', 'ApplicationType', 'BEP', 'ExchangeInstrumentId', 'Multiplier']) {
      expect(screen.queryByText(noise)).toBe(null)
    }
    expect(screen.queryByText('PRO111')).toBe(null)
    expect(screen.queryByText('0.00')).toBe(null)
  })
})

/*
  THE ORDER THE POSITIONS ARE READ IN, AND THE FIGURE UNDER THEM.

  XTS answers in whatever order its book happens to hold, so eighteen legs of
  four underlyings arrived interleaved and the operator did the grouping by eye.
  The sort is COSMETIC ONLY: it is derived from the broker's own symbol string,
  it never rewrites what is displayed, and a symbol this file cannot parse is
  moved rather than dropped.
*/

/** A position in `sym`, otherwise the real SENSEX row's numbers. */
function pos(sym: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return { ...POSITION, TradingSymbol: sym, ...over }
}

/** Every position row's Symbol cell in render order, the Total row dropped. */
function positionOrder(): string[] {
  const rows = [...document.querySelectorAll('tbody tr')]
  return rows.slice(0, -1).map((r) => r.querySelector('td')?.textContent ?? '')
}

/** The Total row's cells — it is always the last body row. */
function totalCells(): string[] {
  const rows = [...document.querySelectorAll('tbody tr')]
  const last = rows[rows.length - 1] as HTMLElement
  return [...last.querySelectorAll('td')].map((td) => td.textContent ?? '')
}

describe('the positions are put in a readable order', () => {
  test('grouped by underlying, then expiry, then strike, then CE before PE', async () => {
    await mount(IN_SESSION, good({
      positions: [
        pos('TCS 26AUG2026 CE 3200'),
        pos('DLF 24SEP2026 CE 900'),
        pos('BHEL 26AUG2026 PE 240'),
        pos('DLF 26AUG2026 PE 900'),
        pos('DLF 26AUG2026 CE 1000'),
        pos('DLF 26AUG2026 CE 900'),
        pos('DLF 26AUG2026 CE 880'),
      ],
    }))
    // 880 < 900 < 1000 is the STRIKE read as a number; sorted as text the
    // thousand would lead the column. The right is the LAST key, so the two
    // legs of one strike sit together — which is how a straddle is read.
    expect(positionOrder()).toEqual([
      'BHEL 26AUG2026 PE 240',
      'DLF 26AUG2026 CE 880',
      'DLF 26AUG2026 CE 900',
      'DLF 26AUG2026 PE 900',
      'DLF 26AUG2026 CE 1000',
      'DLF 24SEP2026 CE 900',
      'TCS 26AUG2026 CE 3200',
    ])
  })

  test('a symbol this file cannot read sorts last, in arrival order, and still renders', async () => {
    // SORTING IS NEVER ALLOWED TO LOSE A ROW. A future or a spelling nobody
    // anticipated goes to the end of the table, not out of it.
    await mount(IN_SESSION, good({
      positions: [pos('NIFTY-I FUT'), pos('TCS 26AUG2026 CE 3200'), pos('GOLD24DECFUT')],
    }))
    expect(positionOrder()).toEqual(['TCS 26AUG2026 CE 3200', 'NIFTY-I FUT', 'GOLD24DECFUT'])
  })

  test('the displayed symbol is still the broker\'s own spelling', async () => {
    await mount(IN_SESSION, good({ positions: [pos('DLF 26AUG2026 CE 900')] }))
    screen.getByText('DLF 26AUG2026 CE 900')
  })
})

describe('the positions total', () => {
  test('sums the net premium under the column that produced it, and counts the rows', async () => {
    await mount(IN_SESSION, good({
      positions: [pos('TCS 26AUG2026 CE 3200'), pos('BHEL 26AUG2026 PE 240')],
    }))
    const cells = totalCells()
    expect(cells[0]).toBe('Total2 positions')
    expect(cells[4]).toBe('+661.33')
  })

  test('one un-nettable row makes the total unknown, not a confident undercount', async () => {
    // The same rule every other total on this desk obeys: a sum over the rows
    // that DID net is a confident number understated by an unknown amount.
    await mount(IN_SESSION, good({
      positions: [
        pos('TCS 26AUG2026 CE 3200'),
        pos('BHEL 26AUG2026 PE 240', { SellAmount: '', ActualSellAmount: '' }),
      ],
    }))
    expect(totalCells()[4]).toBe('—')
  })

  test('there is no Total under an empty book', async () => {
    await mount(IN_SESSION, good({ positions: [] }))
    expect(screen.queryByText('Total')).toBe(null)
  })
})

describe('the columns line up', () => {
  test('a numeric header sits right-aligned over its right-aligned cells', async () => {
    await mount(IN_SESSION, good({ positions: [POSITION] }))
    expect(screen.getByRole('columnheader', { name: 'Net premium' }).style.textAlign).toBe('end')
    // Text stays left, header and cell alike — the alignment is the column's,
    // not the table's.
    expect(screen.getByRole('columnheader', { name: 'Symbol' }).style.textAlign).toBe('')
    const tds = [...(screen.getAllByRole('row')
      .find((r) => (r.textContent ?? '').includes('SENSEX')) as HTMLElement)
      .querySelectorAll('td')]
    expect((tds[4] as HTMLElement).style.textAlign).toBe('end')
    expect((tds[0] as HTMLElement).style.textAlign).toBe('')
  })

})

/*
  THE VOID BETWEEN SYMBOL AND THE NUMBERS.

  Symbol was the only flexible column on the positions table, so every pixel
  the 58% grid column had spare went into ONE gap: a hand's width of nothing
  between `SENSEX 26AUG2026 PE 80000` and `Net qty`, with the four numeric
  columns huddled against the right edge. Spare width is not a column's to
  hoard — it belongs to all of them, in small even shares.
*/
describe('the positions columns share the spare width', () => {
  test('Symbol is a modest fixed width, not the sponge', async () => {
    await mount(IN_SESSION, good({ positions: [POSITION] }))
    expect(screen.getByRole('columnheader', { name: 'Symbol' }).style.width).toMatch(/px$/)
  })

  test('the four numeric columns are the flexible ones, and share equally', async () => {
    await mount(IN_SESSION, good({ positions: [POSITION] }))
    const widths = ['Net qty', 'Sold', 'Bought', 'Net premium'].map(
      (name) => screen.getByRole('columnheader', { name }).style.width,
    )
    for (const w of widths) expect(w).toMatch(/%$/)
    // Equal shares: the spare arrives as four small gaps rather than one void.
    expect(new Set(widths).size).toBe(1)
  })

  test('NO COLUMN IS THE SOLE PROPORTIONAL ONE — that is what made the void', async () => {
    await mount(IN_SESSION, good({ positions: [POSITION] }))
    const flexible = [...document.querySelectorAll('thead th')]
      .filter((th) => (th as HTMLElement).style.width.endsWith('%'))
    expect(flexible.length).toBeGreaterThan(1)
  })
})

/*
  ORDERS AND TRADES FIT, WHICH IS A SUM AND NOT AN OPINION.

  The design system sets the `<table>`'s `min-width` from the column
  definitions (`resolveColumnWidths`): pixel widths add up, and a proportional
  column contributes its `minWidth` scaled by its share. Below that width the
  wrapper scrolls — which is exactly the failure the operator screenshotted.
  So the test is the arithmetic: the sum has to fit the column the table is
  put in.

  THE ROOM, AT THE 1440px THE DESK IS READ ON: 1440 − 32 (the page's own
  `padding={4}`) = 1408; less the 12px grid gap = 1396 of track; the side
  column is 45% of that = 628; less the card's 16px each side = 596.
  Positions takes the 55%: 768 − 32 = 736.
*/
describe('the side tables fit their column instead of scrolling', () => {
  /** 45% of a 1440px viewport, less the page padding, the gap and the card. */
  const SIDE_PX = 678  // 710 track − 2×16 card padding
  /** The same sum for the 55% column. */
  const POSITIONS_PX = 686  // 1440 − 32 page − 12 gap − 710 track − 32 card

  function minWidthOf(t: HTMLElement): number {
    return Number.parseFloat(t.style.minWidth)
  }

  test('the summed column widths fit the column the table sits in', async () => {
    await mount(IN_SESSION, good({ orders: [ORDER], trades: [TRADE], positions: [POSITION] }))
    const tables = [...document.querySelectorAll('table')] as HTMLElement[]
    // DOM order is the page's: positions, then orders, then trades.
    expect(tables).toHaveLength(3)
    expect(minWidthOf(tables[0] as HTMLElement)).toBeLessThanOrEqual(POSITIONS_PX)
    expect(minWidthOf(tables[1] as HTMLElement)).toBeLessThanOrEqual(SIDE_PX)
    expect(minWidthOf(tables[2] as HTMLElement)).toBeLessThanOrEqual(SIDE_PX)
  })

  test('the grid split is the one that arithmetic assumes', () => {
    // The fit above is only true of a 45% side column; a page that quietly went
    // back to 42% would scroll again with every test still green.
    const css = readFileSync(resolve(process.cwd(), 'src/comfort.css'), 'utf8')
    expect(css).toContain('minmax(0, 1fr) 710px')
  })
})

describe('the page is two columns on a wide screen', () => {
  test('positions lead the DOM; orders and trades stack beside them', async () => {
    await mount(IN_SESSION, good({ orders: [ORDER], trades: [TRADE], positions: [POSITION] }))
    const grid = document.querySelector('.broker-grid') as HTMLElement
    expect(grid).not.toBe(null)
    const children = [...grid.children] as HTMLElement[]
    const left = children[0] as HTMLElement
    const right = children[1] as HTMLElement
    // DOM ORDER IS THE NARROW-VIEWPORT ORDER. The grid places the columns on a
    // wide screen; it never reorders this markup, so the collapse — and a
    // screen reader — both get Positions → Orders → Trades.
    expect((left as HTMLElement).className).toContain('broker-grid-positions')
    within(left).getByRole('heading', { level: 3, name: 'Positions' })
    expect((right as HTMLElement).className).toContain('broker-grid-side')
    expect(within(right).getAllByRole('heading', { level: 3 }).map((h) => h.textContent))
      .toEqual(['Orders', 'Trades'])
    expect(screen.getAllByRole('heading', { level: 3 }).map((h) => h.textContent))
      .toEqual(['Positions', 'Orders', 'Trades'])
  })

  test('the split happens at the desk\'s own wide breakpoint, not a new one', async () => {
    // ONE BREAKPOINT SCALE, USED EVERYWHERE — see responsive.css. The strategy
    // page's two-column layout is >= 1200px and this one has no reason to
    // disagree with it.
    const css = readFileSync(resolve(process.cwd(), 'src/comfort.css'), 'utf8')
    const at = css.indexOf('.broker-grid-positions')
    expect(at).toBeGreaterThan(-1)
    const before = css.slice(0, at)
    expect(before.slice(before.lastIndexOf('@media'), at)).toContain('(min-width: 1200px)')
  })
})

describe('a timestamp nobody can parse', () => {
  test('is printed as the broker sent it, not swallowed', async () => {
    // The broker's own words are the fallback everywhere on this page. A format
    // this does not know is a reason to show it, not to hide it.
    await mount(IN_SESSION, good({ orders: [{ ...ORDER, OrderGeneratedDateTime: '/Date(1785)/' }] }))
    expect(cellsFor('NIFTY 26AUG2026 CE 25000')).toContain('/Date(1785)/')
  })
})

/**
 * THE COLUMNS HAVE TO BE THE SAME OBJECTS BETWEEN POLLS.
 *
 * The design system's table memoizes each row and re-renders it when — among
 * other things — the `columns` array it was given stops being shallow-equal to
 * the last one. This page rebuilt every column, and every `renderCell` closure
 * inside it, on each render; the 15s poll therefore re-rendered every cell of
 * an eighteen-leg book plus both side tables, forever, for a snapshot in which
 * nothing had usually changed. (The row memo compares row VALUES, so identical
 * data would otherwise cost nothing.)
 *
 * The positions columns are built once at module scope; the order and trade
 * columns depend only on the IST day the Time cells date their rows against,
 * so they are memoised on it and rebuilt exactly when it rolls over.
 */
describe('the table columns survive a poll', () => {
  const CANCEL = (): void => {}
  const NONE_CANCELLING: ReadonlySet<string> = new Set()

  test('the same day yields the SAME column objects', () => {
    const { result, rerender } = renderHook(
      ({ day }: { day: string }) => useBrokerColumns(day, CANCEL, NONE_CANCELLING),
      { initialProps: { day: '2026-08-16' } },
    )
    const first = result.current
    rerender({ day: '2026-08-16' })
    expect(result.current.orders).toBe(first.orders)
    expect(result.current.trades).toBe(first.trades)
  })

  test('a new IST day rebuilds them, because the Time cells date against it', () => {
    const { result, rerender } = renderHook(
      ({ day }: { day: string }) => useBrokerColumns(day, CANCEL, NONE_CANCELLING),
      { initialProps: { day: '2026-08-16' } },
    )
    const first = result.current
    rerender({ day: '2026-08-17' })
    expect(result.current.orders).not.toBe(first.orders)
    expect(result.current.trades).not.toBe(first.trades)
  })

  test('the positions columns are one object for the life of the module', () => {
    // Nothing about them varies per render, so they are not a hook at all —
    // and this is the curated set, already mapped into the design system's
    // shape rather than mapped again on every poll.
    expect(POSITION_TABLE_COLUMNS.map((c) => c.key)).toEqual(
      ['symbol', 'qty', 'sold', 'bought', 'premium'],
    )
  })
})
