import assert from 'node:assert/strict'
import test from 'node:test'

import { basketOrders } from '../src/book-margin/basket.ts'
import { createKiteMarginClient, parseBasketReply } from '../src/book-margin/kite.ts'
import { refreshBookMargin } from '../src/book-margin/refresh.ts'
import { createDebouncer, dueSlot, istMinuteOfDay } from '../src/book-margin/schedule.ts'
import type { BridgeLeg } from '../../api/src/contract.ts'

function leg(tradingsymbol: string, qty: number): BridgeLeg {
  return {
    deskTag: tradingsymbol,
    instrument: { tradingsymbol, lotSize: 950, tickSize: 0.05, exchange: 'NFO' },
    underlying: 'DLF',
    expiry: '2026-08-25',
    strike: 650,
    type: 'PE',
    side: qty > 0 ? 'Buy' : 'Sell',
    qty,
    entryPrice: 16.5,
    openedTs: 0,
  }
}

// --- basket -----------------------------------------------------------------

test('a short leg becomes SELL with a positive quantity', () => {
  const [o] = basketOrders([leg('DLF26AUG650PE', -4750)])
  assert.equal(o?.transaction_type, 'SELL')
  assert.equal(o?.quantity, 4750)
})

test('a long leg becomes BUY', () => {
  const [o] = basketOrders([leg('DLF26AUG600PE', 4750)])
  assert.equal(o?.transaction_type, 'BUY')
  assert.equal(o?.quantity, 4750)
})

test('quantity is units, NOT multiplied by lot size', () => {
  // The regression this guards: 4750 is already 5 lots x 950. Multiplying again
  // would ask Kite to price 45 lakh shares and return a margin ~950x too large.
  const [o] = basketOrders([leg('DLF26AUG650PE', -4750)])
  assert.equal(o?.quantity, 4750)
})

test('zero-qty legs are dropped rather than sent', () => {
  // Kite rejects a zero quantity for the WHOLE basket, so one closed leg left
  // in the book would cost every other leg its margin figure.
  assert.equal(basketOrders([leg('A', 0), leg('B', -50)]).length, 1)
})

test('the leg carries its own exchange', () => {
  assert.equal(basketOrders([leg('DLF26AUG650PE', -4750)])[0]?.exchange, 'NFO')
})

// --- reply parsing ----------------------------------------------------------

/**
 * A REAL recorded reply for the live DLF book, 2026-08-04. The operator's own
 * Kite calculator showed span 2,16,553 / exposure 2,22,293 for the same book;
 * these are the same figures minutes later.
 */
const RECORDED = {
  status: 'success',
  data: {
    initial: { span: 592895, exposure: 219624.5625, option_premium: 34675, total: 847194.5625 },
    final: { span: 226004.5, exposure: 219624.5625, option_premium: -128012.5, total: 317616.5625 },
    orders: [
      { tradingsymbol: 'DLF26AUG650PE', span: 458565, exposure: 110215, total: 568780 },
      { tradingsymbol: 'DLF26AUG600PE', span: 0, exposure: 0, total: 18762 },
    ],
  },
}

test('parses `final`, never `initial`', () => {
  // THE load-bearing assertion. `initial.span` is 5,92,895 — 2.6x larger and
  // pre-hedge-benefit. Reading it would restate the very bug this feature fixes.
  const q = parseBasketReply(RECORDED)
  assert.equal(q.span, 226004.5)
  assert.notEqual(q.span, 592895)
})

test('total is span + exposure, matching the calculator "Total margin"', () => {
  assert.equal(parseBasketReply(RECORDED).total, 226004.5 + 219624.5625)
})

test('premiumPaid is the long-leg debit from `initial`, not net premium', () => {
  // The one field read from `initial`. The XTS account BLOCKS this — MarginUsed
  // reconciled to span+exposure+premiumPaid exactly — while Zerodha's
  // calculator itemises it separately and leaves it out of "Total margin". A
  // tile built on `total` alone understates the real requirement.
  const q = parseBasketReply(RECORDED)
  assert.equal(q.premiumPaid, 34675)
  assert.notEqual(q.premiumPaid, q.premium)
})

test('premiumPaid is 0, never negative, when `initial` is absent', () => {
  assert.equal(parseBasketReply({ data: { final: { span: 1, exposure: 2, option_premium: -9 } } }).premiumPaid, 0)
})

test('premium received is reported positive', () => {
  // Kite reports it from the account side (negative = received); the desk reads
  // "premium received" as a credit.
  assert.equal(parseBasketReply(RECORDED).premium, 128012.5)
})

