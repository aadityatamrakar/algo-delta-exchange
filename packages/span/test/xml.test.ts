import { test } from 'node:test'
import assert from 'node:assert/strict'
import { scanXml, SpanParseError } from '../src/index.ts'

test('scanXml reports elements in order with decoded text and offsets', () => {
  const ev: string[] = []
  scanXml('<?xml version="1.0"?><a x="1"><b>1 &amp; 2</b><c/></a>', { open: (n) => ev.push(`+${n}`), close: (n, t) => ev.push(`-${n}:${t}`) })
  assert.deepEqual(ev, ['+a', '+b', '-b:1 & 2', '+c', '-c:', '-a:'])
})
test('offsets: open is the index of "<", close is the index after ">"', () => {
  const at: number[] = []
  scanXml('<a><b>x</b></a>', { open: (_n, i) => at.push(i), close: (_n, _t, e) => at.push(e) })
  assert.deepEqual(at, [0, 3, 11, 15])
})
test('comments, doctype and a ">" inside an attribute value are skipped', () => {
  const ev: string[] = []
  scanXml('<!DOCTYPE x><a t="1>2"><!-- <z> --><b>k</b></a>', { open: (n) => ev.push(`+${n}`), close: (n, t) => ev.push(`-${n}:${t}`) })
  assert.deepEqual(ev, ['+a', '+b', '-b:k', '-a:'])
})
test('unbalanced tags throw SpanParseError', () => assert.throws(() => scanXml('<a><b></a>', { open() {}, close() {} }), SpanParseError))
test('an unclosed element throws SpanParseError', () => assert.throws(() => scanXml('<a><b></b>', { open() {}, close() {} }), SpanParseError))
