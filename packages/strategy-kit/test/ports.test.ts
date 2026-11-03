/**
 * The `MarketData` port surface a strategy can actually reach.
 *
 * Both fixes here are about REACHABILITY rather than logic. `selector.ts` was
 * fully implemented and fully tested and had zero callers, because it was not on
 * the port — a selector no strategy can call is a selector that does not exist,
 * and the thing it was built to replace (`otmSelector`, returning a plausible `0`
 * at 87 of 93 call sites) stayed in service. `DataNeed` likewise could not say
 * which bar size a strategy wanted, so the host hardcoded a guess.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  StrategyBase,
  makeTestContext,
  DEFAULT_TEST_EXPIRY,
  type DataNeed,
  type JobSpec,
  type Quote,
  type Selection,
  type StrategyContext,
} from '../src/index.ts'

const NIFTY_SPOT = 256265
const EXPIRY = DEFAULT_TEST_EXPIRY

/** token, strike, type — kept together so the marks and the chain cannot drift. */
const LEGS = [
  { strike: 24_900, type: 'CE', token: 9001, mark: 120 },
  { strike: 24_950, type: 'CE', token: 9002, mark: 90 },
  { strike: 25_000, type: 'CE', token: 9003, mark: 60 },
  { strike: 25_050, type: 'CE', token: 9004, mark: 38 },
  { strike: 25_100, type: 'CE', token: 9005, mark: 22 },
  { strike: 24_900, type: 'PE', token: 9101, mark: 30 },
  { strike: 24_950, type: 'PE', token: 9102, mark: 48 },
  { strike: 25_000, type: 'PE', token: 9103, mark: 70 },
  { strike: 25_050, type: 'PE', token: 9104, mark: 98 },
  // NOTE: no 25_100 PE. Real chains are asymmetric, and fabricating the missing
  // leg from underlying+strike+type is exactly how the C4 phantom order happened.
] as const

/** Build a fixture whose chain is a REAL listed grid, gaps and all. */
function chainFixture(opts: { withMarks: boolean; spot?: number }): ReturnType<typeof makeTestContext> {
  const parts = makeTestContext()
  parts.md.setUnderlying('NIFTY', NIFTY_SPOT, 50)
  parts.md.setQuote({ token: NIFTY_SPOT, lastPrice: opts.spot ?? 24_980, ts: 1 })
  for (const leg of LEGS) {
    parts.md.setOption(
      'NIFTY',
      leg.strike,
      leg.type,
      {
        tradingsymbol: `NIFTY${leg.strike}${leg.type}`,
        instrumentToken: leg.token,
        lotSize: 75,
        tickSize: 0.05,
        exchange: 'NFO',
      },
      EXPIRY,
    )
    if (opts.withMarks) parts.md.setQuote({ token: leg.token, lastPrice: leg.mark, ts: 1 })
  }
  return parts
}

// --- K4: selectOption is on the port ----------------------------------------

test('selectOption is reachable through ctx.md and picks the nearest LISTED strike', () => {
  const parts = chainFixture({ withMarks: true })
  const sel = parts.ctx.md.selectOption('NIFTY', EXPIRY, { by: 'atm', type: 'CE' })
  assert.notEqual(sel, null)
  assert.equal(sel?.strike, 25_000, '24980 is 20 from 25000 and 30 from 24950')
  assert.equal(sel?.instrument.tradingsymbol, 'NIFTY25000CE')
})

test('offset counts LISTED strikes, so a gap is stepped over rather than fallen into', () => {
  const parts = chainFixture({ withMarks: true })
  const up = parts.ctx.md.selectOption('NIFTY', EXPIRY, { by: 'offset', steps: 2, type: 'CE' })
  assert.equal(up?.strike, 25_100)
  const down = parts.ctx.md.selectOption('NIFTY', EXPIRY, { by: 'offset', steps: -2, type: 'PE' })
  assert.equal(down?.strike, 24_900)
})

test('selectOption returns NULL rather than an ATM fallback — the otmSelector defect, designed out', () => {
  const parts = chainFixture({ withMarks: true })

  // Off the end of the chain. NOT clamped to the last listed strike, which would
  // put on a far closer contract than the caller believes it asked for.
  assert.equal(parts.ctx.md.selectOption('NIFTY', EXPIRY, { by: 'offset', steps: 40, type: 'CE' }), null)
  // The strike lists, but only on the call side.
  assert.equal(parts.ctx.md.selectOption('NIFTY', EXPIRY, { by: 'offset', steps: 2, type: 'PE' }), null)
  // An expiry with no chain at all.
  assert.equal(parts.ctx.md.selectOption('NIFTY', '2027-01-28', { by: 'atm', type: 'CE' }), null)
  // An ATM *contract* is still a call or a put; guessing CE would be the same
  // defect in a new costume.
  assert.equal(parts.ctx.md.selectOption('NIFTY', EXPIRY, { by: 'atm' }), null)
})

