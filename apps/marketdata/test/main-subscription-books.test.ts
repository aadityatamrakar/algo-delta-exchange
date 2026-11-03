/**
 * The books -> `planSubscriptions` input mapping, in isolation.
 *
 * `planSubscriptions` itself already honours a book-level `expiry`
 * (`book.expiry ?? book.legs[0]?.expiry` — see `subscription-source.ts`). The
 * defect is at the CALLER in `main.ts`: it used to map a stored book to
 * `{symbol, legs}` and never passed `expiry` through at all, so the fallback
 * to `legs[0]?.expiry` was the ONLY path. That is silently fine for a book
 * that already has legs, and silently fatal for a FLAT one — which is every
 * book the phase-2 registry creates. No legs means no expiry means no chain
 * subscribed means the desk can never open its first leg.
 *
 * `subscriptionBooks` is the extracted pure mapping, so this is testable
 * without booting the feed host (no Mongo, no Kite login, no bus).
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { subscriptionBooks, registrySubscriptionBooks } from '../src/main.ts'
import type { StoredBook } from '../../api/src/store.ts'
import type { BookRow } from '../../api/src/books-registry.ts'
import { DEFAULT_BOOK } from '../../api/src/books-registry.ts'
import type { BridgeLeg } from '../../api/src/contract.ts'

const SYMBOL = 'BHEL'
const EXPIRY = '2026-08-25'

function leg(strike: number): BridgeLeg {
  return {
    deskTag: `CE${strike}#1`,
    instrument: {
      tradingsymbol: `BHEL26AUG${strike}CE`,
      exchange: 'NFO',
      instrumentToken: 700000 + strike,
      lotSize: 2625,
      tickSize: 0.05,
    },
    underlying: SYMBOL,
    expiry: EXPIRY,
    strike,
    type: 'CE',
    side: 'Sell',
    qty: -2625,
    entryPrice: 12.5,
    openedTs: Date.now(),
  }
}

function book(overrides: Partial<StoredBook>): StoredBook {
  return {
    tag: 'desk#1',
    symbol: SYMBOL,
    expiry: EXPIRY,
    mode: 'paper',
    legs: [],
    updatedAt: Date.now(),
    ...overrides,
  }
}

test('a FLAT book (no legs yet) still carries its expiry through to planSubscriptions', () => {
  // This is the actual defect: every newly-created book is flat, has no
  // legs[0] to infer an expiry from, and without the book-level expiry being
  // passed through here it can never subscribe its chain — so it can never
  // open its first leg.
  const mapped = subscriptionBooks([book({ legs: [] })])
  assert.equal(mapped.length, 1)
  assert.equal(mapped[0]?.expiry, EXPIRY, 'a flat book must resolve its expiry from the book itself')
})

test('a book WITH legs still resolves its expiry (the fallback stays covered)', () => {
  const mapped = subscriptionBooks([book({ legs: [leg(420)] })])
  assert.equal(mapped.length, 1)
  assert.equal(mapped[0]?.expiry, EXPIRY)
})

/**
 * The REGISTERED-BUT-NOT-YET-OPENED book, which is the state the Build screen
 * spends its whole life in.
 *
 * `subscriptionBooks` maps `COLLECTIONS.books` — a StoredBook, which exists
 * only once legs have actually filled. The Build flow registers the book
 * FIRST (a `BookRow` in `COLLECTIONS.booksRegistry`, carrying symbol and
 * expiry and nothing else) and writes the StoredBook LAST, from the fills. So
 * during the one step that needs quotes there is no StoredBook at all, the
 * subscription plan sees an empty book list, the chain is never subscribed,
 * and every strike renders "no quote yet" — you cannot open the position that
 * would create the book that would subscribe the chain.
 */
function registryRow(overrides: Partial<BookRow> = {}): BookRow {
  return {
    ...DEFAULT_BOOK,
    tag: 'BAJFINANCE-2026-08-25-recenter-r',
    symbol: 'BAJFINANCE',
    expiry: '2026-08-25',
    mode: 'paper',
    variant: 'recenter-r',
    series: 'BAJFINANCE-recenter-r',
    ...overrides,
  }
}

test('a REGISTERED book with no position yet still subscribes its chain', () => {
  const mapped = registrySubscriptionBooks([registryRow()])
  assert.equal(mapped.length, 1)
  assert.equal(mapped[0]?.symbol, 'BAJFINANCE')
  assert.equal(
    mapped[0]?.expiry,
    '2026-08-25',
    'a registered book must subscribe its chain before it holds anything — that is the only way its first leg can be priced',
  )
  assert.deepEqual(mapped[0]?.legs, [], 'it holds nothing yet, by definition')
})

test('a registry row with no expiry is dropped rather than subscribing a whole symbol', () => {
  // `expiry: ''` cannot name a chain. Passing it through would have
  // `planSubscriptions` ask the master for strikes on the empty string.
  assert.deepEqual(registrySubscriptionBooks([registryRow({ expiry: '' })]), [])
})
