/**
 * THE HOLD READS ONE WAY WHEN IT KNOWS, AND ONE WAY WHEN IT DOES NOT.
 *
 * `decide()` stands the whole action pass down while desk-api's repair Apply is
 * working a tag, so this boolean decides whether a book trades at all for the
 * next minute. The two mistakes are not symmetrical: a book stood down for a few
 * seconds loses a mark, while a book that trades through a repair re-decides
 * against legs it has not caught up with, on top of the orders the repair is
 * placing.
 *
 * The lookup itself is desk-api's (`repair-apply.ts:repairHoldLookup`) and is
 * not re-tested here — `repairHoldLookupFor` exists so the compiler proves the
 * two agree.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  NO_REPAIR_HOLD,
  repairHoldReader,
  type RepairHoldLookup,
} from '../src/repair-hold.ts'
import type { HostLog } from '../src/engine-host.ts'

interface Line {
  readonly level: string
  readonly msg: string
}

function log(): { log: HostLog; lines: Line[] } {
  const lines: Line[] = []
  const at =
    (level: string) =>
    (msg: string): void => {
      lines.push({ level, msg })
    }
  return { lines, log: { debug: at('debug'), info: at('info'), warn: at('warn'), error: at('error') } }
}

test('a live hold stands the book down, and says so once a minute', async () => {
  const l = log()
  let now = 1_000
  const lookup: RepairHoldLookup = async () => ({ untilMs: 9_999 })
  const held = repairHoldReader({ lookup, tag: 'TCS', log: l.log, now: () => now })

  assert.equal(await held(), true)
  assert.equal(await held(), true)
  assert.equal(l.lines.length, 1, 'this is called on every tick of every book')

  now += 61_000
  assert.equal(await held(), true)
  assert.equal(l.lines.length, 2)
  assert.equal(l.lines[0]?.level, 'warn')
})

test('no hold is no hold — and it is not logged', async () => {
  const l = log()
  const lookup: RepairHoldLookup = async () => null
  const held = repairHoldReader({ lookup, tag: 'TCS', log: l.log, now: () => 1_000 })
  assert.equal(await held(), false)
  assert.deepEqual(l.lines, [])
})

test('a read that FAILED holds — an unreadable answer is not "nothing is running"', async () => {
  const l = log()
  const lookup: RepairHoldLookup = async () => {
    throw new Error('connection refused')
  }
  const held = repairHoldReader({ lookup, tag: 'TCS', log: l.log, now: () => 1_000 })
  assert.equal(await held(), true)
  assert.equal(l.lines[0]?.level, 'error', 'a book standing down for an invisible reason is loud')
})

test('a deployment with no repair feature never holds', async () => {
  assert.equal(await NO_REPAIR_HOLD(), false)
})
