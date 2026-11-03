import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  partitionInterruptedTranches,
  readTrancheJournal,
  refuse,
  type TrancheJournalState,
} from '../src/main.ts'
import type { OrderEvent } from '../src/journal.ts'

/**
 * The recovery partition: what a reclaimed order whose placement was
 * INTERRUPTED is allowed to conclude from the journal alone.
 *
 * The whole point of the path is that it places NOTHING. Getting the partition
 * wrong therefore cannot double-place — it can only mis-report, and the
 * mis-reports are not symmetric:
 *
 *   - calling an ACKed tranche failed under-reports a real position, which the
 *     fill socket and the boot sweep can still correct (fills.ts dedups);
 *   - calling a NEVER-SENT tranche placed leaves the desk order waiting on a
 *     fill that will never arrive, for the rest of the session.
 *
 * THE THIRD ANSWER (WP-L, the residual of WP-E). Until the broker sweep
 * existed, "ACK or failure" was the whole rule: with no instrument that could
 * settle an unknown, calling it failed was the least-bad guess. It is a guess
 * that un-books real positions — a tranche whose SUBMITTED line is in the
 * journal left this process for the broker, and a gateway that died before the
 * ACK came back knows nothing about what the exchange did with it.
 *
 * Now that the sweep resolves ambiguity from the broker's own order book (trace
 * ⇒ leave it working, no trace after the TTL ⇒ never placed), SUBMITTED-but-no-
 * answer belongs in `ambiguousTrancheIds`, where the desk order stays
 * NON-TERMINAL until the broker answers. Only a tranche with NO journal entry
 * at all is provably never submitted, and only that one is failed.
 */

const acked = (brokerOrderId: string): TrancheJournalState => ({ submitted: true, brokerOrderId })
const submitted: TrancheJournalState = { submitted: true }
const refused: TrancheJournalState = { submitted: true, failed: true }

test('an interrupted placement keeps the ACKed tranche and fails the untouched rest', () => {
  const out = partitionInterruptedTranches(
    ['o1.1', 'o1.2', 'o1.3'],
    new Map([['o1.1', acked('2100000012345')]]),
    true,
  )
  assert.deepEqual(out.brokerOrderIds, ['2100000012345'])
  // Nothing was ever written for these two: the loop died before their
  // SUBMITTED line, so they are provably still on this side of the wire.
  assert.deepEqual(out.failedTrancheIds, ['o1.2', 'o1.3'])
  assert.deepEqual(out.ambiguousTrancheIds, [])
})

test('a placement interrupted after the LAST ACK loses nothing', () => {
  const out = partitionInterruptedTranches(
    ['o1.1', 'o1.2'],
    new Map([['o1.1', acked('111')], ['o1.2', acked('222')]]),
    true,
  )
  assert.deepEqual(out.brokerOrderIds, ['111', '222'])
  assert.deepEqual(out.failedTrancheIds, [])
  assert.deepEqual(out.ambiguousTrancheIds, [])
})

test('a placement interrupted BEFORE any journal line fails every tranche', () => {
  // Nothing left this process, and nothing is placed to find out. The loud
  // journal line is the operator's instruction to check the orderbook anyway.
  const out = partitionInterruptedTranches(['o1.1', 'o1.2', 'o1.3'], new Map(), true)
  assert.deepEqual(out.brokerOrderIds, [])
  assert.deepEqual(out.failedTrancheIds, ['o1.1', 'o1.2', 'o1.3'])
  assert.deepEqual(out.ambiguousTrancheIds, [])
})

test('an ACK with no broker id is still an ACK, not a failure', () => {
  // It reached the broker; we merely cannot name it. Reporting it failed tells
  // the desk it holds nothing while a live order works against it.
  const out = partitionInterruptedTranches(['o1.1', 'o1.2'], new Map([['o1.1', acked('')]]), true)
  assert.deepEqual(out.brokerOrderIds, [], 'an empty id would poison the fill lookup')
  assert.deepEqual(out.failedTrancheIds, ['o1.2'])
})

// ------------------------------------------------ SUBMITTED but never answered

test('a SUBMITTED tranche with no ACK is AMBIGUOUS, never failed', () => {
  /**
   * THE WP-E RESIDUAL, and the reason this file changed.
   *
   * `placeOne` journals SUBMITTED immediately BEFORE `adapter.placeOrder`. A
   * gateway killed in that window left a tranche that may be live at the
   * exchange; booking it failed marks the desk order REJECTED and Python's
   * reconcile un-books an open that is real, after which the next decision
   * trades against a position it does not know it has. That is F-3 arriving by
   * the recovery path instead of the placement path.
   */
  const out = partitionInterruptedTranches(
    ['o1.1', 'o1.2'],
    new Map([['o1.1', acked('111')], ['o1.2', submitted]]),
    true,
  )
  assert.deepEqual(out.brokerOrderIds, ['111'])
  assert.deepEqual(out.ambiguousTrancheIds, ['o1.2'], 'the sweep settles this from the broker book')
  assert.deepEqual(out.failedTrancheIds, [], 'calling it failed un-books a position that may be live')
})

