/**
 * A request that never answers must still fail.
 *
 * A wedged bridge or a dropped NAT mapping leaves the socket open forever: the
 * promise `fetch` returned never settles, so nothing throws, `usePoll` never
 * sets its error, and the dashboard keeps rendering last-good numbers while
 * claiming to be live. That is the one failure the stale-notice machinery
 * exists to surface, and without a deadline on the request it is the one
 * failure it cannot see.
 */
import { afterEach, describe, expect, test, vi } from 'vitest'
import { ApiError, MUTATION_TIMEOUT_MS, REQUEST_TIMEOUT_MS, api } from '../src/api.ts'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('request deadline', () => {
  test('every request carries an abort signal', async () => {
    const fetchSpy = vi.fn(async (_input: string, _init?: RequestInit) => ({
      ok: true,
      status: 200,
      statusText: '200',
      json: async () => ({}),
    } as unknown as Response))
    vi.stubGlobal('fetch', fetchSpy)

    await api.feed()

    const init = fetchSpy.mock.calls[0]?.[1]
    expect(init?.signal).toBeInstanceOf(AbortSignal)
    // Live at call time — a signal already aborted would cancel the request it
    // was meant to bound.
    expect(init?.signal?.aborted).toBe(false)
    expect(REQUEST_TIMEOUT_MS).toBeGreaterThan(0)
  })

  test('a timed-out request surfaces as an ApiError naming the timeout', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new DOMException('The operation timed out.', 'TimeoutError')
    }))

    // Not a raw DOMException: every caller on this dashboard renders failures
    // through `explain`, which only knows how to read an ApiError.
    const err = await api.feed().then(() => null, (e: unknown) => e)
    expect(err).toBeInstanceOf(ApiError)
    expect((err as ApiError).message).toMatch(/no response after/)
    expect((err as ApiError).message).toContain(String(REQUEST_TIMEOUT_MS / 1000))
    expect((err as ApiError).status).toBe(0)
    expect((err as ApiError).reauthRequired).toBe(false)
  })

  test('a real network failure is not relabelled as a timeout', async () => {
    const boom = new TypeError('Failed to fetch')
    vi.stubGlobal('fetch', vi.fn(async () => { throw boom }))

    const err = await api.feed().then(() => null, (e: unknown) => e)
    expect(err).toBe(boom)
  })

  /**
   * THE BODY IS READ UNDER THE SAME SIGNAL as the fetch.
   *
   * `fetch` resolves as soon as the HEADERS arrive; `res.json()` streams the
   * rest, and the deadline keeps running while it does. A response that starts
   * and then stalls therefore aborts inside `json()`, which used to sit outside
   * the try — so the abort escaped as a raw DOMException, `explain` fell through
   * to its message ("signal timed out"), and the one failure this deadline
   * exists to name arrived unnamed.
   */
  test('an abort DURING the body read is still an ApiError, not a raw DOMException', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      status: 200,
      statusText: '200',
      json: async () => {
        throw new DOMException('The operation timed out.', 'TimeoutError')
      },
    } as unknown as Response)))

    const err = await api.feed().then(() => null, (e: unknown) => e)
    expect(err).toBeInstanceOf(ApiError)
    expect((err as ApiError).message).toMatch(/no response after/)
    expect((err as ApiError).status).toBe(0)
  })

  test('a server refusal passes through the timeout catch unchanged', async () => {
    // The `!res.ok` branch now throws from INSIDE the try, so the catch must let
    // an ApiError past rather than swallowing a 409 into a timeout.
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: false,
      status: 409,
      statusText: 'Conflict',
      json: async () => ({ error: 'the row moved' }),
    } as unknown as Response)))

    const err = await api.feed().then(() => null, (e: unknown) => e)
    expect(err).toBeInstanceOf(ApiError)
    expect((err as ApiError).status).toBe(409)
    expect((err as ApiError).message).toBe('the row moved')
  })
})

/**
 * A MUTATION THAT TIMES OUT MAY STILL BE RUNNING.
 *
 * A read that gives up costs a stale screen. A close-all that gives up at 8s
 * while the desk is still routing costs a SECOND full set of reversing orders,
 * because the button re-enables and the retry mints a fresh decisionId — a new
 * id is a new decision, and idempotency cannot save it. So a write gets a much
 * longer rope, and when it does run out the operator is told what the client
 * does NOT know rather than "the desk is not answering".
 */
describe('the mutation deadline', () => {
  test('a write gets a longer deadline than a read', () => {
    expect(MUTATION_TIMEOUT_MS).toBeGreaterThan(REQUEST_TIMEOUT_MS)
  })

  test('a timed-out write warns that it MAY STILL BE EXECUTING', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new DOMException('The operation timed out.', 'TimeoutError')
    }))

    const err = await api
      .closeAll('BANKNIFTY', null, 'paper', 'fast')
      .then(() => null, (e: unknown) => e)
    expect(err).toBeInstanceOf(ApiError)
    const msg = (err as ApiError).message
    expect(msg).toContain(String(MUTATION_TIMEOUT_MS / 1000))
    expect(msg).toMatch(/STILL BE EXECUTING/)
    expect(msg).toMatch(/verify the book before retrying/)
    // ...and NOT the read copy, which would read as "nothing happened".
    expect(msg).not.toMatch(/the desk API is not answering/)
  })
})
