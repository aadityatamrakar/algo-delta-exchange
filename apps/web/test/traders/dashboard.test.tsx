/** The block grid: the layout arithmetic, its storage, and arranging blocks with the keyboard. */
import { afterEach, expect, test, vi } from 'vitest'
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { Dashboard, useBlockSize, type DashBlock } from '../../src/traders/dashboard.tsx'
import { compact, layoutKey, merge, place, readLayout, resize, setHidden, sizeClass, writeLayout, type BlockSpec, type Slot } from '../../src/traders/layout.ts'

afterEach(() => { window.localStorage.clear(); vi.unstubAllGlobals() })

const SPECS: BlockSpec[] = [
  { id: 'a', title: 'A', minW: 4, minH: 2 },
  { id: 'b', title: 'B', minW: 2, minH: 2 },
  { id: 'c', title: 'C', minW: 2, minH: 2 },
]
const DEFAULTS: Slot[] = [
  { id: 'a', x: 0, y: 0, w: 12, h: 4, hidden: false, fit: true },
  { id: 'b', x: 0, y: 10, w: 6, h: 3, hidden: false },
  { id: 'c', x: 6, y: 10, w: 6, h: 3, hidden: false },
]
const at = (slots: readonly Slot[], id: string): Slot => slots.find((s) => s.id === id)!
const overlap = (a: Slot, b: Slot): boolean => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h

test('blocks fall upward into free space and never overlap; a fitting block takes its content height', () => {
  const s = compact(DEFAULTS, { a: 6 })
  expect([at(s, 'a').y, at(s, 'b').y, at(s, 'c').y]).toEqual([0, 6, 6])
  for (const x of s) for (const y of s) if (x !== y) expect(overlap({ ...x, h: x.id === 'a' ? 6 : x.h }, { ...y, h: y.id === 'a' ? 6 : y.h })).toBe(false)
})

test('a block put elsewhere takes the place and the others make room; it stays inside the grid', () => {
  const s = place(compact(DEFAULTS), 'c', 0, 0, SPECS)
  expect([at(s, 'c').x, at(s, 'c').y]).toEqual([0, 0])
  expect(at(s, 'a').y).toBe(3)                       // pushed under c
  expect(at(place(s, 'b', 20, -5, SPECS), 'b')).toMatchObject({ x: 6, y: 0 })   // clamped: 12 − w, 0
})

test('a resize keeps the minimum size and the grid, and stops a fitting height following its content', () => {
  const s = resize(compact(DEFAULTS), 'a', 1, 1, SPECS)
  expect(at(s, 'a')).toMatchObject({ w: 4, h: 2, fit: false })
  expect(at(resize(s, 'b', 40, 3, SPECS), 'b').w).toBe(12)
})

test('a hidden block leaves room and comes back to its place', () => {
  const hid = setHidden(compact(DEFAULTS), 'a', true)
  expect([at(hid, 'b').y, at(hid, 'a').hidden]).toEqual([0, true])
  expect(at(setHidden(hid, 'a', false), 'a').y).toBe(0)
})

test('a stored layout is merged with the default: unknown and broken entries dropped, new blocks added, never a throw', () => {
  const saved = { slots: [{ id: 'b', x: 2, y: 0, w: 4, h: 2, hidden: true }, { id: 'zz', x: 0, y: 0, w: 2, h: 2 }, { id: 'c', x: 'x' }, null, 7] }
  const m = merge(saved, DEFAULTS, SPECS)
  expect(m.map((s) => s.id)).toEqual(['a', 'b', 'c'])
  expect(at(m, 'b')).toMatchObject({ x: 2, w: 4, hidden: true })
  expect(at(m, 'c')).toMatchObject({ x: 6, w: 6 })     // the broken entry gave way to the default
  for (const junk of [null, 'nope', { slots: 3 }, []]) expect(merge(junk, DEFAULTS, SPECS).length).toBe(3)
  window.localStorage.setItem(layoutKey('ravi', 'book'), '{not json')
  expect(readLayout('ravi', 'book', DEFAULTS, SPECS).length).toBe(3)
})

test('the layout is kept per user and page, under a versioned key', () => {
  writeLayout('ravi', 'book', place(compact(DEFAULTS), 'c', 0, 0, SPECS))
  expect(layoutKey('ravi', 'book')).toBe('traders.layout.v1.book.ravi')
  expect(at(readLayout('ravi', 'book', DEFAULTS, SPECS), 'c').y).toBe(0)
  expect(at(readLayout('asha', 'book', DEFAULTS, SPECS), 'c').y).not.toBe(0)
})