test('a reply with no `final` block throws rather than reporting zero margin', () => {
  // A silent 0 would render as "this book is free to hold".
  assert.throws(() => parseBasketReply({ data: { initial: {} } }))
})

// --- schedule ---------------------------------------------------------------

test('istMinuteOfDay converts UTC to IST wall clock', () => {
  // 2026-08-04T04:00:00Z is 09:30 IST.
  assert.equal(istMinuteOfDay(Date.parse('2026-08-04T04:00:00Z')), 9 * 60 + 30)
})

test('a slot fires once and not again the same day', () => {
  const state = { lastFired: 0 }
  const at = (iso: string): number | null => dueSlot(Date.parse(iso), ['11:05'], state)
  assert.equal(at('2026-08-04T05:36:00Z'), 11 * 60 + 5) // 11:06 IST — due
  assert.equal(at('2026-08-04T05:40:00Z'), null) // already fired today
})

test('a missed slot is skipped, not queued', () => {
  // A process starting at 15:00 IST must not fire four backdated refreshes.
  const state = { lastFired: 0 }
  const due = dueSlot(Date.parse('2026-08-04T09:30:00Z'), ['09:10', '11:05', '12:35', '14:05'], state)
  assert.equal(due, null) // 15:00 IST is past every slot's grace window
})

test('the latest due slot wins when two are within grace', () => {
  const state = { lastFired: 0 }
  const due = dueSlot(Date.parse('2026-08-04T05:36:00Z'), ['11:00', '11:05'], state, 20)
  assert.equal(due, 11 * 60 + 5)
})

test('a burst of bumps collapses into one run', async () => {
  let runs = 0
  const d = createDebouncer(10, () => { runs += 1 })
  d.bump('TAG'); d.bump('TAG'); d.bump('TAG'); d.bump('TAG')
  await new Promise((r) => setTimeout(r, 40))
  assert.equal(runs, 1)
})

// --- refresh ----------------------------------------------------------------

function fakeStore(): { calls: { filter: unknown; update: Record<string, unknown> }[]; updateOne: (f: { _id: string }, u: Record<string, unknown>, o: { upsert: boolean }) => Promise<unknown> } {
  const calls: { filter: unknown; update: Record<string, unknown> }[] = []
  return {
    calls,
    updateOne: async (filter, update) => {
      calls.push({ filter, update })
      return null
    },
  }
}

test('a successful refresh writes the figures and asOf', async () => {
  const store = fakeStore()
  const ok = await refreshBookMargin(
    { store, client: { basketMargin: async () => parseBasketReply(RECORDED) }, now: () => 1000, log: () => {} },
    'DLF-TAG',
    [leg('DLF26AUG650PE', -4750)],
  )
  assert.equal(ok, true)
  const set = store.calls[0]?.update['$set'] as Record<string, unknown>
  assert.equal(set['total'], 226004.5 + 219624.5625)
  assert.equal(set['asOf'], 1000)
  assert.equal(set['ok'], true)
})

test('a FAILED refresh never overwrites the figures or asOf', async () => {
  // The guarantee that keeps a stale number honest: on failure the tile must
  // AGE, not silently keep presenting the old figure as current, and not blank.
  const store = fakeStore()
  const ok = await refreshBookMargin(
    {
      store,
      client: { basketMargin: async () => { throw new Error('enctoken expired') } },
      now: () => 2000,
      log: () => {},
    },
    'DLF-TAG',
    [leg('DLF26AUG650PE', -4750)],
  )
  assert.equal(ok, false)
  const update = store.calls[0]?.update ?? {}
  const set = update['$set'] as Record<string, unknown>
  assert.deepEqual(Object.keys(set).sort(), ['diagnostic', 'ok'])
  assert.equal(set['ok'], false)
  assert.match(String(set['diagnostic']), /enctoken expired/)
  assert.equal('asOf' in set, false)
  assert.equal('total' in set, false)
})

test('a flat book publishes zero rather than leaving a stale figure', async () => {
  const store = fakeStore()
  await refreshBookMargin(
    { store, client: { basketMargin: async () => { throw new Error('should not be called') } }, now: () => 3000, log: () => {} },
    'FLAT',
    [],
  )
  const set = store.calls[0]?.update['$set'] as Record<string, unknown>
  assert.equal(set['total'], 0)
  assert.equal(set['ok'], true)
})

