import { afterEach, expect, test } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { stepTextSize, useTextSize } from '../../src/traders/text-size.ts'

afterEach(() => { window.localStorage.clear(); document.documentElement.style.fontSize = '' })

test('Medium (112.5 %) by default, applied to the page root', () => {
  const { result } = renderHook(() => useTextSize())
  expect(result.current[0]).toBe('md')
  expect(document.documentElement.style.fontSize).toBe('112.5%')
})

test('a chosen size is applied and remembered', () => {
  const { result, unmount } = renderHook(() => useTextSize())
  act(() => { result.current[1]('lg') })
  expect(document.documentElement.style.fontSize).toBe('125%')
  unmount()
  const again = renderHook(() => useTextSize())
  expect(again.result.current[0]).toBe('lg')
})

test('a step stops at the ends; a stored value that is not a size reads as Medium', () => {
  expect([stepTextSize('sm', -1), stepTextSize('sm', 1), stepTextSize('xl', 1), stepTextSize('lg', -1)]).toEqual(['sm', 'md', 'xl', 'md'])
  window.localStorage.setItem('traders.textSize', 'huge')
  expect(renderHook(() => useTextSize()).result.current[0]).toBe('md')
})
