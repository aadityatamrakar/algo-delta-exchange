/**
 * THE MEASUREMENT the desk-wide risk caps are judged against (audit F-28).
 *
 * `main.ts` wires it — a cached `pnlFor` read, the instrument master for lot
 * sizes, and the in-flight reservation ledger on top. The arithmetic is pulled
 * out as `measureOpenLots` precisely so it can be tested without booting a
 * server, because the one property that matters here is what happens when the
 * master CANNOT size a leg the desk is still holding.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { measureOpenLots } from '../src/main.ts'

const legs = (rows: readonly (readonly [string, number])[]) => [
  { legs: rows.map(([tradingsymbol, qty]) => ({ tradingsymbol, qty })) },
]

/** Everything but SENSEX resolves — the expired-but-still-held shape. */
const lotSize = (s: string): number => (s.startsWith('SENSEX') ? 0 : 25)

test('open lots are counted per underlying and in total, closed round trips excluded', () => {
  const out = measureOpenLots(
    legs([
      ['NIFTY25JUL24000CE', -50],
      ['NIFTY25JUL24500CE', 25],
      ['BANKNIFTY25JUL52000PE', -75],
      // qty 0 is a closed round trip the row keeps for its realised P&L.
      ['NIFTY25JUL23000PE', 0],
    ]),
    lotSize,
  )
  assert.equal(out.openLotsTotal, 6, 'shorts count as exposure — the sign is not the size')
  assert.deepEqual(out.openLotsByUnderlying, { NIFTY: 3, BANKNIFTY: 3 })
  assert.deepEqual(out.unmeasuredSymbols, [], 'nothing was missed')
})

test('a HELD leg the master cannot size is reported, never silently dropped', () => {
  const out = measureOpenLots(
    legs([
      ['NIFTY25JUL24000CE', -50],
      ['SENSEX25JUL80000CE', -20],
      ['SENSEX25JUL81000PE', 10],
      // The same unresolvable contract twice: one symbol, one report.
      ['SENSEX25JUL80000CE', -10],
    ]),
    lotSize,
  )
  assert.equal(out.openLotsTotal, 2, 'what could be measured is still measured')
  assert.deepEqual(
    out.unmeasuredSymbols,
    ['SENSEX25JUL80000CE', 'SENSEX25JUL81000PE'],
    'under-counting silently is the whole defect: the caps then admit exposure that exists',
  )
})

test('a closed round trip in an unresolvable contract is NOT unmeasured', () => {
  const out = measureOpenLots(legs([['SENSEX25JUL80000CE', 0]]), lotSize)
  assert.deepEqual(out.unmeasuredSymbols, [], 'zero lots cannot be under-counted')
  assert.equal(out.openLotsTotal, 0)
})