test('with NO sweep armed, a SUBMITTED tranche goes back to being FAILED', () => {
  /**
   * SIMULATE MODE. `ambiguousTrancheIds` is not a verdict, it is a QUESTION —
   * and the only thing that answers it is the broker-book sweep, which is
   * armed inside the xts branch alone (simulate has no broker whose book could
   * be the truth). Parking a tranche there with nothing to settle it leaves the
   * desk order non-terminal FOREVER: never filled, never failed, never
   * re-placed, blocking the tag on a paper run for the rest of the session.
   *
   * Without a sweep the old rule is the right one and stays: a guess that
   * un-books a simulated position is cheap, and a paper order that hangs
   * forever is not.
   */
  const out = partitionInterruptedTranches(
    ['o1.1', 'o1.2'],
    new Map([['o1.1', acked('111')], ['o1.2', submitted]]),
    false,
  )
  assert.deepEqual(out.brokerOrderIds, ['111'])
  assert.deepEqual(out.failedTrancheIds, ['o1.2'], 'nothing exists that could ever settle it')
  assert.deepEqual(out.ambiguousTrancheIds, [], 'ambiguity with no sweep is a permanent hang')
})

test('with no sweep, the OTHER answers are unchanged — only ambiguity moves', () => {
  // The flag must not turn into a second classification. ACKed is still ACKed,
  // never-journalled is still failed, and a broker refusal is still terminal.
  const out = partitionInterruptedTranches(
    ['o1.1', 'o1.2', 'o1.3'],
    new Map([['o1.1', acked('111')], ['o1.3', refused]]),
    false,
  )
  assert.deepEqual(out.brokerOrderIds, ['111'])
  assert.deepEqual(out.failedTrancheIds, ['o1.2', 'o1.3'])
  assert.deepEqual(out.ambiguousTrancheIds, [])
})

test('a SUBMITTED tranche the broker REFUSED stays failed — that is not ambiguity', () => {
  // The journal carries a terminal FAILED for it: the broker itself answered,
  // so no order update will ever arrive and the aggregate must know it is done.
  const out = partitionInterruptedTranches(['o1.1', 'o1.2'], new Map([['o1.2', refused]]), true)
  assert.deepEqual(out.brokerOrderIds, [])
  assert.deepEqual(out.failedTrancheIds, ['o1.1', 'o1.2'])
  assert.deepEqual(out.ambiguousTrancheIds, [])
})

test('a tranche whose FAILED line is itself an UNKNOWN is ambiguous, not failed', () => {
  // `placeOne` journals a transport unknown as FAILED/errorClass:'unknown' and
  // holds it ambiguous. A recovery pass re-reading that history must reach the
  // same conclusion, or a crash between the two would harden an unknown into a
  // failure the broker never gave us.
  const out = partitionInterruptedTranches(
    ['o1.1'],
    new Map([['o1.1', { submitted: true, failed: false }]]),
    true,
  )
  assert.deepEqual(out.ambiguousTrancheIds, ['o1.1'])
  assert.deepEqual(out.failedTrancheIds, [])
})

test('the partition covers every planned tranche exactly once', () => {
  // The fill watcher decides completion from trancheIds vs failedTrancheIds; a
  // tranche in none of the three sets is one the aggregate waits on forever,
  // and one in two of them is counted twice.
  const planned = ['a.1', 'a.2', 'a.3', 'a.4']
  const out = partitionInterruptedTranches(
    planned,
    new Map([['a.2', acked('9')], ['a.3', submitted], ['a.4', acked('10')]]),
    true,
  )
  assert.deepEqual(out.failedTrancheIds, ['a.1'])
  assert.deepEqual(out.ambiguousTrancheIds, ['a.3'])
  assert.equal(
    out.brokerOrderIds.length + out.failedTrancheIds.length + out.ambiguousTrancheIds.length,
    planned.length,
  )
})

test('a journal entry for a tranche this plan does not contain is ignored', () => {
  // Tranche ids are deterministic, but a freeze-limit change between attempts
  // re-splits the order. Only the tranches the CURRENT plan names may be
  // reported, or markPlaced records ids the watcher cannot account for.
  const out = partitionInterruptedTranches(
    ['o1.1'],
    new Map([['o1.1', acked('5')], ['o1.2', acked('6')]]),
    true,
  )
  assert.deepEqual(out.brokerOrderIds, ['5'])
  assert.deepEqual(out.failedTrancheIds, [])
  assert.deepEqual(out.ambiguousTrancheIds, [])
})

// ------------------------------------------------ reading one tranche's journal

/**
 * The classification the recovery path feeds the partition. Pure, so the rule
 * that a transport `unknown` is not a broker refusal is provable without a
 * Mongo behind it.
 */

