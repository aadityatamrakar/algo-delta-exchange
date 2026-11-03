import { test } from 'node:test'
import assert from 'node:assert/strict'
import { OptionMaster, type InstrumentRow } from '@algomaker/instruments'
import { QuoteCache } from '../src/marks.ts'
import { buildChain } from '../src/chain.ts'

const EXPIRY = '2026-08-25'

function master(): OptionMaster {
  const rows: InstrumentRow[] = []
  for (const strike of [415, 417.5, 420]) {
    for (const type of ['CE', 'PE'] as const) {
      rows.push({
        instrument_token: 700000 + strike * 10 + (type === 'CE' ? 1 : 2),
        tradingsymbol: `BHEL26AUG${strike}${type}`,
        name: 'BHEL',
        expiry: EXPIRY,
        strike,
        tick_size: 0.05,
        lot_size: 2625,
        instrument_type: type,
        segment: 'NFO-OPT',
        exchange: 'NFO',
      })
    }
  }
  rows.push({
    instrument_token: 600001,
    tradingsymbol: 'BHEL26AUGFUT',
    name: 'BHEL',
    expiry: EXPIRY,
    strike: 0,
    tick_size: 0.05,
    lot_size: 2625,
    instrument_type: 'FUT',
    segment: 'NFO-FUT',
    exchange: 'NFO',
  })
  return new OptionMaster(rows)
}

test('every listed strike is returned, unticked ones as null', () => {
  const m = master()
  const marks = new QuoteCache({ now: () => 1_000_000 })
  marks.update(m.resolve('BHEL', EXPIRY, 420, 'CE')!.instrumentToken!, 15.4, 999_000, {
    oi: 1200,
    volume: 90,
    bid: 15.3,
    ask: 15.5,
  })

  const chain = buildChain({ master: m, marks, now: () => 1_000_000 }, 'BHEL', EXPIRY)

  assert.equal(chain.rows.length, 3)
  const at420 = chain.rows.find((r) => r.strike === 420)
  // The MID of the tick's book — the cache's one price definition.
  assert.equal(at420?.CE?.price, (15.3 + 15.5) / 2)
  assert.equal(at420?.CE?.oi, 1200)
  assert.equal(at420?.CE?.volume, 90)
  // And the pair rides along, so a client can print the width.
  assert.equal(at420?.CE?.bid, 15.3)
  assert.equal(at420?.CE?.ask, 15.5)
  assert.equal(at420?.CE?.asOf, 999_000)
  assert.equal(at420?.CE?.ageMs, 1_000)
  // Listed but never ticked — present, and honestly empty.
  assert.equal(chain.rows.find((r) => r.strike === 415)?.CE, null)
  assert.equal(chain.rows.find((r) => r.strike === 415)?.PE, null)
})

test('the inferred strike step is served, not a configured one', () => {
  const chain = buildChain({ master: master(), marks: new QuoteCache(), now: () => 1 }, 'BHEL', EXPIRY)
  assert.equal(chain.step, 2.5)
  assert.equal(chain.lotSize, 2625)
})

test('a dead feed yields no prices but still lists the strikes', () => {
  // Liveness is ARRIVAL-based and feed-wide (marks.ts). A constant clock
  // never elapses between the update and the check below, so the feed would
  // read alive regardless of any ts passed to update() — time has to
  // actually move for "dead" to be exercised at all.
  const m = master()
  let now = 10_000_000
  const marks = new QuoteCache({ now: () => now, feedDeadAfterMs: 120_000 })
  marks.update(m.resolve('BHEL', EXPIRY, 420, 'CE')!.instrumentToken!, 15.4, now)
  now += 200_000 // nothing has ticked since — the feed itself has gone dark

  const chain = buildChain({ master: m, marks, now: () => now }, 'BHEL', EXPIRY)
  assert.equal(chain.feedAlive, false)
  assert.equal(chain.rows.length, 3)
  assert.equal(chain.rows.find((r) => r.strike === 420)?.CE, null)
})

test('spot and future are served with their own asOf when the feed has them', () => {
  const m = master()
  const marks = new QuoteCache({ now: () => 2_000_000 })
  const futureToken = m.future('BHEL')?.instrumentToken
  assert.ok(futureToken !== undefined)
  marks.update(futureToken as number, 421.5, 1_500_000)

  const chain = buildChain({ master: m, marks, now: () => 2_000_000 }, 'BHEL', EXPIRY)
  assert.equal(chain.future, 421.5)
  assert.equal(chain.futureAsOf, 1_500_000)
})

test('an underlying with no listed chain at all still returns an empty, well-formed response', () => {
  const m = master()
  const marks = new QuoteCache({ now: () => 1 })
  const chain = buildChain({ master: m, marks, now: () => 1 }, 'BHEL', '2099-01-01')
  assert.equal(chain.rows.length, 0)
  assert.equal(chain.step, null)
  assert.equal(chain.lotSize, null)
})

test('a chain quote carries the depth the cache holds', () => {
  const m = master()
  const marks = new QuoteCache({ now: () => 1_000_000 })
  const peToken = m.resolve('BHEL', EXPIRY, 420, 'PE')!.instrumentToken!
  marks.update(peToken, 15.4, 999_000, {
    bid: 12.3,
    ask: 12.5,
    depth: { buy: [{ price: 12.3, qty: 500 }], sell: [{ price: 12.5, qty: 250 }] },
  })

  const chain = buildChain({ master: m, marks, now: () => 1_000_000 }, 'BHEL', EXPIRY)

  const q = chain.rows.find((r) => r.strike === 420)?.PE
  assert.deepEqual(q?.depth, { buy: [{ price: 12.3, qty: 500 }], sell: [{ price: 12.5, qty: 250 }] })
})

test('display mode prices a dead-feed chain off the last marks, feedAlive still honest', () => {
  // The closed-market cockpit's chain: same strikes, same shape, but read
  // through displayQuote — past the feed-dead gate, down to the snapshot. The
  // desk's own decision chain never passes this flag.
  const m = master()
  let now = 10_000_000
  const marks = new QuoteCache({ now: () => now, feedDeadAfterMs: 120_000 })
  const futureToken = m.future('BHEL')!.instrumentToken as number
  marks.update(m.resolve('BHEL', EXPIRY, 420, 'CE')!.instrumentToken!, 15.4, now)
  marks.update(futureToken, 421.5, now)
  // The 415 put lives only in the persisted snapshot — a restart happened.
  marks.loadSnapshot([{ token: m.resolve('BHEL', EXPIRY, 415, 'PE')!.instrumentToken!, price: 3.15, ts: now }])
  now += 2 * 60 * 60 * 1000 // the market closed hours ago

  const chain = buildChain({ master: m, marks, now: () => now }, 'BHEL', EXPIRY, { display: true })
  assert.equal(chain.feedAlive, false, 'display marks must not launder liveness')
  assert.equal(chain.future, 421.5)
  assert.equal(chain.rows.find((r) => r.strike === 420)?.CE?.price, 15.4)
  assert.equal(chain.rows.find((r) => r.strike === 415)?.PE?.price, 3.15)
  assert.equal(chain.rows.find((r) => r.strike === 420)?.CE?.ageMs, 2 * 60 * 60 * 1000)
})
