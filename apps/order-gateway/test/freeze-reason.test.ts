import { test } from 'node:test'
import assert from 'node:assert/strict'
import { freezeUnknownReason } from '../src/gateway.ts'

/**
 * WHAT AN UNKNOWN FREEZE LIMIT ACTUALLY MEANS, per exchange.
 *
 * `desk-freeze-limits` is built from NSE's `qtyfreeze.csv`
 * (`apps/marketdata/src/sync-runner.ts`). A BSE underlying — SENSEX, BANKEX —
 * is not in that file and never will be, so "no freeze limit for SENSEX" is a
 * MISSING SOURCE, not a broken sync.
 *
 * THE COST OF SAYING IT WRONG (2026-09-16). The message told the operator to
 * "check the desk-freeze-limits sync and the instrument master's name column".
 * Both were fine. The sync had run, the name column was right, and SENSEX was
 * absent because the file it syncs is NSE-only — so the advice sent the
 * operator to re-verify two things that could never have been the cause.
 */

test('a BSE contract names the NSE-only source, not the sync or the name column', () => {
  const reason = freezeUnknownReason({
    underlying: 'SENSEX',
    underlyingSource: 'master',
    exchange: 'BFO',
    lots: 100,
  })

  assert.match(reason, /NSE/, 'it must say where the table comes from')
  assert.match(reason, /BSE|BFO/, 'and that this contract is not on that exchange')
  assert.doesNotMatch(
    reason,
    /name column/,
    'the name column cannot be the cause for a BSE underlying — sending the operator ' +
      'there is the misdirection this exists to stop',
  )
  /**
   * Since 2026-09-21 there IS a BSE source: desk-marketdata syncs the index
   * rows from BSE's abridged contract master daily and stamps
   * `md.health.bseFreezeSyncDay`. A SENSEX order going out unsplit now means
   * that sync has not landed, and the reason must send the operator there —
   * not tell them a feed "has to be wired up" that already is.
   */
  assert.match(reason, /Abridged_CO|contract master|bseFreezeSyncDay/, 'it names the BSE source that exists now')
  assert.doesNotMatch(reason, /has to be wired up/, 'the feed exists; saying otherwise is the old misdirection')
})

test('an NSE contract still points at the sync and the name column', () => {
  // For an NFO underlying the table IS the right place to look: either the sync
  // has not run or the master's `name` does not match the freeze key. That
  // advice was always correct here and must survive.
  const reason = freezeUnknownReason({
    underlying: 'WIPRO',
    underlyingSource: 'derived',
    exchange: 'NFO',
    lots: 40,
  })

  assert.match(reason, /name column/)
  assert.match(reason, /desk-freeze-limits/)
})

test('either way it says what is about to go out', () => {
  // The operational fact first: how many lots are leaving as ONE order. That is
  // what decides whether this is survivable or an outright rejection.
  for (const exchange of ['BFO', 'NFO']) {
    const reason = freezeUnknownReason({
      underlying: 'X',
      underlyingSource: 'order',
      exchange,
      lots: 73,
    })
    assert.match(reason, /73 lots as ONE order/)
  }
})