test('no journal entry at all is null — the one provably never-placed case', () => {
  assert.equal(readTrancheJournal([]), null)
})

test('an ACK is read with its broker id', () => {
  const state = readTrancheJournal([
    { phase: 'SUBMITTED' },
    { phase: 'ACK', brokerOrderId: '2100000012345' },
  ])
  assert.equal(state?.brokerOrderId, '2100000012345')
  assert.equal(state?.submitted, true)
  assert.equal(state?.failed, false)
})

test('a SUBMITTED line with nothing after it is submitted and not failed', () => {
  const state = readTrancheJournal([{ phase: 'SUBMITTED' }])
  assert.equal(state?.brokerOrderId, undefined)
  assert.equal(state?.submitted, true)
  assert.equal(state?.failed, false)
})

test("a FAILED line the broker gave us is a failure", () => {
  const state = readTrancheJournal([
    { phase: 'SUBMITTED' },
    { phase: 'FAILED', errorClass: 'fatal', error: 'insufficient margin' },
  ])
  assert.equal(state?.failed, true)
})

test('a FAILED line classed UNKNOWN is not a failure — it is the ambiguous one', () => {
  // `placeOne` journals a transport timeout exactly like this and holds the
  // tranche ambiguous. A recovery pass must reach the same conclusion, or a
  // crash between the two would harden it into a rejection nobody made.
  const state = readTrancheJournal([
    { phase: 'SUBMITTED' },
    { phase: 'FAILED', errorClass: 'unknown', error: 'socket hang up' },
  ])
  assert.equal(state?.failed, false)
  assert.equal(state?.submitted, true)
})

test('an ACK that arrived after a transport unknown still wins', () => {
  // Both lines exist (the retry answered late). It is at the broker, named.
  const state = readTrancheJournal([
    { phase: 'SUBMITTED' },
    { phase: 'FAILED', errorClass: 'unknown' },
    { phase: 'ACK', brokerOrderId: '77' },
  ])
  assert.equal(state?.brokerOrderId, '77')
})

/**
 * THE REFUSAL THAT WAS NEVER WRITTEN DOWN (WP-Q).
 *
 * Six sites refused an order by hand — journal the reason, mark the document
 * INVALID, log it — and the recovery path's "no longer plans" refusal only did
 * two of the three: it marked and it logged, and it wrote NOTHING to
 * `desk-order-events`. That is the one refusal an operator is most likely to be
 * hunting for (an order interrupted mid-placement that then stopped planning,
 * so a tranche may already be live at the broker), and it was missing from the
 * failures feed the dashboard is read on — visible only in a process log on a
 * box nobody watches, which is the exact failure `journal.ts` exists to end.
 *
 * Deduplicating the block into `refuse` fixes it by construction. This pins the
 * fix with the arguments `recoverInterrupted` actually passes, so the site
 * cannot quietly lose its journal line again.
 */
test('the recovery-path INVALID refusal is journalled, not only marked and logged', async () => {
  const events: OrderEvent[] = []
  const marked: { clientOrderId: string; reason: string }[] = []
  const logs: string[] = []
  const refuseOrder = refuse({
    journal: {
      record: async (event) => {
        events.push(event)
      },
    },
    queue: {
      markInvalid: async (clientOrderId, reason) => {
        marked.push({ clientOrderId, reason })
      },
    },
    log: (msg) => logs.push(msg),
  })

  // Exactly what `recoverInterrupted` passes when `buildPlan` rejects a replan.
  const rejected = 'contract BANKNIFTY26JUL57000CE is not in the instrument master'
  await refuseOrder({
    clientOrderId: 'D1',
    tag: 'ORB_SCALP_BN',
    tradingsymbol: 'BANKNIFTY26JUL57000CE',
    reason: `interrupted placement no longer plans: ${rejected}`,
    phase: 'INVALID',
    label: 'RECOVERY INVALID',
    logReason: rejected,
  })

  assert.equal(events.length, 1, 'the refusal reaches the journal')
  const [event] = events
  assert.equal(event?.phase, 'INVALID')
  assert.equal(event?.ok, false, 'it belongs in the failures feed')
  assert.equal(event?.tag, 'ORB_SCALP_BN')
  assert.equal(event?.tradingsymbol, 'BANKNIFTY26JUL57000CE')
  assert.equal(event?.error, `interrupted placement no longer plans: ${rejected}`)
  // The queue document carries the SAME reason the journal does: "why is this
  // order INVALID" and "what does the journal say" must not answer differently.
  assert.deepEqual(marked, [
    { clientOrderId: 'D1', reason: `interrupted placement no longer plans: ${rejected}` },
  ])
  // The log line is unchanged by the dedup — the label already says recovery, so
  // it still carries the bare planner message.
  assert.deepEqual(logs, [`RECOVERY INVALID BANKNIFTY26JUL57000CE [D1]: ${rejected}`])
})