test('premium selection walks the marks, and answers null when there are none', () => {
  const withMarks = chainFixture({ withMarks: true })
  const sel = withMarks.ctx.md.selectOption('NIFTY', EXPIRY, { by: 'premium', target: 40, type: 'CE' })
  assert.equal(sel?.strike, 25_050, 'mark 38 is 2 away from 40; the next best is 60')
  assert.equal(sel?.premium, 38)

  const noMarks = chainFixture({ withMarks: false })
  assert.equal(
    noMarks.ctx.md.selectOption('NIFTY', EXPIRY, { by: 'premium', target: 40, type: 'CE' }),
    null,
    'no marks means the question cannot be answered — not that ATM is the answer',
  )
})

test('delta selection reports the delta it achieved, and refuses without marks', () => {
  const withMarks = chainFixture({ withMarks: true })
  const sel: Selection | null = withMarks.ctx.md.selectOption('NIFTY', EXPIRY, {
    by: 'delta',
    target: 0.3,
    type: 'CE',
  })
  assert.notEqual(sel, null, 'the chain is marked, so delta is answerable')
  assert.equal(typeof sel?.delta, 'number', 'the achieved delta comes back so a fill can be explained')
  assert.ok((sel?.delta ?? 0) > 0 && (sel?.delta ?? 1) < 1)
  assert.ok((sel?.strike ?? 0) >= 25_000, 'a 0.30-delta call is above ATM')

  const noMarks = chainFixture({ withMarks: false })
  assert.equal(
    noMarks.ctx.md.selectOption('NIFTY', EXPIRY, { by: 'delta', target: 0.3, type: 'CE' }),
    null,
  )
})

test('a STRATEGY can select its own contract — the port method, not a host-private extra', async () => {
  // The whole point of K4: this call site is what did not exist. `RunnerMarketData`
  // had a `select()` of its own, off the port, so no strategy could reach it.
  const parts = chainFixture({ withMarks: true })

  class Seller extends StrategyBase {
    picked: Selection | null = null
    dataNeeds(): readonly DataNeed[] {
      return [{ kind: 'option-chain', underlying: 'NIFTY', strikeWindow: 3 }]
    }
    jobs(): readonly JobSpec[] {
      return []
    }
    protected override async onTick(_q: Quote): Promise<void> {
      this.picked ??= this.ctx.md.selectOption('NIFTY', EXPIRY, {
        by: 'premium',
        target: 90,
        type: 'CE',
      })
    }
    constructor(ctx: StrategyContext) {
      super(ctx)
    }
  }

  const s = new Seller(parts.ctx)
  await s.start()
  s.handleTick({ token: NIFTY_SPOT, lastPrice: 24_980, ts: 2 })
  await s.drain()
  assert.equal(s.picked?.strike, 24_950)
  assert.equal(s.picked?.instrument.tradingsymbol, 'NIFTY24950CE')
})

// --- K5: DataNeed can name a bar size ---------------------------------------

/**
 * The enforcement for this one is `tsc`, not the assertion below: before
 * `kind: 'candles'` and `interval` existed, this literal did not typecheck, and
 * the design spec §4g example — which is written exactly like this — could not
 * be copied into a strategy. `apps/runner` papered over it with a hardcoded
 * `WARM_INTERVALS = ['5minute', '60minute']`, so any OTHER interval a strategy
 * declared read an empty series and the strategy silently did nothing all day.
 */
test('dataNeeds() can declare a candle series with an explicit interval', () => {
  const needs: readonly DataNeed[] = [
    { kind: 'index', underlying: 'NIFTY' },
    { kind: 'candles', underlying: 'NIFTY', interval: '60minute' },
    { kind: 'candles', underlying: 'NIFTY', interval: '5minute' },
    { kind: 'option-chain', underlying: 'NIFTY', strikeWindow: 3 },
  ]
  const intervals = needs.filter((n) => n.kind === 'candles').map((n) => n.interval)
  assert.deepEqual(intervals, ['60minute', '5minute'], 'both timeframes survive the declaration')
})

test('a strategy declaring two timeframes keeps them distinct', async () => {
  const parts = makeTestContext()
  class TwoFrames extends StrategyBase {
    dataNeeds(): readonly DataNeed[] {
      return [
        { kind: 'candles', underlying: 'NIFTY', interval: '60minute' }, // ATR width at 10:15
        { kind: 'candles', underlying: 'NIFTY', interval: '5minute' }, // anchor at 11:40
      ]
    }
    jobs(): readonly JobSpec[] {
      return []
    }
    protected override async onTick(_q: Quote): Promise<void> {}
    constructor(ctx: StrategyContext) {
      super(ctx)
    }
  }
  const s = new TwoFrames(parts.ctx)
  await s.start()
  // Collapsing the two is the port defect the spec calls out by name; the
  // declaration is the only place the host can learn they are different.
  assert.equal(new Set(s.dataNeeds().map((n) => n.interval)).size, 2)
})
