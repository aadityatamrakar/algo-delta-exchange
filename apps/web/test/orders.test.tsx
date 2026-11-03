/**
 * The per-strategy order log, which could not show a fill.
 *
 * `?tag=` is an exact match on the stored event, and the gateway writes its
 * `STATUS` events — the ONLY phase carrying `status`, `filledQty` and
 * `avgPrice` — with `tag: ''`. So a server-side tag filter structurally
 * excluded every fill and every rejection from a per-strategy view, leaving a
 * log that could only ever say "submitted". This is the correlation that fixes
 * it, and the reason it is worth a test of its own is that the bug was
 * invisible: the panel rendered, it just never contained the interesting row.
 */
import { expect, test, describe } from 'vitest'
import {
  api, eventsForTag, groupOrders, localDayTime, localTime, orderDetail, smoothSeries, spansDays,
  type OrderEvent, type PnlPoint,
} from '../src/api.ts'
import { installFetch } from './http.tsx'

const at = (over: Partial<OrderEvent>): OrderEvent => ({
  clientOrderId: 'X-1', phase: 'ACK', ok: true, tag: 'ORB_SCALP_BN',
  tradingsymbol: 'BANKNIFTY24JUL52000CE', ts: 1, ...over,
})

describe('correlating a strategy to its fills', () => {
  test('an untagged STATUS event is claimed by the order it belongs to', () => {
    const events = [
      at({ clientOrderId: 'X-1', phase: 'SUBMITTED' }),
      at({ clientOrderId: 'X-1', phase: 'STATUS', tag: '', status: 'FILLED', filledQty: 25, avgPrice: 131.5 }),
      at({ clientOrderId: 'Y-9', phase: 'SUBMITTED', tag: 'ATR_BAND_NIFTY' }),
      at({ clientOrderId: 'Y-9', phase: 'STATUS', tag: '', status: 'FILLED' }),
    ]
    const mine = eventsForTag(events, 'ORB_SCALP_BN')
    expect(mine.map((e) => e.phase)).toEqual(['SUBMITTED', 'STATUS'])
    // And emphatically NOT the other strategy's fill.
    expect(mine.every((e) => e.clientOrderId === 'X-1')).toBe(true)
  })

  test('a sliced order is matched on its base id', () => {
    // The gateway splits a large order into `<id>.1`, `<id>.2` — but PLANNED
    // keeps the base id, so an exact match would drop the slices' own events.
    const events = [
      at({ clientOrderId: 'X-1', phase: 'PLANNED' }),
      at({ clientOrderId: 'X-1.2', phase: 'STATUS', tag: '', status: 'FILLED' }),
    ]
    expect(eventsForTag(events, 'ORB_SCALP_BN')).toHaveLength(2)
  })

  test('a base id with dots of its own is cut only at the numeric tranche suffix', () => {
    // Hosted strategies name orders `atr.v2-171#3`; the gateway's tranche
    // suffix is the LAST `.N` (gateway.ts `baseClientOrderId`). Cutting at the
    // first dot grouped every `atr.*` order under `atr` — so another order's
    // untagged fill was claimed by this strategy, and its own tranche still
    // matched only by accident.
    const events = [
      at({ clientOrderId: 'atr.v2-171#3', phase: 'SUBMITTED' }),
      at({ clientOrderId: 'atr.v2-171#3.2', phase: 'STATUS', tag: '', status: 'FILLED' }),
      at({ clientOrderId: 'atr.v2-172#1', phase: 'STATUS', tag: '', status: 'FILLED' }),
    ]
    const mine = eventsForTag(events, 'ORB_SCALP_BN')
    expect(mine.map((e) => e.clientOrderId)).toEqual(['atr.v2-171#3', 'atr.v2-171#3.2'])
  })

  test('an untagged event belonging to nothing we asked about is not adopted', () => {
    const events = [at({ clientOrderId: 'Z-3', phase: 'STATUS', tag: '' })]
    expect(eventsForTag(events, 'ORB_SCALP_BN')).toHaveLength(0)
  })

  test('the tag filter is applied here, not by the server', async () => {
    const sent = installFetch(() => ({
      body: {
        date: '2026-07-27',
        events: [
          at({ clientOrderId: 'X-1', phase: 'SUBMITTED' }),
          at({ clientOrderId: 'X-1', phase: 'STATUS', tag: '', status: 'FILLED', filledQty: 25 }),
          at({ clientOrderId: 'Q-1', phase: 'SUBMITTED', tag: 'OTHER' }),
        ],
      },
    }))

    const r = await api.reportOrders('2026-07-27', 'live', 'ORB_SCALP_BN')

    // The request carries NO `tag`: asking the server to filter is what made
    // the fill unreachable.
    expect(sent[0]?.url).not.toContain('tag=')
    // It DOES carry the mode: the log is per-rail, and unscoped it fed paper
    // refusals to a live view and showed a paper session nothing at all.
    expect(sent[0]?.url).toContain('mode=live')
    expect(r.events).toHaveLength(2)
    expect(r.events.some((e) => e.status === 'FILLED')).toBe(true)
  })

  test('a book asks for its whole life; a strategy asks for the day', async () => {
    const reply = { body: { date: '2026-08-03', events: [] } }

    const book = installFetch(() => reply)
    await api.reportOrders('2026-08-03', 'paper', 'BHEL-2026-08-25-recenter-r-2', false, '2026-07-10')
    // A positional book is held for weeks: bounded to today, its own opening
    // trade is the one row the log can never show.
    expect(book[0]?.url).toContain('from=2026-07-10')
    expect(book[0]?.url).toContain('date=2026-08-03')

    const intraday = installFetch(() => reply)
    await api.reportOrders('2026-08-03', 'paper', 'ORB_SCALP_BN')
    // UNCHANGED for everything that is not a book — a hosted strategy is
    // intraday by contract and one day is its whole history.
    expect(intraday[0]?.url).not.toContain('from=')

    const sameDay = installFetch(() => reply)
    await api.reportOrders('2026-08-03', 'paper', 'ORB_SCALP_BN', false, '2026-08-03')
    // A window of exactly one day is the default, said differently. Sending it
    // would make two requests for the same rows look like two windows.
    expect(sameDay[0]?.url).not.toContain('from=')
  })

  test('a fill reads as a fill', () => {
    expect(orderDetail(at({ phase: 'STATUS', tag: '', status: 'FILLED', filledQty: 25, avgPrice: 131.5 })))
      .toBe('FILLED filled 25 @131.5')
    // The broker's own sentence wins on a failure: a status beside it dilutes it.
    expect(orderDetail(at({ ok: false, error: 'RMS: margin shortfall', status: 'REJECTED' })))
      .toBe('RMS: margin shortfall')
    expect(orderDetail(at({ phase: 'PLANNED' }))).toBe('—')
  })
})

