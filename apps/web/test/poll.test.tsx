/**
 * `usePoll`, and the answer it must THROW AWAY.
 *
 * The sibling of `async.test.tsx`, for the same class of bug on the hook that
 * runs FOREVER rather than once. `useAsync` only ever has one request in flight
 * per dependency change; a poll deliberately fires again on a timer, so a slow
 * response and a fast one are in flight AT THE SAME TIME on the same deps — and
 * when the slow one lands last it overwrites the newer payload with an older
 * one. Nothing on screen says it happened: the numbers simply jump backwards for
 * one cadence, on a page whose whole claim is that a figure is at most N seconds
 * old (audit F-49). Live at 3s on the feed and 5s on positions and books.
 *
 * `updatedAt` is the other half of that claim, and it is pinned here for the
 * same reason: it is what the tiles print as "as of Xs ago", so a stamp that
 * moved on a FAILED read would make an outage look like a refresh.
 *
 * The third thing pinned here is HOW MANY requests are open at once. The
 * interval used to fire whether or not the last one had answered, so a hung
 * bridge collected one more socket every cadence, forever, from every polling
 * component on the page.
 */
import { expect, test, describe, vi, afterEach } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { usePoll, asOf } from '../src/shell.tsx'

/** A promise plus the handles to settle it, so a test decides what lands when. */
function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

/**
 * Two polls, one after the other, each settled by hand.
 *
 * The hook is given one `fn` that hands out the deferreds in the order it is
 * asked, so "the request the interval fired second" and "the answer that lands
 * first" are two different things the test controls independently — which is
 * exactly the situation a real network produces and no happy-path test does.
 *
 * SEQUENTIAL ONLY. The interval no longer fires over an unanswered request
 * (see `pollHarness` below), so the second deferred here is handed out only
 * after the first has settled. The tests that need two answers IN FLIGHT AT
 * ONCE use the harness instead.
 */
function twoPolls(intervalMs = 1000): {
  first: ReturnType<typeof deferred<string>>
  second: ReturnType<typeof deferred<string>>
  hook: ReturnType<typeof renderHook<ReturnType<typeof usePoll<string>>, unknown>>
} {
  const first = deferred<string>()
  const second = deferred<string>()
  const queue = [first, second]
  let asked = 0
  const hook = renderHook(() => usePoll<string>(() => (queue[asked++] ?? second).promise, intervalMs, []))
  return { first, second, hook }
}

/**
 * The hook, plus every request it issued in order, each one settled by hand.
 *
 * `fn` mints a fresh deferred per call and records it, so a test can talk about
 * "request 2" without deciding up front how many there will be — which is the
 * point, because the number issued IS what half of these tests assert.
 */
function pollHarness(intervalMs = 1000): {
  issued: ReturnType<typeof deferred<string>>[]
  hook: ReturnType<typeof renderHook<ReturnType<typeof usePoll<string>>, { dep: string }>>
} {
  const issued: ReturnType<typeof deferred<string>>[] = []
  const hook = renderHook(
    ({ dep }: { dep: string }) => usePoll<string>(() => {
      const d = deferred<string>()
      issued.push(d)
      return d.promise
    }, intervalMs, [dep]),
    { initialProps: { dep: 'a' } },
  )
  return { issued, hook }
}

/**
 * Get two requests IN FLIGHT AT ONCE, on the deps the page is showing now.
 *
 * The interval alone can no longer do it: a tick over an unanswered request is
 * skipped. What still can, and does in the app, is a request ABANDONED by a
 * deps change — the operator switches book or mode while the bridge is hanging.
 * The abandoned request releases the in-flight flag when it finally answers, at
 * which point the next tick fires over the request the current deps are already
 * waiting on. `issued[1]` is then the older of the two live requests and
 * `issued[2]` the newer, and only the request ids can tell them apart.
 */
async function twoInFlight(h: ReturnType<typeof pollHarness>, intervalMs = 1000): Promise<void> {
  await act(async () => { h.hook.rerender({ dep: 'b' }); await vi.advanceTimersByTimeAsync(0) })
  await act(async () => { h.issued[0]?.resolve('abandoned'); await vi.advanceTimersByTimeAsync(0) })
  await act(async () => { await vi.advanceTimersByTimeAsync(intervalMs) })
}

