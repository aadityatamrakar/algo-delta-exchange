/**
 * The routing kit's own helpers.
 *
 * Small functions, but every route in the system runs through `suffixOf` before
 * it does anything else — so a throw here is a 500 on a request that was merely
 * malformed, on any endpoint that takes an id in its path (audit F-53).
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { BadRequest, suffixOf } from '../src/routes/kit.ts'

test('suffixOf decodes a percent-escaped path segment', () => {
  assert.equal(suffixOf('/v1/desk/strategies/NIFTY%20A', '/v1/desk/strategies/'), 'NIFTY A')
  assert.equal(suffixOf('/v1/desk/strategies/PLAIN', '/v1/desk/strategies/'), 'PLAIN')
})

test('suffixOf returns null when the path is not under the prefix, or is exactly it', () => {
  assert.equal(suffixOf('/v1/desk/books/X', '/v1/desk/strategies/'), null)
  assert.equal(suffixOf('/v1/desk/strategies/', '/v1/desk/strategies/'), null)
})

test('a malformed percent-escape is a 400, not a 500', () => {
  /**
   * `decodeURIComponent('%E0%A4%A')` throws `URIError`. Unguarded, that escaped
   * the route and left the dispatcher's `catch` with something it did not
   * recognise — so a caller that typo'd an id got a 500 and the bridge logged an
   * internal error for a request that was simply not well-formed.
   *
   * `BadRequest` is the shape `server.ts` turns into `400 {error}`, which is why
   * the assertion is on the class rather than on a status code: the mapping is
   * the dispatcher's, and it is already tested there.
   */
  assert.throws(
    () => suffixOf('/v1/desk/strategies/%E0%A4%A', '/v1/desk/strategies/'),
    (err: unknown) => err instanceof BadRequest && /escape/i.test((err as Error).message),
  )
  assert.throws(() => suffixOf('/v1/desk/broker/orders/%', '/v1/desk/broker/orders/'), BadRequest)
})

test('the refusal names the segment it could not decode, so the client log shows the typo', () => {
  try {
    suffixOf('/v1/desk/chain/%ZZ', '/v1/desk/chain/')
    assert.fail('expected a BadRequest')
  } catch (err) {
    assert.ok(err instanceof BadRequest)
    assert.match(err.message, /%ZZ/)
  }
})
