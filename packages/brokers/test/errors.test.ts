import test from 'node:test'
import assert from 'node:assert/strict'
import { BrokerOrderError, classifyBrokerError } from '../src/index.ts'

test('a placement error carries its class', () => {
  const e = new BrokerOrderError('boom', 'unknown')
  assert.equal(e.klass, 'unknown')
  assert.ok(e instanceof Error)
})

test('a transport fault is unknown (may have reached the venue); anything else is fatal', () => {
  for (const m of ['request timed out', 'fetch failed', 'ECONNRESET', 'socket hang up', 'The operation was aborted']) {
    assert.equal(classifyBrokerError(m), 'unknown', m)
  }
  for (const m of ['insufficient margin', '', null, undefined]) {
    assert.equal(classifyBrokerError(m), 'fatal', String(m))
  }
})
