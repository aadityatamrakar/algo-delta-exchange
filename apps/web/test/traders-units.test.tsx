/** The units toggle and the book scaler. */
import { expect, test, afterEach } from 'vitest'
import { act, cleanup, fireEvent, render, renderHook, screen } from '@testing-library/react'
import { scaleBook, UnitsToggle } from '../src/traders/units.tsx'
import { useViewer } from '../src/traders/viewer.ts'

afterEach(cleanup)

test('scaleBook', () => {
  expect([scaleBook(5250, 'position', 175, 3), scaleBook(5250, 'lot', 175, 3), scaleBook(5250, 'share', 175, 3), scaleBook(5250, 'share', null, 3)]).toEqual([5250, 1750, 10, 5250])
})

test('UnitsToggle disables per share/lot without a lot size', () => {
  render(<UnitsToggle lotSize={null} />)
  const share = screen.getByRole('radio', { name: 'Per share' })
  const lot = screen.getByRole('radio', { name: 'Per lot' })
  const position = screen.getByRole('radio', { name: 'Whole position' })
  expect(share.getAttribute('aria-disabled')).toBe('true')
  expect(lot.getAttribute('aria-disabled')).toBe('true')
  expect(share.getAttribute('title')).toBe('Lot size unknown')
  expect(position.getAttribute('aria-disabled')).toBeNull()
  expect(position.getAttribute('aria-checked')).toBe('true')
  fireEvent.click(lot)
  expect(position.getAttribute('aria-checked')).toBe('true')
})

test('UnitsToggle switches the page-wide units and says it is the book figures it sets, not the leg tables', () => {
  const viewer = renderHook(() => useViewer('TCS'))
  render(<UnitsToggle lotSize={175} />)
  // The explanation sits behind the switch's ⓘ, in the same words.
  expect(screen.queryByText(/^Book figures:/)).toBe(null)
  fireEvent.click(screen.getByRole('button', { name: 'About the units' }))
  expect(screen.getByText('Book figures: per lot = this book ÷ its common lot count; per share = per lot ÷ lot size. Leg tables: greeks per share, values the whole leg')).toBeTruthy()
  fireEvent.click(screen.getByRole('radio', { name: 'Per lot' }))
  expect(viewer.result.current.units).toBe('lot')
  expect(screen.getByRole('radio', { name: 'Per lot' }).getAttribute('aria-checked')).toBe('true')
  act(() => viewer.result.current.setUnits('position'))
})

test('scaleBook leaves the value alone for a bad lot count', () => {
  for (const g of [0, -3, NaN, Infinity]) expect(scaleBook(5250, 'lot', 175, g)).toBe(5250)
  for (const g of [0, NaN, Infinity]) expect(scaleBook(5250, 'share', 175, g)).toBe(5250)
  expect(scaleBook(5250, 'share', 0, 3)).toBe(5250)
})

test('with no lot size every figure is whole-position, whatever units are stored', () => {
  expect(scaleBook(5250, 'lot', null, 3)).toBe(5250)
  expect(scaleBook(5250, 'share', null, 3)).toBe(5250)
})

test('the toggle shows Whole position when a stored lot unit meets an unknown lot size', () => {
  const viewer = renderHook(() => useViewer('TCS'))
  act(() => viewer.result.current.setUnits('lot'))
  render(<UnitsToggle lotSize={null} />)
  expect(screen.getByRole('radio', { name: 'Whole position' }).getAttribute('aria-checked')).toBe('true')
  act(() => viewer.result.current.setUnits('position'))
})
