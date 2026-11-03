/**
 * THE STAMP HAS TO SURVIVE THE SUPERVISOR — both ends of it.
 *
 * The delta-lean lean id leaves `decideDeltaLean` on an `EngineAction`, goes out
 * on a `WireAction`, is stored on the leg by desk-api, and comes back through
 * `#readBook` as a `LegPosition`. This process owns the FIRST and the LAST of
 * those hops, and neither one throws when it drops the field.
 *
 * ── THE WAY BACK ────────────────────────────────────────────────────────────
 *
 * `#readBook` rebuilds a `LegPosition` from a stored `desk-books` leg FIELD BY
 * FIELD. A field it does not map is a field that does not exist as far as the
 * engine is concerned — silently, and with no type error anywhere on the
 * stored-document side, because the document is a `Record<string, unknown>`.
 *
 * That is exactly how the delta-lean stamp would go missing: the lean id would
 * be written by desk-api, stored correctly, read back as `undefined`, and every
 * lean would then read as holding nothing. It would never add on a winner, never
 * cut on a loser, and nothing would throw.
 *
 * `legPositionsFrom` is the mapper `#readBook` calls, exported so this can test
 * the real thing rather than a second copy of it: a private method reached only
 * through a booted `Supervisor`, a fake Mongo and a full tick would be a wiring
 * test wearing a mapper test's clothes.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import type { EngineAction } from '@algomaker/desk-engine'
import { wireOpen } from '../src/engine-host.ts'
import { legPositionsFrom } from '../src/main.ts'

const LOT = 65

/** One leg as `desk-books` stores it: a signed `qty`, the lot size on the
 * instrument sub-document, and no `origin` (an engine open stamps none). */
function storedLeg(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    instrument: { tradingsymbol: 'NIFTY26SEP23950CE', lotSize: LOT },
    strike: 23_950,
    type: 'CE',
    qty: 2 * LOT,
    entryPrice: 100,
    ...over,
  }
}

test('#readBook carries leanId off the stored leg', () => {
  const positions = legPositionsFrom([storedLeg({ leanId: 'dl-up-123' })])
  assert.equal(positions.length, 1)
  assert.equal(positions[0]?.leanId, 'dl-up-123')
})

test('a stored leg with no leanId reads as the empty string', () => {
  // NOT `undefined`. `leanPnl` matches on equality, so an undefined here would
  // match an undefined lean id and adopt every manual leg in the book.
  const positions = legPositionsFrom([storedLeg()])
  assert.equal(positions[0]?.leanId, '')
})

test('a leanId that is not a string reads as the empty string too', () => {
  // The document is whatever was written by whatever version wrote it. A number
  // or a null there must read as "no lean", never be carried into an equality
  // test against a real lean id.
  assert.equal(legPositionsFrom([storedLeg({ leanId: 7 })])[0]?.leanId, '')
  assert.equal(legPositionsFrom([storedLeg({ leanId: null })])[0]?.leanId, '')
})

test('the rest of the mapping still holds — a signed qty becomes a side and a lot count', () => {
  // Guards the fields this task did NOT touch: adding one to the end of a
  // field-by-field mapper is exactly where the others get dropped.
  const [long] = legPositionsFrom([storedLeg({ leanId: 'dl-up-9' })])
  assert.equal(long?.side, 'Buy')
  assert.equal(long?.lots, 2)
  assert.equal(long?.lotSize, LOT)
  assert.equal(long?.entry, 100)
  assert.equal(long?.openedByEngine, true) // no `origin` = the engine opened it
  const [short] = legPositionsFrom([storedLeg({ qty: -4 * LOT, origin: 'manual' })])
  assert.equal(short?.side, 'Sell')
  assert.equal(short?.lots, 4)
  assert.equal(short?.openedByEngine, false)
})

test('an unusable leg is dropped rather than zero-filled', () => {
  // A leg with no lot size cannot be converted to lots at all, and one at qty 0
  // is not held. Both would otherwise reach the engine as a position it would
  // size a real package against.
  assert.deepEqual(legPositionsFrom([storedLeg({ qty: 0 })]), [])
  assert.deepEqual(legPositionsFrom([storedLeg({ instrument: { tradingsymbol: 'X', lotSize: 0 } })]), [])
  assert.deepEqual(legPositionsFrom([storedLeg({ type: 'XX' })]), [])
})

// ══════════════════════════════════════════════════════════ the way out

/** An `EngineAction` open, as the delta-lean controller emits one. */
function openAction(over: Partial<Extract<EngineAction, { op: 'open' }>> = {}): Extract<
  EngineAction,
  { op: 'open' }
> {
  return { op: 'open', strike: 24_000, optType: 'CE', side: 'Buy', lots: 1, ...over }
}

test('an open action carries its lean id onto the wire', () => {
  const wire = wireOpen(openAction({ leanId: 'dl-up-123' }), 'NIFTY26SEP24000CE', 65, {})
  assert.equal(wire.op, 'open')
  assert.ok(wire.op === 'open' && wire.leanId === 'dl-up-123')
})

test('the stamp survives the QUOTED spelling too — the one most adds take', () => {
  // `#translate` used to build the wire open twice, once for a passive maker
  // quote and once for everything else. A field carried on one spelling and not
  // the other goes missing on exactly the packages a passively-worked add makes.
  const wire = wireOpen(openAction({ side: 'Sell', leanId: 'dl-down-7' }), 'NIFTY26SEP24200CE', 65, {
    limitPrice: 41.5,
    workMode: 'passive',
  })
  assert.ok(wire.op === 'open' && wire.leanId === 'dl-down-7')
  assert.equal(wire.limitPrice, 41.5)
  assert.equal(wire.workMode, 'passive')
})

test('a recenter open carries no lean id, and that is not an error', () => {
  // The recenter engine has no leans, so its opens name none. `undefined`, not
  // `''`: the key must not travel at all, or Mongo stores a null and reads it
  // back as a value the read side would then have to special-case.
  const wire = wireOpen(openAction({ side: 'Sell' }), 'NIFTY26SEP24200CE', 65, { workMode: 'urgent' })
  assert.ok(wire.op === 'open' && wire.leanId === undefined)
  assert.equal('leanId' in wire, false) // absent, not present-and-undefined
})

test('an empty lean id is dropped rather than sent as a value', () => {
  // '' is the read side's spelling of "no lean". Putting it on the wire would
  // store an empty string on the leg, which is a value where absence is meant.
  const wire = wireOpen(openAction({ leanId: '' }), 'NIFTY26SEP24000CE', 65, {})
  assert.equal('leanId' in wire, false)
})

test('an open marked as an ADD carries that onto the wire', () => {
  // Same hop, same failure mode as the lean stamp: a flag dropped here is
  // invisible end to end and nothing throws when it goes — the shed simply
  // starts being refused again, silently.
  const wire = wireOpen(openAction({ side: 'Sell', add: true }), 'NIFTY26SEP24200CE', 65, {
    limitPrice: 41.5,
    workMode: 'passive',
  })
  assert.ok(wire.op === 'open' && wire.add === true)
})

test('an open that is NOT an add carries no flag at all', () => {
  // Absent, never `add: false`: an explicit undefined travels as a JSON null,
  // which Mongo stores and reads back as a value.
  const wire = wireOpen(openAction({ side: 'Sell' }), 'NIFTY26SEP24200CE', 65, {})
  assert.ok(wire.op === 'open' && !('add' in wire))
})
