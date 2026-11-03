/**
 * `useAsync`, and the two answers it has to THROW AWAY.
 *
 * What is pinned here is not that the request happens — every hand-rolled copy
 * of this got that part right. It is that a reply which is no longer the current
 * one never reaches state: the reply for the symbol the operator has already
 * moved off, and the reply that lands after the screen is gone. Both are
 * invisible in the happy path, where answers arrive in the order they were
 * asked for, which is exactly why they need a test rather than a reading.
 */
import { expect, test, describe, vi } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import { useAsync } from '../src/shell.tsx'

/** A promise plus the handles to settle it, so a test decides what lands when. */
function deferred<T>(): {
  promise: Promise<T>
  resolve: (v: T) => void
  reject: (e: unknown) => void
} {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

/** Let every already-settled promise run its callbacks. */
const settle = async (): Promise<void> => {
  await new Promise((r) => setTimeout(r, 0))
}

describe('the answer, when it is still the current one', () => {
  test('a value reaches the caller', async () => {
    const seen: string[] = []
    const d = deferred<string>()
    renderHook(() =>
      useAsync(
        () => d.promise,
        (v) => seen.push(v),
        () => seen.push('failed'),
        [],
      ),
    )
    d.resolve('BAJFINANCE')
    await waitFor(() => expect(seen).toEqual(['BAJFINANCE']))
  })

  test('a rejection reaches the failure branch, not the value one', async () => {
    const seen: string[] = []
    const d = deferred<string>()
    renderHook(() =>
      useAsync(
        () => d.promise,
        (v) => seen.push(v),
        () => seen.push('failed'),
        [],
      ),
    )
    d.reject(new Error('instrument master unavailable'))
    await waitFor(() => expect(seen).toEqual(['failed']))
  })
})

describe('the answers it throws away', () => {
  test('a slow reply for the PREVIOUS symbol never overwrites the current one', async () => {
    const seen: string[] = []
    const first = deferred<string>()
    const second = deferred<string>()
    const { rerender } = renderHook(
      ({ symbol }: { symbol: string }) =>
        useAsync(
          () => (symbol === 'BAJFINANCE' ? first.promise : second.promise),
          (v) => seen.push(v),
          () => seen.push('failed'),
          [symbol],
        ),
      { initialProps: { symbol: 'BAJFINANCE' } },
    )

    rerender({ symbol: 'BHEL' })
    // The one the operator is looking at answers first; the one they moved off
    // answers afterwards, which is the whole hazard.
    second.resolve('BHEL')
    first.resolve('BAJFINANCE')
    await waitFor(() => expect(seen).toEqual(['BHEL']))
    await settle()
    expect(seen).toEqual(['BHEL'])
  })

  test('a reply that lands after the screen is gone touches nothing', async () => {
    const seen: string[] = []
    const d = deferred<string>()
    const { unmount } = renderHook(() =>
      useAsync(
        () => d.promise,
        (v) => seen.push(v),
        () => seen.push('failed'),
        [],
      ),
    )
    unmount()
    d.resolve('BAJFINANCE')
    await settle()
    expect(seen).toEqual([])
  })
})

test('a null fn asks nothing, and choosing one starts it', async () => {
  const seen: string[] = []
  const d = deferred<string>()
  const ask = vi.fn(() => d.promise)
  const { rerender } = renderHook(
    ({ ready }: { ready: boolean }) =>
      useAsync(
        ready ? ask : null,
        (v) => seen.push(v),
        () => seen.push('failed'),
        [ready],
      ),
    { initialProps: { ready: false } },
  )
  // The guard belongs in the deps, not in an `if` the deps cannot see: nothing
  // is asked for a pair that is not chosen yet.
  expect(ask).not.toHaveBeenCalled()

  rerender({ ready: true })
  expect(ask).toHaveBeenCalledTimes(1)
  d.resolve('900')
  await waitFor(() => expect(seen).toEqual(['900']))
})