/**
 * A LOG THAT SPANS DAYS HAS TO SAY WHICH DAY.
 *
 * `10:42:15` names no moment in a positional book's journal — three weeks of
 * entries all read as this morning, and an operator reconciling a roll cannot
 * tell Tuesday's exit from Friday's. The day is spent only where there is an
 * ambiguity to spend it on, so these assert BOTH directions.
 *
 * TIMEZONE-AGNOSTIC ON PURPOSE: these render in the reader's clock (see
 * `localTime`), so the stamps are days apart rather than hours and the shape is
 * asserted, not a particular string on a particular laptop.
 */
describe('stamping a log that runs over more than one day', () => {
  const DAY = 24 * 60 * 60_000
  const NOON = Date.parse('2026-07-29T06:30:00Z')

  test('one day of entries is left as a bare clock', () => {
    expect(spansDays([NOON, NOON + 60_000, NOON + 3 * 3600_000])).toBe(false)
    // And an empty log has nothing to disambiguate — the column must not
    // widen while the first read is still in flight.
    expect(spansDays([])).toBe(false)
  })

  test('two days of entries are stamped, however few', () => {
    expect(spansDays([NOON, NOON + DAY])).toBe(true)
    // Order does not matter: the log is newest-first and the extremes are what
    // decide, not the first two rows.
    expect(spansDays([NOON + 3 * DAY, NOON, NOON + DAY])).toBe(true)
  })

  test('the stamp carries the day in front of the same clock, unchanged', () => {
    const stamped = localDayTime(NOON)
    expect(stamped).toMatch(/^\d{2} [A-Za-z]{3} \d{2}:\d{2}:\d{2}$/)
    // The clock half is `localTime` itself: one row must not render its time
    // one way in this log and another way in the next.
    expect(stamped.endsWith(localTime(NOON))).toBe(true)
  })
})

/**
 * COLLAPSING THE LOG TO ONE ROW PER ORDER.
 *
 * The journal is per-PHASE and per-TRANCHE, so one 3-lot BHEL order occupied
 * eleven rows — PLANNED, SUBMITTED, PENDING_NEW, then a progressive
 * PARTIALLY_FILLED for every step of the fill, each one repeated under a second
 * contract spelling because the broker echoes its own symbol
 * (`BHEL 25AUG2026 PE 410`) while the routing events carry the Kite packing
 * (`BHEL26AUG410PE`). Reading "what actually traded" off that meant counting.
 *
 * THE ARITHMETIC IS THE PART WORTH TESTING. `filledQty` on a STATUS event is
 * CUMULATIVE for its tranche, not incremental, so summing every event
 * multiply-counts every partial — a 3-lot order reads as 6 lots. The grouping
 * therefore takes the FURTHEST-PROGRESSED event per tranche and sums those.
 */