// ---------------------------------------------------- enctoken re-login
//
// THE 2026-08-05 OUTAGE. The margin tile went stale for a whole session while
// the price feed stayed perfectly healthy: every basket call returned
// `403 TokenException`, and nothing ever rotated the token.
//
// The cause is a real asymmetry, documented on `KiteFeedPool.reconnect`: an
// established websocket SURVIVES its enctoken being invalidated. So the feed
// kept streaming, `FeedRecovery` — which triggers on feed death — never fired,
// and the REST call was left holding a token only it could tell was dead.
//
// A live feed is therefore NOT evidence of a live session, and the REST path
// needs its own way to say "this token is gone".

/**
 * A `fetch` stand-in that replays queued responses and RECORDS what was sent.
 *
 * The requests are kept, not discarded, because they carry the invariants that
 * have no other guard: the pinned `kite.zerodha.com/oms` host (`api.kite.trade`
 * is a measured 400), `consider_positions=false` (the file header calls it
 * DELIBERATE AND MUST STAY), and the `authorization: enctoken …` header — whose
 * VALUE is the whole point of the retry path below.
 */
function fetchStub(replies: readonly { status: number; body: string }[]): {
  impl: typeof fetch
  calls: () => number
  sent: () => readonly { url: string; headers: Record<string, string>; body: string }[]
} {
  let i = 0
  const sent: { url: string; headers: Record<string, string>; body: string }[] = []
  const impl = (async (url: string, init: RequestInit) => {
    const r = replies[Math.min(i, replies.length - 1)] as { status: number; body: string }
    i++
    sent.push({
      url: String(url),
      headers: (init.headers ?? {}) as Record<string, string>,
      body: String(init.body ?? ''),
    })
    return {
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      text: async () => r.body,
    }
  }) as unknown as typeof fetch
  return { impl, calls: () => i, sent: () => sent }
}

const TOKEN_403 = {
  status: 403,
  body: '{"status":"error","message":"Incorrect `api_key` or `access_token`.","data":null,"error_type":"TokenException"}',
}
/** The SAME condition as a 401 — the OMS has been seen answering both ways. */
const TOKEN_401 = { status: 401, body: '{"status":"error","message":"unauthorised"}' }
/** A 403 that says the session is gone WITHOUT the exact `TokenException` wording. */
const SESSION_403 = {
  status: 403,
  body: '{"status":"error","message":"Invalid session token","error_type":"SessionException"}',
}
/** A 403 that is NOT about the token: no login on earth fixes an entitlement. */
const PERMISSION_403 = {
  status: 403,
  body: '{"status":"error","message":"This app is not allowed","error_type":"PermissionException"}',
}
const GOOD = { status: 200, body: JSON.stringify(RECORDED) }

const ORDERS = basketOrders([leg('DLF26AUG650PE', -4750)])

test('the request itself: pinned host, consider_positions=false, enctoken header', async () => {
  const { impl, sent } = fetchStub([GOOD])
  const client = createKiteMarginClient({ enctoken: () => 'tok-1', fetchImpl: impl })
  await client.basketMargin(ORDERS)
  const req = sent()[0]
  assert.ok(req !== undefined)
  assert.equal(req.url, 'https://kite.zerodha.com/oms/margins/basket?consider_positions=false')
  assert.equal(req.headers['authorization'], 'enctoken tok-1')
  assert.equal(req.headers['x-kite-version'], '3')
  assert.equal(req.headers['content-type'], 'application/json')
})

test('a TokenException re-logs-in and retries ONCE, and the retry answers', async () => {
  const { impl, calls } = fetchStub([TOKEN_403, GOOD])
  let recovered = 0
  const client = createKiteMarginClient({
    enctoken: () => 'dead-then-fresh',
    fetchImpl: impl,
    onAuthFailure: async () => {
      recovered++
      return true
    },
  })
  const q = await client.basketMargin(ORDERS)
  assert.equal(recovered, 1, 'the dead token must trigger exactly one re-login')
  assert.equal(calls(), 2, 'one original call, one retry — never a loop')
  assert.equal(q.total, 226004.5 + 219624.5625)
})

test('the RETRY sends the ROTATED token, not the one that was just rejected', async () => {
  /**
   * The point of the whole path, and the one thing call counts cannot show.
   * Reverting the token read to the top of `basketMargin` — where it used to
   * be — leaves every other test in this file green while the retry re-sends
   * the dead enctoken for a guaranteed second 403.
   */
  const { impl, sent } = fetchStub([TOKEN_403, GOOD])
  let token = 'dead'
  const client = createKiteMarginClient({
    enctoken: () => token,
    fetchImpl: impl,
    onAuthFailure: async () => {
      token = 'fresh'
      return true
    },
  })
  await client.basketMargin(ORDERS)
  assert.deepEqual(
    sent().map((r) => r.headers['authorization']),
    ['enctoken dead', 'enctoken fresh'],
    'the retry must read the token AFTER the re-login, not before it',
  )
})

