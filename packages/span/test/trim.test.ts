import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseSpanFile, scanXml, trimSpanXml } from '../src/index.ts'
import { read } from './_helpers.ts'

const MINI = read('mini.spn')

test('trimmed to the symbol in the file, the text is unchanged byte for byte', () =>
  assert.equal(trimSpanXml(MINI, new Set(['TCS'])), MINI))

test('trimmed to TCS, the file re-parses with its 4 contracts', () => {
  const tcs = parseSpanFile(trimSpanXml(MINI, new Set(['TCS']))).commodities.get('TCS')
  assert.equal(tcs?.contracts.size, 4)
})

test('trimmed to another symbol, no commodity is left and the header survives', () => {
  const f = parseSpanFile(trimSpanXml(MINI, new Set(['OTHER'])))
  assert.equal(f.commodities.size, 0)
  assert.equal(f.businessDate, '2026-10-19')
})

test('only the other symbols are cut, and a physical-delivery block is cut with its symbol', () => {
  const two = MINI.replace('</spanFile>',
    '  <phyPf><pfCode>INFY</pfCode><phy><p>1500</p></phy></phyPf>\n  <futPf><pfCode>INFY</pfCode></futPf>\n</spanFile>')
  const out = trimSpanXml(two, new Set(['TCS']))
  assert.ok(!out.includes('INFY'))
  assert.equal(out.replace(/^ *\n/gm, ''), MINI)                       // only the cut blocks' indentation is left behind
  assert.ok(trimSpanXml(two, new Set(['INFY'])).includes('<phyPf><pfCode>INFY</pfCode>'))
  assert.ok(!trimSpanXml(two, new Set(['INFY'])).includes('<cc>TCS</cc>'))
})

const wrap = (body: string): string => `<spanFile>${body}</spanFile>`
const syms = (xml: string): string[] => [...xml.matchAll(/<(?:pfCode|cc)>([^<]*)</g)].map((m) => m[1]!)

test('the symbol element may come after nested children', () => {
  const xml = wrap('<futPf><fut><pe>1</pe></fut><pfCode>A</pfCode></futPf><futPf><fut/><pfCode>B</pfCode></futPf>')
  assert.deepEqual(syms(trimSpanXml(xml, new Set(['B']))), ['B'])
})
test('kept and dropped blocks interleave', () => {
  const xml = wrap('<futPf><pfCode>A</pfCode></futPf><oopPf><pfCode>B</pfCode></oopPf><futPf><pfCode>C</pfCode></futPf><ccDef><cc>D</cc></ccDef><phyPf><pfCode>E</pfCode></phyPf>')
  assert.equal(trimSpanXml(xml, new Set(['B', 'D'])), wrap('<oopPf><pfCode>B</pfCode></oopPf><ccDef><cc>D</cc></ccDef>'))
})
test('a block that names no symbol is kept', () => {
  const xml = wrap('<futPf><fut/></futPf><futPf><pfCode>A</pfCode></futPf>')
  assert.equal(trimSpanXml(xml, new Set(['Z'])), wrap('<futPf><fut/></futPf>'))
})
test('a block ends at its own close: same-name nesting drops the whole outer block', () => {
  const xml = wrap('<futPf><pfCode>OUT</pfCode><futPf><pfCode>IN</pfCode></futPf><fut/></futPf><futPf><pfCode>K</pfCode></futPf>')
  const out = trimSpanXml(xml, new Set(['K']))
  assert.equal(out, wrap('<futPf><pfCode>K</pfCode></futPf>'))
  assert.equal(syms(trimSpanXml(xml, new Set(['OUT', 'K']))).join(), 'OUT,IN,K')
  scanXml(out, { open() {}, close() {} })                              // well-formed (throws otherwise)
})
test('a deeper pfCode does not decide the block symbol', () => {
  const xml = wrap('<futPf><x><pfCode>DEEP</pfCode></x><pfCode>REAL</pfCode></futPf>')
  assert.deepEqual(syms(trimSpanXml(xml, new Set(['REAL']))), ['DEEP', 'REAL'])
  assert.equal(trimSpanXml(xml, new Set(['DEEP'])), wrap(''))
})