describe('one row per order', () => {
  const filled = (id: string, qty: number, price: number, status = 'PARTIALLY_FILLED') =>
    at({ clientOrderId: id, phase: 'STATUS', tag: '', status, filledQty: qty, avgPrice: price })

  test('a progressively-filled order is ONE row carrying the final quantity', () => {
    const [g, ...rest] = groupOrders([
      at({ clientOrderId: 'B-1', phase: 'PLANNED' }),
      at({ clientOrderId: 'B-1', phase: 'SUBMITTED' }),
      filled('B-1', 2625, 3.65),
      filled('B-1', 5250, 3.65),
      filled('B-1', 7875, 3.63, 'FILLED'),
    ])
    expect(rest).toHaveLength(0)
    // 7875, NOT 2625+5250+7875. The cumulative-vs-incremental trap.
    expect(g?.filledQty).toBe(7875)
    expect(g?.status).toBe('FILLED')
    expect(g?.events).toHaveLength(5)
  })

  test('freeze-split tranches SUM, because each is a separate broker order', () => {
    const g = groupOrders([
      at({ clientOrderId: 'B-1', phase: 'PLANNED' }),
      filled('B-1.1', 1800, 100, 'FILLED'),
      filled('B-1.2', 450, 130, 'FILLED'),
    ])[0]
    expect(g?.filledQty).toBe(2250)
    // (1800*100 + 450*130) / 2250 = 106 — the weighted average, not the last
    // tranche's 130, which is Rs.54,000 wrong on one NIFTY order.
    expect(g?.avgPrice).toBe(106)
  })

  test('the two contract spellings collapse into one row', () => {
    // The broker echoes its own symbol on STATUS while the routing events carry
    // the Kite packing. Both share the order id, which is what merges them.
    const rows = groupOrders([
      at({ clientOrderId: 'B-1', phase: 'SUBMITTED', tradingsymbol: 'BHEL26AUG410PE' }),
      at({ clientOrderId: 'B-1', phase: 'STATUS', tag: '', tradingsymbol: 'BHEL 25AUG2026 PE 410',
           status: 'FILLED', filledQty: 2625, avgPrice: 3.65 }),
    ])
    expect(rows).toHaveLength(1)
    // The KITE packing wins: it is the one `formatContract` can shorten to
    // `BHEL 410 PE`, and it is the symbol the rest of the desk keys on.
    expect(rows[0]?.tradingsymbol).toBe('BHEL26AUG410PE')
  })

  test('a PLANNED row carrying a warning leaves the order OK and FILLED, and the warning rides the group', () => {
    /**
     * The gateway's freeze-unknown caveat (spec D5). It used to arrive as a
     * SECOND PLANNED row, `ok: false`, and `failure` below painted every such
     * order REJECTED — 34/34 SENSEX paper orders on 2026-09-16/17, all
     * filled. It now arrives as `warning` on the one OK row, and a warning
     * is a note on a success: `ok`, `status` and `error` are exactly what
     * they would be without it.
     */
    const g = groupOrders([
      at({ clientOrderId: 'W-1', phase: 'PLANNED',
           warning: "no freeze limit for underlying 'SENSEX' (source: master, exchange: BFO) — sending 9 lots as ONE order" }),
      filled('W-1', 20, 134.95, 'FILLED'),
    ])[0]
    expect(g?.ok).toBe(true)
    expect(g?.status).toBe('FILLED')
    expect(g?.error).toBeUndefined()
    expect(g?.warning).toMatch(/no freeze limit/)
  })

  test('a group with no warning has none', () => {
    const g = groupOrders([
      at({ clientOrderId: 'B-1', phase: 'PLANNED' }),
      filled('B-1', 7875, 3.63, 'FILLED'),
    ])[0]
    expect(g?.warning).toBeUndefined()
  })

  test('a REJECTION survives collapsing and marks the whole order not-ok', () => {
    const g = groupOrders([
      at({ clientOrderId: 'R-1', phase: 'SUBMITTED' }),
      at({ clientOrderId: 'R-1', phase: 'STATUS', tag: '', ok: false,
           status: 'REJECTED', error: 'RMS: margin' }),
    ])[0]
    expect(g?.ok).toBe(false)
    expect(g?.error).toBe('RMS: margin')
  })

  test('a partly-rejected split order reports what DID fill, and is not ok', () => {
    // 24 lots are live at the broker and one tranche was refused. Reporting
    // either "FILLED" or "REJECTED" alone is a lie about real exposure.
    const g = groupOrders([
      filled('S-1.1', 1800, 100, 'FILLED'),
      at({ clientOrderId: 'S-1.2', phase: 'STATUS', tag: '', ok: false,
           status: 'REJECTED', error: 'RMS: margin', filledQty: 0 }),
    ])[0]
    expect(g?.ok).toBe(false)
    expect(g?.filledQty).toBe(1800)
  })

  test('an order that never filled reports no quantity and no price', () => {
    const g = groupOrders([
      at({ clientOrderId: 'P-1', phase: 'PLANNED' }),
      at({ clientOrderId: 'P-1', phase: 'SUBMITTED' }),
    ])[0]
    expect(g?.filledQty).toBe(0)
    // Null, never 0 — a price of zero is a claim about a fill that never
    // happened, which is the rule the whole nullable field exists for.
    expect(g?.avgPrice).toBe(null)
    expect(g?.status).toBe('SUBMITTED')
  })

  test('orders come back newest first, by their latest event', () => {
    const rows = groupOrders([
      at({ clientOrderId: 'OLD', phase: 'SUBMITTED', ts: 100 }),
      at({ clientOrderId: 'NEW', phase: 'SUBMITTED', ts: 900 }),
      at({ clientOrderId: 'OLD', phase: 'STATUS', tag: '', ts: 200, status: 'FILLED' }),
    ])
    expect(rows.map((r) => r.id)).toEqual(['NEW', 'OLD'])
  })

  test('every original event is kept, newest first, for the detail view', () => {
    const g = groupOrders([
      at({ clientOrderId: 'B-1', phase: 'PLANNED', ts: 1 }),
      at({ clientOrderId: 'B-1', phase: 'STATUS', tag: '', ts: 3, status: 'FILLED' }),
      at({ clientOrderId: 'B-1', phase: 'SUBMITTED', ts: 2 }),
    ])[0]
    expect(g?.events.map((e) => e.phase)).toEqual(['STATUS', 'SUBMITTED', 'PLANNED'])
  })

  /**
   * A HALT IS NOT A FILL, and the rank is what says so when nothing on the
   * order is flagged as a failure.
   *
   * A tranched order the gateway stopped journals the halt under the BASE id
   * while the slices that DID trade journal COMPLETE under their own. `HALTED`
   * was absent from `STATUS_RANK` — rank -1, below `PLANNED` — so the
   * furthest-progressed status on the order was the tranche's COMPLETE, and the
   * one row an operator reads said the order was done.
   */
  test('a HALTED order does not report itself FILLED because a tranche filled', () => {
    const g = groupOrders([
      filled('H-1.1', 1800, 100, 'COMPLETE'),
      // `ok` left true on purpose: this pins the RANK, not the failure branch.
      at({ clientOrderId: 'H-1', phase: 'STATUS', tag: '', status: 'HALTED', filledQty: 1800 }),
    ])[0]
    expect(g?.status).toBe('HALTED')
    // What DID trade is still reported — the position is real.
    expect(g?.filledQty).toBe(1800)
  })

  test('a REJECTED order outranks the halt: nothing traded and the broker said no', () => {
    const g = groupOrders([
      at({ clientOrderId: 'X-1', phase: 'STATUS', tag: '', status: 'HALTED' }),
      at({ clientOrderId: 'X-1', phase: 'STATUS', tag: '', status: 'REJECTED' }),
    ])[0]
    expect(g?.status).toBe('REJECTED')
  })

  test('an empty log groups to nothing rather than throwing', () => {
    expect(groupOrders([])).toEqual([])
  })
})