test('a 401 counts as a token rejection even with nothing in the body', async () => {
  // Belt and braces on purpose: the OMS is inconsistent about which signal it
  // uses, and this arm is what keeps the fix working when it switches.
  const { impl, calls } = fetchStub([TOKEN_401, GOOD])
  let recovered = 0
  const client = createKiteMarginClient({
    enctoken: () => 't',
    fetchImpl: impl,
    onAuthFailure: async () => {
      recovered++
      return true
    },
  })
  await client.basketMargin(ORDERS)
  assert.equal(recovered, 1)
  assert.equal(calls(), 2)
})

test('a body naming TokenException counts, whatever the status', async () => {
  const { impl, calls } = fetchStub([{ status: 500, body: '{"error_type":"TokenException"}' }, GOOD])
  let recovered = 0
  const client = createKiteMarginClient({
    enctoken: () => 't',
    fetchImpl: impl,
    onAuthFailure: async () => {
      recovered++
      return true
    },
  })
  await client.basketMargin(ORDERS)
  assert.equal(recovered, 1, 'the body arm must stand on its own')
  assert.equal(calls(), 2)
})

test('a 403 that NAMES the token counts, even without the exact TokenException wording', async () => {
  /**
   * Audit F-13. The match used to be `401 || body.includes('TokenException')`,
   * so a 403 whose body said the session was gone in any other words — the OMS
   * has been seen answering `SessionException`, and a WEB host answers a dead
   * session with an HTML login page — went to the "not an auth problem" arm.
   * Nothing then rotated the token and the tile aged for the rest of the
   * session while the feed looked perfectly healthy.
   */
  const { impl, calls } = fetchStub([SESSION_403, GOOD])
  let recovered = 0
  const client = createKiteMarginClient({
    enctoken: () => 't',
    fetchImpl: impl,
    onAuthFailure: async () => {
      recovered++
      return true
    },
  })
  await client.basketMargin(ORDERS)
  assert.equal(recovered, 1)
  assert.equal(calls(), 2)
})

test('a 403 that is NOT about the token burns no login', async () => {
  /**
   * `PermissionException` is an entitlement, not a session: `checkSession`
   * would find the cookie jar healthy, hand back the SAME enctoken, and the
   * retry would earn an identical 403 — forever, once per book per sweep.
   */
  const { impl, calls } = fetchStub([PERMISSION_403, GOOD])
  let recovered = 0
  const client = createKiteMarginClient({
    enctoken: () => 't',
    fetchImpl: impl,
    onAuthFailure: async () => {
      recovered++
      return true
    },
  })
  await assert.rejects(() => client.basketMargin(ORDERS), /403/)
  assert.equal(recovered, 0)
  assert.equal(calls(), 1)
})

test('an ENTITLEMENT 403 that MENTIONS a token still burns no login', async () => {
  /**
   * THE WIDENING DEFECT. `403 && /token/i` reads any 403 whose body happens to
   * contain the word as session death — and an entitlement refusal often does
   * ("access_token is not permitted on this route"). `checkSession` then finds
   * the cookie jar healthy, hands back the SAME enctoken, and the next sweep
   * earns an identical 403: a real password+TOTP login per book per sweep, for
   * as long as the entitlement problem lasts, against a live trading account.
   */
  const { impl, calls } = fetchStub([
    {
      status: 403,
      body: '{"status":"error","message":"your access_token is not permitted on this route","error_type":"PermissionException"}',
    },
    GOOD,
  ])
  let recovered = 0
  const client = createKiteMarginClient({
    enctoken: () => 't',
    fetchImpl: impl,
    onAuthFailure: async () => {
      recovered++
      return true
    },
  })
  await assert.rejects(() => client.basketMargin(ORDERS), /403/)
  assert.equal(recovered, 0, 'no login can fix an entitlement')
  assert.equal(calls(), 1)
})

