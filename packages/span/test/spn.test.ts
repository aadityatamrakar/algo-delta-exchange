import { test } from 'node:test'
import assert from 'node:assert/strict'
import { findContract, parseSpanFile, spanKey } from '../src/index.ts'
import { RA_CE, RA_FUT_NOV, RA_FUT_OCT, RA_PE } from './fixtures/arrays.ts'
import { read } from './_helpers.ts'

function miniWithFifteenValues(): string {
  const text = read('mini.spn')
  const at = text.indexOf('<a>35</a>')
  assert.ok(at > 0)
  return text.slice(0, at) + text.slice(at + '<a>35</a>'.length)   // the Oct future loses its 15th value
}

test('mini.spn parses to one commodity with four contracts', () => {
  const f = parseSpanFile(read('mini.spn'))
  assert.equal(f.businessDate, '2026-10-19')
  assert.equal(f.settlement, true)
  assert.equal(f.created, '20261019193000')
  const tcs = f.commodities.get('TCS')!
  assert.equal(tcs.contracts.size, 4)
  assert.deepEqual(tcs.contracts.get(spanKey('future', '2026-10-27', null, null))!.riskArray, RA_FUT_OCT)
  assert.deepEqual(tcs.contracts.get(spanKey('future', '2026-11', null, null))!.riskArray, RA_FUT_NOV)
  assert.deepEqual(tcs.contracts.get(spanKey('option', '2026-10-27', 3000, 'CE'))!.riskArray, RA_CE)
  assert.deepEqual(tcs.contracts.get(spanKey('option', '2026-10-27', 3000, 'PE'))!.riskArray, RA_PE)
  assert.deepEqual(tcs.contracts.get(spanKey('option', '2026-10-27', 3000, 'PE'))!.delta, -0.5)
  assert.equal(tcs.contracts.get(spanKey('future', '2026-10-27', null, null))!.price, 3010)
  assert.equal(tcs.contracts.get(spanKey('option', '2026-10-27', 3000, 'CE'))!.price, 60)
  assert.equal(findContract(tcs, 'future', '2026-11-23', null, null)!.period, '2026-11')   // month-only period, found by month
  assert.equal(findContract(tcs, 'future', '2026-10-27', null, null)!.period, '2026-10-27')
  assert.equal(findContract(tcs, 'option', '2026-11-23', 3000, 'CE'), null)
  assert.deepEqual(tcs.tiers, [{ tier: 1, startMonth: '2026-10', endMonth: '2026-10' }, { tier: 2, startMonth: '2026-11', endMonth: '2026-11' }])
  assert.equal(tcs.spreads[0]!.priority, 1)
  assert.equal(tcs.spreads[0]!.rate, 3)
  assert.deepEqual(tcs.spreads[0]!.legs, [{ tier: 1, period: null, side: 'A', ratio: 1 }, { tier: 2, period: null, side: 'B', ratio: 1 }])
  assert.equal(tcs.somRate, 1.5)
})
test('the Nov future array is exactly v * 1.01 in JS', () => {
  const f = parseSpanFile(read('mini.spn'))
  assert.deepEqual(f.commodities.get('TCS')!.contracts.get(spanKey('future', '2026-11', null, null))!.riskArray, RA_FUT_OCT.map((v) => v * 1.01))
})
test('a risk array that is not 16 values names the contract', () =>
  assert.throws(() => parseSpanFile(miniWithFifteenValues()), /TCS.*2026-10/))
test("NSE's empty inter-commodity spread block is not read, and the commodity's own spreads stand", () => {
  // the tail of the real nsccl.20261019.s.spn: one placeholder dSpread with every value empty
  const inter = '<interSpreads>\n<dSpread>\n<spread></spread>\n<chargeMeth></chargeMeth>\n<rate>\n<r></r>\n<val></val>\n</rate>\n</dSpread>\n</interSpreads>\n'
  const text = read('mini.spn')
  const at = text.lastIndexOf('</spanFile>')
  const withInter = parseSpanFile(text.slice(0, at) + inter + text.slice(at))
  assert.deepEqual(withInter.commodities.get('TCS')!.spreads, parseSpanFile(text).commodities.get('TCS')!.spreads)
})

test("NSE's layout: intraTiers (with its empty tier 0) and pLeg spread legs by expiry date", () => {
  const text = read('mini.spn')
    .replace('<intrTiers>', '<intraTiers>\n        <tier><tn>0</tn></tier>').replace('</intrTiers>', '</intraTiers>')
    .replace('<tLeg><tn>1</tn><rs>A</rs><i>1</i></tLeg>', '<pLeg><cc>TCS</cc><pe>20261027</pe><rs>A</rs><i>1.000000</i></pLeg>')
    .replace('<tLeg><tn>2</tn><rs>B</rs><i>1</i></tLeg>', '<pLeg><cc>TCS</cc><pe>20261124</pe><rs>B</rs><i>1.000000</i></pLeg>')
  const tcs = parseSpanFile(text).commodities.get('TCS')!
  assert.deepEqual(tcs.tiers, parseSpanFile(read('mini.spn')).commodities.get('TCS')!.tiers)
  assert.deepEqual(tcs.spreads[0]!.legs, [
    { tier: null, period: '2026-10-27', side: 'A', ratio: 1 },
    { tier: null, period: '2026-11-24', side: 'B', ratio: 1 },
  ])
})

test('only= keeps just the named commodities', () => {
  const text = read('mini.spn')
  assert.equal(parseSpanFile(text, new Set(['INFY'])).commodities.size, 0)
  assert.equal(parseSpanFile(text, new Set(['TCS'])).commodities.get('TCS')!.contracts.size, 4)
})

function without(text: string, piece: string): string {
  assert.ok(text.includes(piece), piece)
  return text.replace(piece, '')
}
test('a file without a business date throws', () =>
  assert.throws(() => parseSpanFile(without(read('mini.spn'), '<date>20261019</date>')), /business date/))
test('a contract without its price names the contract', () =>
  assert.throws(() => parseSpanFile(without(read('mini.spn'), '<p>3010</p>')), /TCS future 2026-10-27.*price/))
test('a contract without its delta names the contract', () =>
  assert.throws(() => parseSpanFile(without(read('mini.spn'), '<d>1</d>')), /TCS future 2026-10-27.*delta/))