/**
 * THE AGGREGATE ROW, which is not a tranche.
 *
 * `FillWatcher.reconcile` journals a FINAL status carrying the whole order's
 * `filledQty` and quantity-weighted `avgPrice`, under the BASE id — while each
 * tranche has already journalled its own progress under `<base>.N`. Treating
 * that summary as one more tranche and adding it in DOUBLES a split order.
 *
 * It only bites when an order was actually split, which is why it survived the
 * first pass: on an unsplit order the tranche id IS the base id, so the two
 * collapse onto each other and the max is right by accident.
 */
describe('the aggregate row is a summary, not a tranche', () => {
  test('a SPLIT order reports the aggregate, not aggregate + tranches', () => {
    const g = groupOrders([
      at({ clientOrderId: 'X-1', phase: 'PLANNED' }),
      at({ clientOrderId: 'X-1.1', phase: 'STATUS', tag: '', status: 'FILLED', filledQty: 1800, avgPrice: 100 }),
      at({ clientOrderId: 'X-1.2', phase: 'STATUS', tag: '', status: 'FILLED', filledQty: 450, avgPrice: 130 }),
      // `reconcile`'s summary, under the BASE id.
      at({ clientOrderId: 'X-1', phase: 'STATUS', tag: '', status: 'FILLED', filledQty: 2250, avgPrice: 106 }),
    ])[0]
    expect(g?.filledQty).toBe(2250)
    expect(g?.avgPrice).toBe(106)
  })

  test('a split order with NO summary yet still sums its tranches', () => {
    // The summary is only written once the order resolves, so a partly-filled
    // split order has tranches and nothing else. It must still report.
    const g = groupOrders([
      at({ clientOrderId: 'X-1', phase: 'PLANNED' }),
      at({ clientOrderId: 'X-1.1', phase: 'STATUS', tag: '', status: 'FILLED', filledQty: 1800, avgPrice: 100 }),
      at({ clientOrderId: 'X-1.2', phase: 'STATUS', tag: '', status: 'PARTIALLY_FILLED', filledQty: 225, avgPrice: 130 }),
    ])[0]
    expect(g?.filledQty).toBe(2025)
  })

  test('an UNSPLIT order is unaffected — its tranche id IS the base id', () => {
    const g = groupOrders([
      at({ clientOrderId: 'B-1', phase: 'STATUS', tag: '', status: 'PARTIALLY_FILLED', filledQty: 2625, avgPrice: 3.65 }),
      at({ clientOrderId: 'B-1', phase: 'STATUS', tag: '', status: 'FILLED', filledQty: 7875, avgPrice: 3.63 }),
      // The summary, same id — and the observed prod duplication besides.
      at({ clientOrderId: 'B-1', phase: 'STATUS', tag: '', status: 'FILLED', filledQty: 7875, avgPrice: 3.63 }),
    ])[0]
    expect(g?.filledQty).toBe(7875)
  })
})

