import { test } from 'node:test'
import assert from 'node:assert/strict'
import { eodKey, parseCmBhavcopy, parseFoBhavcopy } from '../src/index.ts'
import { read } from './_helpers.ts'

// eod fixtures: TCS on 2026-10-16 — 2026-10-27 3000 CE close 44 OI 525000, 2026-10-27 FUT close 3005 OI 1750000, 2026-11-23 FUT close 3025; cash TCS EQ close 2990 (plus a TCS BE row)
test('F&O bhavcopy, both generations, the same rows', () => {
  const u = parseFoBhavcopy(read('eod/fo-udiff.csv')), l = parseFoBhavcopy(read('eod/fo-legacy.csv'))
  const ce = { stock: 'TCS', instrument: 'option', expiry: '2026-10-27', strike: 3000, optType: 'CE' } as const
  for (const rows of [u, l]) {
    const by = new Map(rows.map((r) => [eodKey(r), r]))
    assert.deepEqual([by.get(eodKey(ce))!.close, by.get(eodKey(ce))!.oi], [44, 525000])
    assert.equal(by.get(eodKey({ stock: 'TCS', instrument: 'future', expiry: '2026-10-27', strike: null, optType: null }))!.close, 3005)
    assert.equal(by.get(eodKey({ stock: 'TCS', instrument: 'future', expiry: '2026-10-27', strike: null, optType: null }))!.oi, 1750000)
    assert.equal(by.get(eodKey({ stock: 'TCS', instrument: 'future', expiry: '2026-11-23', strike: null, optType: null }))!.close, 3025)
    assert.equal(by.get(eodKey({ stock: 'NIFTY', instrument: 'option', expiry: '2026-10-20', strike: 25000, optType: 'CE' }))!.close, 110)   // index rows too
  }
  assert.deepEqual(u.map(eodKey), l.map(eodKey))
})
test('the close is read, never the settlement price', () => {
  const rows = parseFoBhavcopy('TckrSymb,FinInstrmTp,XpryDt,StrkPric,OptnTp,ClsPric,SttlmPric,OpnIntrst\nTCS,STF,2026-10-27,,,3005,3001,10\n')
  assert.equal(rows[0]!.close, 3005)
})
test('CM bhavcopy keeps series EQ only, as shares', () => {
  for (const f of ['eod/cm-udiff.csv', 'eod/cm-legacy.csv']) {
    const rows = parseCmBhavcopy(read(f)).filter((r) => r.stock === 'TCS')
    assert.deepEqual(rows.map((r) => [r.stock, r.instrument, r.expiry, r.close, r.oi]), [['TCS', 'share', '', 2990, null]])
  }
})
test('an unknown header names the missing column', () => {
  assert.throws(() => parseFoBhavcopy('a,b\n1,2'), /ClsPric|CLOSE/)
  assert.throws(() => parseCmBhavcopy('a,b\n1,2'), /ClsPric|CLOSE/)
})

test('a recognised header whose rows all fail to parse throws, naming the first bad row', () => {
  const fo = 'TckrSymb,FinInstrmTp,XpryDt,StrkPric,OptnTp,ClsPric,OpnIntrst\nTCS,STF,27/10/2026,,,3005,10\nTCS,STF,28/10/2026,,,3006,10\n'
  assert.throws(() => parseFoBhavcopy(fo), /no row could be read.*row 2/)
  assert.throws(() => parseCmBhavcopy('SYMBOL,SERIES,CLOSE\nTCS,EQ,n/a\n'), /no row could be read.*row 2/)
})
test('a header with no data rows, or only skipped rows, is not an error', () => {
  assert.deepEqual(parseFoBhavcopy('TckrSymb,FinInstrmTp,XpryDt,StrkPric,OptnTp,ClsPric,OpnIntrst\n'), [])
  assert.deepEqual(parseCmBhavcopy('SYMBOL,SERIES,CLOSE\nTCS,BE,5\n'), [])
})
test('one bad row among good ones is skipped', () => {
  const fo = 'TckrSymb,FinInstrmTp,XpryDt,StrkPric,OptnTp,ClsPric,OpnIntrst\nTCS,STF,bad,,,1,1\nTCS,STF,2026-10-27,,,3005,10\n'
  assert.equal(parseFoBhavcopy(fo).length, 1)
})
