/**
 * The words, pinned.
 *
 * Two kinds of string on this desk are not implementation detail: the sentence
 * an operator reads before real money can move, and the sentence a refusal
 * arrives in. Both used to be written out once per page, and the copies had
 * already drifted — one refusal had lost "Nothing was applied", one had no 409
 * branch at all, and the Books page's live warning carried a comment admitting
 * it followed the Strategies page's rule by hand.
 *
 * They now have one home each. These assertions are what stops a later edit
 * from quietly re-introducing a second version: a confirmation prompt that no
 * longer describes what the button does is worse than no prompt, because it
 * teaches an operator to skim the next one.
 */
import { expect, test, describe } from 'vitest'
import { ApiError, explain } from '../src/api.ts'
import { BULK_LIVE_STATEMENT, liveStatement, liveStartStatement } from '../src/live-copy.ts'

describe('explain', () => {
  test('a 409 says nothing was applied, and to go and look', () => {
    expect(explain(new ApiError(409, 'the row changed under you'))).toBe(
      'the row changed under you. Nothing was applied. Reload and look at the ' +
        'current state before trying again.',
    )
  })

  /**
   * ONE WORDING FOR ALL THREE PAGES. The Books page's copy dropped "Nothing was
   * applied", and the since-deleted create wizard had no 409 branch at all — it
   * told the operator only that the row had moved, leaving them to wonder
   * whether half a book had been written.
   */
  test('every caller gets the same 409 sentence', () => {
    const err = new ApiError(409, 'conflict')
    expect(explain(err)).toBe(explain(err))
    expect(explain(err)).toContain('Nothing was applied')
  })

  test('any other failure is the server\'s own sentence, unadorned', () => {
    expect(explain(new ApiError(422, 'qty must be a multiple of the lot size'))).toBe(
      'qty must be a multiple of the lot size',
    )
    expect(explain(new Error('the bridge is down'))).toBe('the bridge is down')
  })

  /** A thrown non-Error must still render as something, never "[object Object]"-by-crash. */
  test('a non-Error is stringified rather than dropped', () => {
    expect(explain('plain string')).toBe('plain string')
  })
})

describe('live warnings', () => {
  /**
   * Each names the scope, says LIVE, and says what keeps happening afterwards.
   * That last clause is the one that gets lost when these are rewritten from
   * memory, and it is the one that matters — these switches stay armed.
   */
  test('a single strategy names its tag and says the routing continues', () => {
    expect(liveStatement('BHEL-BREAKOUT')).toBe(
      'Orders from BHEL-BREAKOUT will route to the LIVE broker account and move real money. ' +
        'They keep routing until you switch this row off again.',
    )
  })

  test('a bulk switch says EVERY, and that each one keeps routing', () => {
    expect(BULK_LIVE_STATEMENT).toBe(
      'EVERY strategy added to LIVE will be switched on at once. Each one that signals ' +
        'will route to the live broker account and move real money, and they keep routing ' +
        'until you switch them off again.',
    )
  })

  /** A book hands over decision-making, not one order — the sentence says so. */
  test('starting a book names its tag and the authority being handed over', () => {
    expect(liveStartStatement('BHEL')).toBe(
      'BHEL will begin making its own decisions against the LIVE broker account and can ' +
        'route real orders from its next poll. It keeps running until you stop it again.',
    )
  })

  test('all three state the rail as LIVE and that it does not stop on its own', () => {
    for (const s of [liveStatement('X'), BULK_LIVE_STATEMENT, liveStartStatement('X')]) {
      expect(s).toMatch(/LIVE|live broker/)
      expect(s).toMatch(/keep routing|keeps running/)
    }
  })
})
