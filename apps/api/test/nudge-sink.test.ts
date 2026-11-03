/**
 * The sink itself (`./nudge-sink.ts`): it receives a nudge sent the way
 * `notifySupervisor` (`../src/engine-notify.ts`) actually sends one, and its
 * `close()` restores `DESK_SUPERVISOR_PORT` rather than leaking a port
 * number into whichever test file runs after it in this process.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { notifySupervisor } from '../src/engine-notify.ts'
import { startNudgeSink } from './nudge-sink.ts'

test('the sink receives a nudge sent through notifySupervisor, at the port it set', async () => {
  const prior = process.env['DESK_SUPERVISOR_PORT']
  const sink = await startNudgeSink()
  try {
    assert.equal(process.env['DESK_SUPERVISOR_PORT'], String(sink.port))
    await notifySupervisor('registry', { tag: 'X', mode: 'paper', desired: 'running' }, { log: () => {} })
    assert.equal(sink.nudges.length, 1)
    assert.equal(sink.nudges[0]?.['kind'], 'registry')
    assert.equal(sink.nudges[0]?.['tag'], 'X')
  } finally {
    await sink.close()
  }
  assert.equal(process.env['DESK_SUPERVISOR_PORT'], prior, 'close() must restore the prior value')
})

test('close() deletes the env var when it was unset before the sink started', async () => {
  const prior = process.env['DESK_SUPERVISOR_PORT']
  delete process.env['DESK_SUPERVISOR_PORT']
  try {
    const sink = await startNudgeSink()
    assert.equal(process.env['DESK_SUPERVISOR_PORT'], String(sink.port))
    await sink.close()
    assert.equal(process.env['DESK_SUPERVISOR_PORT'], undefined)
  } finally {
    if (prior === undefined) delete process.env['DESK_SUPERVISOR_PORT']
    else process.env['DESK_SUPERVISOR_PORT'] = prior
  }
})

/**
 * `require-mongo.ts`'s module-scope guard must catch an EMPTY value, not
 * only `undefined` — `envPort()` (`../src/engine-notify.ts`) treats "" and
 * "0" as unset too, so a guard that only checked `=== undefined` would let a
 * shell that exported `DESK_SUPERVISOR_PORT=` blank sail straight through to
 * the live supervisor's 8893 default. `require-mongo.ts` is imported
 * dynamically here — this file otherwise never imports it — so its
 * module-scope guard runs fresh against the "" we set below, the same way it
 * would for the first Mongo-backed test file loaded in a process.
 */
test('require-mongo installs a usable port when DESK_SUPERVISOR_PORT is set but blank', async () => {
  const prior = process.env['DESK_SUPERVISOR_PORT']
  process.env['DESK_SUPERVISOR_PORT'] = ''
  try {
    await import('./require-mongo.ts')
    const installed = process.env['DESK_SUPERVISOR_PORT'] ?? ''
    const asNumber = Number(installed)
    assert.ok(
      Number.isInteger(asNumber) && asNumber > 0,
      `expected the guard to install a positive port, got ${JSON.stringify(installed)}`,
    )

    // The sink's restore must put back exactly the guard-installed value —
    // never delete it, since it was never `undefined` here.
    const sink = await startNudgeSink()
    assert.equal(process.env['DESK_SUPERVISOR_PORT'], String(sink.port))
    await sink.close()
    assert.equal(
      process.env['DESK_SUPERVISOR_PORT'],
      installed,
      "sink close() must restore the guard's installed port, not delete it",
    )
  } finally {
    if (prior === undefined) delete process.env['DESK_SUPERVISOR_PORT']
    else process.env['DESK_SUPERVISOR_PORT'] = prior
  }
})