test('a NON-auth failure does not re-login and does not retry', async () => {
  // A 500 is Zerodha having a bad minute. Burning a real password+TOTP login
  // on it would hammer a live trading account for nothing.
  const { impl, calls } = fetchStub([{ status: 500, body: 'upstream boom' }])
  let recovered = 0
  const client = createKiteMarginClient({
    enctoken: () => 't',
    fetchImpl: impl,
    onAuthFailure: async () => {
      recovered++
      return true
    },
  })
  await assert.rejects(() => client.basketMargin(ORDERS), /500/)
  assert.equal(recovered, 0)
  assert.equal(calls(), 1)
})

test('a recovery that did NOT rotate the token is not retried against', async () => {
  /**
   * `FeedRecovery.trigger` resolves without logging in whenever its backoff is
   * shut or the login failed. Retrying on that re-sends the token that was
   * just rejected, and the error would then blame a re-login that never
   * happened — the sentence an operator reads off the tile's `diagnostic`.
   */
  const { impl, calls } = fetchStub([TOKEN_403, GOOD])
  const client = createKiteMarginClient({
    enctoken: () => 't',
    fetchImpl: impl,
    onAuthFailure: async () => false,
  })
  await assert.rejects(() => client.basketMargin(ORDERS), /NO fresh login was available/)
  assert.equal(calls(), 1, 'no rotation, no retry')
})

test('a retry that fails again throws, rather than retrying forever', async () => {
  const { impl, calls } = fetchStub([TOKEN_403, TOKEN_403, GOOD])
  const client = createKiteMarginClient({
    enctoken: () => 't',
    fetchImpl: impl,
    onAuthFailure: async () => true,
  })
  await assert.rejects(() => client.basketMargin(ORDERS), /403 after re-login/)
  // Two attempts, NOT three: a fresh token rejected again means the new
  // session was killed too, and the next slot will try again.
  assert.equal(calls(), 2)
})

test('a 2xx HTML login PAGE is a dead session, and is recovered from', async () => {
  /**
   * `kite.zerodha.com` is the WEB host and a web host answers a dead session
   * with a login PAGE. Before this, `JSON.parse` threw a SyntaxError straight
   * out of the client, so `isTokenRejection` never ran and the tile's
   * diagnostic blamed JSON for a token problem.
   *
   * IT IS ALSO A TOKEN FAULT, which this used to assert the opposite of. The
   * body reached the classifier and the classifier said "no token named here"
   * — so the one disguise the file's own docstring names as the dead-session
   * reply was the one shape that could not trigger a re-login.
   */
  const { impl, calls } = fetchStub([
    { status: 200, body: '<!doctype html><title>Kite</title>' },
    GOOD,
  ])
  let recovered = 0
  const client = createKiteMarginClient({
    enctoken: () => 't',
    fetchImpl: impl,
    onAuthFailure: async () => {
      recovered++
      return true
    },
  })
  const quote = await client.basketMargin(ORDERS)
  assert.ok(quote.span > 0)
  assert.equal(recovered, 1, 'the login page IS the dead session announcing itself')
  assert.equal(calls(), 2)
})

test('an HTML page carrying a 5xx is an upstream error page, not a login page', async () => {
  // A proxy's own error page mentions no session, and no login fixes a bad
  // minute at Zerodha. Re-logging in on those is the login storm the narrow
  // half of the classifier exists to prevent.
  const { impl, calls } = fetchStub([{ status: 502, body: '<html><body>502 Bad Gateway</body></html>' }])
  let recovered = 0
  const client = createKiteMarginClient({
    enctoken: () => 't',
    fetchImpl: impl,
    onAuthFailure: async () => {
      recovered++
      return true
    },
  })
  await assert.rejects(() => client.basketMargin(ORDERS), /502/)
  assert.equal(recovered, 0)
  assert.equal(calls(), 1)
})

test('a successful call reports the token as accepted', async () => {
  // The only proof a session is live: recovery cannot otherwise tell a
  // rotation that worked from one killed a second later by another login.
  const { impl } = fetchStub([GOOD])
  let accepted = 0
  const client = createKiteMarginClient({
    enctoken: () => 't',
    fetchImpl: impl,
    onTokenAccepted: () => {
      accepted++
    },
  })
  await client.basketMargin(ORDERS)
  assert.equal(accepted, 1)
})

test('with no onAuthFailure wired, a 403 behaves exactly as before', async () => {
  const { impl, calls } = fetchStub([TOKEN_403, GOOD])
  const client = createKiteMarginClient({ enctoken: () => 't', fetchImpl: impl })
  await assert.rejects(() => client.basketMargin(ORDERS), /403/)
  assert.equal(calls(), 1, 'no callback, no retry')
})