/**
 * SMOOTHING THE INTRADAY P&L LINE.
 *
 * Snapshots land every ~15s, so a session is ~1,500 points in a few hundred
 * pixels — a band of vertical hair that hides the shape it is drawn to show.
 */
describe('smoothing the P&L series', () => {
  const pt = (ts: number, total: number | null): PnlPoint => ({
    ts, realised: 0, unrealised: total, total,
  })
  /** `n` points a quarter-minute apart, as the snapshot job writes them. */
  const series = (n: number, at: (i: number) => number | null): PnlPoint[] =>
    Array.from({ length: n }, (_, i) => pt(i * 15_000, at(i)))

  test('a minute of marks becomes one point at their mean', () => {
    // 4 points per minute at 10/20/30/40 -> 25.
    const out = smoothSeries(series(200, (i) => (i % 4) * 10 + 10), 60_000, 10)
    expect(out[0]?.total).toBe(25)
    // 200 quarter-minutes is 50 minutes.
    expect(out.length).toBe(50)
  })

  test('the LAST point is passed through un-averaged', () => {
    // The chart's right-hand end has to equal the MTM tile beside it; a
    // smoothed final value would make the two disagree and neither checkable.
    const pts = series(200, (i) => i)
    const out = smoothSeries(pts, 60_000, 10)
    expect(out[out.length - 1]).toEqual(pts[pts.length - 1])
  })

  test('a bucket containing an unmarked snapshot yields null, never an average', () => {
    // Null means the book could not be marked. Averaging across it draws a
    // confident line through a period we have no record of.
    const out = smoothSeries(series(200, (i) => (i === 2 ? null : 100)), 60_000, 10)
    expect(out[0]?.total).toBe(null)
    expect(out[1]?.total).toBe(100)
  })

  test('a short series is returned UNCHANGED rather than reduced to dots', () => {
    const pts = series(20, (i) => i)
    expect(smoothSeries(pts, 60_000, 120)).toEqual(pts)
  })

  test('an empty series stays empty', () => {
    expect(smoothSeries([], 60_000, 0)).toEqual([])
  })

  test('a bucket is stamped at its LAST mark, never mid-bucket', () => {
    // A mid-bucket stamp would put the newest point in the future relative to
    // the clock the axis is labelled with.
    const out = smoothSeries(series(200, () => 5), 60_000, 10)
    expect(out[0]?.ts).toBe(45_000)
  })
})