test('size classes', () => {
  expect(sizeClass(300, 180)).toEqual({ width: 'narrow', height: 'short' })
  expect(sizeClass(500, 400)).toEqual({ width: 'regular', height: 'tall' })
  expect(sizeClass(900, 220)).toEqual({ width: 'wide', height: 'tall' })
})

function Probe(props: { name: string }): React.ReactElement {
  const s = useBlockSize()
  return <span>{`${props.name}: ${s.width}/${s.height}`}</span>
}
const BLOCKS: DashBlock[] = SPECS.map((s) => ({ ...s, render: () => <Probe name={s.title} /> }))

function grid(editing: boolean, onDone = (): void => {}): void {
  render(<Dashboard label="Test page" page="test" blocks={BLOCKS} defaults={DEFAULTS} fitH={{ a: 4 }} editing={editing} onDone={onDone} />)
}
const blockStyle = (id: string): string => document.querySelector<HTMLElement>(`[data-block="${id}"]`)!.getAttribute('style') ?? ''

test('outside edit mode there are only the blocks: no toolbar, handles or corners', () => {
  grid(false)
  expect(screen.getByRole('region', { name: 'Test page' })).toBeTruthy()
  expect(screen.queryByRole('toolbar', { name: 'Layout' })).toBe(null)
  expect(document.querySelector('.traders-dash-handle, .traders-dash-corner')).toBe(null)
  expect(screen.queryByRole('group', { name: 'A block' })).toBe(null)
})

test('in edit mode a focused block moves with the arrows and resizes with Shift+arrows; the layout is kept', () => {
  grid(true)
  const c = screen.getByRole('group', { name: 'C block' })
  expect(blockStyle('c')).toMatch(/grid-column: 7 \/ span 6/)
  fireEvent.keyDown(c, { key: 'ArrowLeft' })
  expect(blockStyle('c')).toMatch(/grid-column: 6 \/ span 6/)
  fireEvent.keyDown(c, { key: 'ArrowDown', shiftKey: true })
  expect(blockStyle('c')).toMatch(/span 4;?$|grid-row: \d+ \/ span 4/)
  const kept = JSON.parse(window.localStorage.getItem(layoutKey('anyone', 'test'))!) as { slots: Slot[] }
  expect(at(kept.slots, 'c')).toMatchObject({ x: 5, h: 4 })
})

test('the toolbar hides and shows blocks, resets to the default, and finishes', () => {
  const done = vi.fn()
  grid(true, done)
  const bar = screen.getByRole('toolbar', { name: 'Layout' })
  fireEvent.click(within(bar).getByRole('checkbox', { name: 'B' }))
  expect(document.querySelector('[data-block="b"]')).toBe(null)
  fireEvent.keyDown(screen.getByRole('group', { name: 'C block' }), { key: 'ArrowLeft' })
  fireEvent.click(within(bar).getByRole('button', { name: 'Reset to default' }))
  expect(document.querySelector('[data-block="b"]')).not.toBe(null)
  expect(blockStyle('c')).toMatch(/grid-column: 7 \/ span 6/)
  expect(window.localStorage.getItem(layoutKey('anyone', 'test'))).toBe(null)
  fireEvent.click(within(bar).getByRole('button', { name: 'Done' }))
  expect(done).toHaveBeenCalledOnce()
})

test('each block learns its own size class from what it measures', () => {
  const observers: { cb: ResizeObserverCallback; el: Element }[] = []
  vi.stubGlobal('ResizeObserver', class {
    constructor(private cb: ResizeObserverCallback) {}
    observe(el: Element): void { observers.push({ cb: this.cb, el }) }
    disconnect(): void {}
    unobserve(): void {}
  })
  grid(false)
  for (const o of observers) {
    const id = o.el.closest('[data-block]')?.getAttribute('data-block')
    const rect = id === 'a' ? { width: 1200, height: 300 } : { width: 300, height: 150 }
    act(() => { o.cb([{ contentRect: rect } as ResizeObserverEntry], {} as ResizeObserver) })
  }
  expect(screen.getByText('A: wide/tall')).toBeTruthy()
  expect(screen.getByText('B: narrow/short')).toBeTruthy()
})

test('a fitting block is drawn at its fitted height, not only placed by it (no gap under a clipped legs table)', () => {
  const slots: Slot[] = [
    { id: 'legs', x: 0, y: 0, w: 12, h: 10, hidden: false, fit: true },
    { id: 'mtm', x: 0, y: 10, w: 4, h: 7, hidden: false },
  ]
  const out = compact(slots, { legs: 15 })
  expect(out.find((s) => s.id === 'legs')!.h).toBe(15)
  expect(out.find((s) => s.id === 'mtm')!.y).toBe(15)
})