describe('two answers in flight, arriving out of order', () => {
  afterEach(() => { vi.useRealTimers() })

  test('the OLDER response never overwrites the newer one', async () => {
    vi.useFakeTimers()
    const h = pollHarness()
    await twoInFlight(h)
    const [, older, newer] = h.issued
    expect(h.issued).toHaveLength(3)

    // The newer one answers first — this is the value on screen.
    await act(async () => { newer?.resolve('fresh'); await vi.advanceTimersByTimeAsync(0) })
    expect(h.hook.result.current.data).toBe('fresh')

    // ...and the older one lands afterwards. It describes a moment that has
    // already passed, so it must change nothing at all.
    await act(async () => { older?.resolve('stale'); await vi.advanceTimersByTimeAsync(0) })
    expect(h.hook.result.current.data).toBe('fresh')
  })

  test('an OLDER failure never puts an error over a newer success', async () => {
    vi.useFakeTimers()
    const h = pollHarness()
    await twoInFlight(h)
    const [, older, newer] = h.issued

    await act(async () => { newer?.resolve('fresh'); await vi.advanceTimersByTimeAsync(0) })
    // The stale request fails LATER. A banner raised by a request that was
    // already superseded says the bridge is unreachable while the figure beside
    // it was fetched successfully one moment ago.
    await act(async () => {
      older?.reject(new Error('bridge unreachable'))
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(h.hook.result.current.error).toBe(null)
    expect(h.hook.result.current.data).toBe('fresh')
  })

  test('a NEWER failure over a figure on screen still keeps the older answer out', async () => {
    vi.useFakeTimers()
    const h = pollHarness()
    await twoInFlight(h)
    // A figure lands from the older of the two live reads, and the tick it
    // frees issues one more — so there is again a read in flight (`older`)
    // that predates the newest one.
    await act(async () => { h.issued[1]?.resolve('seed'); await vi.advanceTimersByTimeAsync(0) })
    await act(async () => { await vi.advanceTimersByTimeAsync(1000) })
    const [, , older, newer] = h.issued
    expect(h.issued).toHaveLength(4)

    // The newest read fails. With a figure on screen the failure IS the page's
    // latest word on the bridge, so the read it superseded may not land behind
    // it and roll the number backwards (F-49).
    await act(async () => { newer?.reject(new Error('bridge unreachable')); await vi.advanceTimersByTimeAsync(0) })
    expect(h.hook.result.current.data).toBe('seed')
    await act(async () => { older?.resolve('stale'); await vi.advanceTimersByTimeAsync(0) })
    expect(h.hook.result.current.data).toBe('seed')
    expect(h.hook.result.current.error).toBe('bridge unreachable')
  })

  test('a failure on an EMPTY page does not swallow a read still in flight', async () => {
    vi.useFakeTimers()
    const h = pollHarness()
    await twoInFlight(h)
    const [, older, newer] = h.issued

    // The newer read fails FIRST, and there is no figure on screen for it to
    // stand in front of.
    await act(async () => { newer?.reject(new Error('bridge unreachable')); await vi.advanceTimersByTimeAsync(0) })
    expect(h.hook.result.current.error).toBe('bridge unreachable')
    expect(h.hook.result.current.data).toBe(null)

    // The slower read then answers. A failure that consumed the newest id would
    // have thrown this payload away and left the page reading "unreachable"
    // with nothing on it — an outage banner over data that ARRIVED. An empty
    // page has nothing to protect, so the answer lands and the banner goes.
    await act(async () => { older?.resolve('one'); await vi.advanceTimersByTimeAsync(0) })
    expect(h.hook.result.current.data).toBe('one')
    expect(h.hook.result.current.error).toBe(null)
  })

  test('the answers still arriving IN order are applied, one after another', async () => {
    vi.useFakeTimers()
    const { first, second, hook } = twoPolls()
    await act(async () => { first.resolve('one'); await vi.advanceTimersByTimeAsync(0) })
    expect(hook.result.current.data).toBe('one')
    await act(async () => { await vi.advanceTimersByTimeAsync(1000) })
    await act(async () => { second.resolve('two'); await vi.advanceTimersByTimeAsync(0) })
    expect(hook.result.current.data).toBe('two')
  })
})

describe('a bridge that has stopped answering', () => {
  afterEach(() => { vi.useRealTimers() })

  test('the ticks do NOT pile more requests onto an unanswered one', async () => {
    vi.useFakeTimers()
    let calls = 0
    renderHook(() => usePoll<string>(() => {
      calls += 1
      // The shape of a hung bridge from the browser: a request that is never
      // answered and never refused.
      return new Promise<string>(() => {})
    }, 1000, []))

    await act(async () => { await vi.advanceTimersByTimeAsync(3000) })
    // Three ticks passed and the page still has ONE request outstanding. The
    // interval used to fire regardless, so a bridge hanging for a minute left
    // twenty sockets open on a 3s page — the load arriving exactly when the
    // thing being polled is already struggling.
    expect(calls).toBe(1)
  })

  test('the next tick after it answers issues the read that was skipped', async () => {
    vi.useFakeTimers()
    const h = pollHarness()
    await act(async () => { await vi.advanceTimersByTimeAsync(3000) })
    expect(h.issued).toHaveLength(1)

    // Skipping is a PAUSE, not a stop: the moment the bridge answers, the
    // cadence resumes on its own.
    await act(async () => { h.issued[0]?.resolve('back'); await vi.advanceTimersByTimeAsync(0) })
    await act(async () => { await vi.advanceTimersByTimeAsync(1000) })
    expect(h.issued).toHaveLength(2)
    expect(h.hook.result.current.data).toBe('back')
  })

  test('a deps change is never held back by the request it abandoned', async () => {
    vi.useFakeTimers()
    const h = pollHarness()
    // The first read hangs; the operator switches to another book. The new
    // page must ask immediately — the old request answering is not a thing it
    // can be made to wait for.
    await act(async () => { h.hook.rerender({ dep: 'b' }); await vi.advanceTimersByTimeAsync(0) })
    expect(h.issued).toHaveLength(2)
  })
})

describe('updatedAt — when this payload was last confirmed', () => {
  afterEach(() => { vi.useRealTimers() })

  test('null until the first answer, then stamped with the moment it landed', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-16T10:00:00+05:30'))
    const { first, hook } = twoPolls()
    // Nothing has been confirmed yet, and "0s ago" would be a claim.
    expect(hook.result.current.updatedAt).toBe(null)

    await act(async () => { first.resolve('one'); await vi.advanceTimersByTimeAsync(0) })
    expect(hook.result.current.updatedAt).toBe(Date.now())
  })

  test('a FAILED read leaves the stamp where it was — the data did not refresh', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-16T10:00:00+05:30'))
    const { first, second, hook } = twoPolls()
    await act(async () => { first.resolve('one'); await vi.advanceTimersByTimeAsync(0) })
    const landed = hook.result.current.updatedAt

    await act(async () => { await vi.advanceTimersByTimeAsync(1000) })
    await act(async () => {
      second.reject(new Error('bridge unreachable'))
      await vi.advanceTimersByTimeAsync(0)
    })
    // The figure is still the one from `landed`, and the age printed beside it
    // has to keep counting up rather than resetting to "now".
    expect(hook.result.current.updatedAt).toBe(landed)
    expect(hook.result.current.error).toBe('bridge unreachable')
    expect(hook.result.current.data).toBe('one')
  })
})

describe('asOf — the age, in the words the tiles print', () => {
  test('nothing confirmed yet has no note at all, rather than "as of never"', () => {
    expect(asOf(null)).toBe(undefined)
  })

  test('a fresh read reads as "as of now", an old one in seconds', () => {
    const now = Date.now()
    expect(asOf(now)).toBe('as of now')
    expect(asOf(now - 7000)).toBe('as of 7s ago')
  })
})
