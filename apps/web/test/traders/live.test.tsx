import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { act, render, renderHook, screen } from '@testing-library/react'
import type { LiveFrame } from '../../../traders/src/analytics/r3-wire.ts'
import type { AnalysisLeg } from '../../../traders/src/analytics/wire.ts'
import { useFigures } from '../../src/traders/hooks.ts'
import { LIVE_SILENT_MS, LivePill, liveStatus, overlayLegs, resetLive, useLiveBook } from '../../src/traders/live.tsx'

/** EventSource as the page uses it: listeners by event name, onopen/onerror, close(). */
class FakeSource {
  static made: FakeSource[] = []
  readonly url: string
  closed = false
  onopen: (() => void) | null = null
  onerror: (() => void) | null = null
  readonly #on = new Map<string, ((e: MessageEvent<string>) => void)[]>()
  constructor(url: string) { this.url = url; FakeSource.made.push(this) }
  addEventListener(name: string, fn: (e: MessageEvent<string>) => void): void { this.#on.set(name, [...(this.#on.get(name) ?? []), fn]) }
  close(): void { this.closed = true }
  emit(name: string, data: unknown): void { for (const fn of this.#on.get(name) ?? []) fn({ data: JSON.stringify(data) } as MessageEvent<string>) }
}

const frame = (over: Partial<LiveFrame> = {}): LiveFrame => ({
  stock: 'TCS', asOf: 2_000, closed: false, feedAlive: true, spot: 3395, future: 3400,
  legs: [{ key: 'k1', ltp: 133.25, bid: 133, ask: 133.5, stale: false, grossMtm: -2318.75 }], mtmToday: -500, mtmTotal: 1200, ...over,
})

beforeEach(() => { FakeSource.made = []; vi.stubGlobal('EventSource', FakeSource) })
afterEach(() => { resetLive(); vi.unstubAllGlobals(); vi.useRealTimers() })

test('one stream per book however many parts of the page ask; it closes when the last one leaves', () => {
  const a = renderHook(() => useLiveBook('TCS'))
  const b = renderHook(() => useLiveBook('TCS'))
  expect(FakeSource.made).toHaveLength(1)
  expect(FakeSource.made[0]!.url).toMatch(/\/v1\/traders\/books\/TCS\/live$/)
  a.unmount()
  expect(FakeSource.made[0]!.closed).toBe(false)
  b.unmount()
  expect(FakeSource.made[0]!.closed).toBe(true)
})

test('delayed until the first frame, live with it, closed when the market is, delayed again on an error', () => {
  const h = renderHook(() => useLiveBook('TCS'))
  expect(h.result.current.status).toBe('delayed')
  act(() => { FakeSource.made[0]!.emit('frame', frame()) })
  expect(h.result.current.status).toBe('live')
  expect(h.result.current.frame?.legs[0]?.ltp).toBe(133.25)
  act(() => { FakeSource.made[0]!.emit('frame', frame({ closed: true })) })
  expect(h.result.current.status).toBe('closed')
  act(() => { FakeSource.made[0]!.emit('frame', frame()); FakeSource.made[0]!.onerror?.() })
  expect(h.result.current.status).toBe('delayed')
  act(() => { FakeSource.made[0]!.emit('ping', {}) })
  expect(h.result.current.status).toBe('live')
})

test('a stream quiet past LIVE_SILENT_MS counts as delayed; no stream at all is off', () => {
  const c = { frame: frame(), lastAt: 1_000, errored: false }
  expect(liveStatus(c, 1_000 + LIVE_SILENT_MS)).toBe('live')
  expect(liveStatus(c, 1_001 + LIVE_SILENT_MS)).toBe('delayed')
  expect(liveStatus(undefined, 0)).toBe('off')
})

test('without EventSource the page stays on its polls: off, and nothing is opened', () => {
  vi.stubGlobal('EventSource', undefined)
  const h = renderHook(() => useLiveBook('TCS'))
  expect(h.result.current.status).toBe('off')
  expect(FakeSource.made).toHaveLength(0)
})

const leg = (key: string): AnalysisLeg => ({ key, ltp: 120, buyPrice: null, salePrice: null, grossMtm: 0 } as unknown as AnalysisLeg)

test('the live LTP, bid, ask and gross MTM lie over the polled legs only while live and newer', () => {
  const legs = [leg('k1'), leg('k2')]
  const live = { status: 'live' as const, frame: frame() }
  const on = overlayLegs(legs, live, 1_000)
  expect([on[0]!.ltp, on[0]!.buyPrice, on[0]!.salePrice, on[0]!.grossMtm]).toEqual([133.25, 133, 133.5, -2318.75])
  expect(on[1]).toBe(legs[1])                                       // a leg the frame does not carry is left as served
  expect(overlayLegs(legs, live, 3_000)).toBe(legs)                 // the polled view is newer
  expect(overlayLegs(legs, { status: 'delayed', frame: frame() }, 1_000)).toBe(legs)
})

test('the pill: "● Live", "Delayed" with why, nothing when closed or off', () => {
  const { rerender, container } = render(<LivePill status="live" />)
  expect(screen.getByRole('status').textContent).toBe('● Live')
  rerender(<LivePill status="delayed" />)
  expect(screen.getByRole('status').getAttribute('title')).toBe('live prices interrupted — refreshing every 15–60 s')
  rerender(<LivePill status="closed" />)
  expect(container.textContent).toBe('')
  rerender(<LivePill status="off" />)
  expect(container.textContent).toBe('')
})

test('useFigures refreshes at the interval it is given (5 s while live)', async () => {
  vi.useFakeTimers()
  const load = vi.fn(async () => 1)
  renderHook(() => useFigures(load, true, 'x', 5_000))
  await act(async () => { await vi.advanceTimersByTimeAsync(0) })
  const first = load.mock.calls.length
  await act(async () => { await vi.advanceTimersByTimeAsync(15_000) })
  expect(load.mock.calls.length - first).toBe(3)
})
