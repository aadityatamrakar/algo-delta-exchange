import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseExposureFile } from '../src/index.ts'
import { read } from './_helpers.ts'

test('exposure file: symbol -> fraction', () => {
  const m = parseExposureFile(read('ael_19102026.csv'))
  assert.equal(m.get('TCS'), 0.035)
  assert.equal(m.get('NIFTY'), 0.02)
})
test('without a total column, the last numeric column is used', () =>
  assert.equal(parseExposureFile('Symbol,Name,Margin\nTCS,Tata,4\n').get('TCS'), 0.04))
test('an exposure file without a Symbol column throws', () => assert.throws(() => parseExposureFile('a,b\n1,2'), /Symbol/))

test('a trailing % on the rate is accepted', () =>
  assert.equal(parseExposureFile('Symbol,Total applicable ELM %\nTCS,3.5%\n').get('TCS'), 0.035))
test('data rows of which none parse throw', () =>
  assert.throws(() => parseExposureFile('Symbol,Total applicable ELM %\nTCS,n/a\n'), /no row could be read/))
