/**
 * A page made of blocks on a 12-column grid (layout.ts) that a trader can arrange: each block a panel with an id, a
 * title and a minimum size. Outside edit mode only the panels show. In edit mode each block gets a handle bar — drag
 * it to move the block, drag its corner to resize it, or focus it and use the arrow keys (Shift and the arrows
 * resize) — and a small bar shows or hides blocks and resets to the page's default. Every move snaps to the grid;
 * the arrangement is kept per signed-in user in this browser.
 *
 * Each block measures itself and passes its size class down (`useBlockSize`), so a panel can show less when it is
 * small; what still does not fit scrolls inside the block. On a phone the blocks stack in reading order, each as
 * tall as its content.
 *
 * Arranging blocks changes the screen and nothing else: nothing here places, changes or applies anything.
 */

import { createContext, useContext, useEffect, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactElement, type ReactNode } from 'react'
import { HStack } from '@astryxdesign/core/Layout'
import { Button } from '@astryxdesign/core/Button'
import { CheckboxInput } from '@astryxdesign/core/CheckboxInput'
import { Text } from '@astryxdesign/core/Text'
import { COLS, clearLayout, compact, merge, place, readLayout, resize, setHidden, sizeClass, writeLayout, type BlockSpec, type SizeClass, type Slot } from './layout.ts'
import { useSession } from './hooks.ts'
import { useMedia } from './table.tsx'
import './dashboard.css'

export interface DashBlock extends BlockSpec {
  readonly render: () => ReactNode
}

/** Below this width the grid gives way to one column. */
const STACK_BELOW = '(max-width: 759px)'
/** The grid's row unit and gap, in px (dashboard.css). */
const ROW_PX = 28
const GAP_PX = 8

const BlockSizeContext = createContext<SizeClass & { readonly widthPx: number; readonly heightPx: number }>(
  { ...sizeClass(1200, 600), widthPx: 1200, heightPx: 600 },
)

/** The size of the block this panel sits in: its class (narrow/regular/wide, short/tall) and its px. */
export function useBlockSize(): SizeClass & { readonly widthPx: number; readonly heightPx: number } {
  return useContext(BlockSizeContext)
}

function Measured(props: { readonly children: ReactNode }): ReactElement {
  const ref = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState({ ...sizeClass(1200, 600), widthPx: 1200, heightPx: 600 })
  useEffect(() => {
    const el = ref.current
    if (el === null || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver((entries) => {
      const r = entries[0]?.contentRect
      if (r === undefined) return
      const w = Math.round(r.width), h = Math.round(r.height)
      setSize((s) => (s.widthPx === w && s.heightPx === h ? s : { ...sizeClass(w, h), widthPx: w, heightPx: h }))
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  return (
    <div ref={ref} className="traders-dash-body" data-width={size.width} data-height={size.height}>
      <BlockSizeContext.Provider value={size}>{props.children}</BlockSizeContext.Provider>
    </div>
  )
}

type Drag = { readonly id: string; readonly kind: 'move' | 'resize'; readonly x0: number; readonly y0: number; readonly base: readonly Slot[]; readonly start: Slot }

export function Dashboard(props: {
  readonly label: string
  /** The layout's name for this page (its storage key's part). */
  readonly page: string
  readonly blocks: readonly DashBlock[]
  readonly defaults: readonly Slot[]
  /** Heights, in rows, of the blocks whose height follows their content. */
  readonly fitH?: Readonly<Record<string, number>>
  readonly editing?: boolean
  onDone?(): void
}): ReactElement {
  const stacked = useMedia(STACK_BELOW)
  const user = useSession()?.username ?? 'anyone'
  const fitH = props.fitH ?? {}
  const defaults = props.defaults.filter((s) => props.blocks.some((b) => b.id === s.id))
  const specs = props.blocks
  const [slots, setSlots] = useState<readonly Slot[]>(() => readLayout(user, props.page, defaults, specs))
  const [preview, setPreview] = useState<readonly Slot[] | null>(null)
  const drag = useRef<Drag | null>(null)
  const grid = useRef<HTMLElement>(null)
  const editing = props.editing === true

  // Another user, or blocks that come and go (the book loads), read the layout again over the default.
  const known = defaults.map((d) => d.id).join(',')
  useEffect(() => { setSlots(readLayout(user, props.page, defaults, specs)) }, [user, props.page, known]) // eslint-disable-line react-hooks/exhaustive-deps

  const commit = (next: readonly Slot[]): void => {
    setSlots(next)
    writeLayout(user, props.page, next)
  }
  const shown = compact(preview ?? slots, fitH)
  const order = shown.filter((s) => !s.hidden).sort((a, b) => a.y - b.y || a.x - b.x)

  const cellPx = (): { readonly col: number; readonly row: number } => {
    const w = grid.current?.getBoundingClientRect().width ?? 1200
    return { col: (w - GAP_PX * (COLS - 1)) / COLS + GAP_PX, row: ROW_PX + GAP_PX }
  }
  const startDrag = (e: PointerEvent<HTMLElement>, s: Slot, kind: 'move' | 'resize'): void => {
    if (!editing || stacked) return
    e.preventDefault()
    e.currentTarget.setPointerCapture?.(e.pointerId)
    drag.current = { id: s.id, kind, x0: e.clientX, y0: e.clientY, base: slots, start: s }
  }
  const moveDrag = (e: PointerEvent<HTMLElement>): void => {
    const d = drag.current
    if (d === null) return
    const c = cellPx()
    const dx = Math.round((e.clientX - d.x0) / c.col), dy = Math.round((e.clientY - d.y0) / c.row)
    setPreview(d.kind === 'move'
      ? place(d.base, d.id, d.start.x + dx, d.start.y + dy, specs, fitH)
      : resize(d.base, d.id, d.start.w + dx, d.start.h + dy, specs, fitH))
  }
  const endDrag = (): void => {
    if (drag.current === null) return
    drag.current = null
    if (preview !== null) commit(preview)
    setPreview(null)
  }
  const onKey = (e: KeyboardEvent<HTMLElement>, s: Slot): void => {
    if (!editing || e.target !== e.currentTarget) return
    const step: Readonly<Record<string, readonly [number, number]>> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }
    const d = step[e.key]
    if (d === undefined) return
    e.preventDefault()
    const at = shown.find((x) => x.id === s.id) ?? s
    commit(e.shiftKey ? resize(slots, s.id, at.w + d[0], at.h + d[1], specs, fitH) : place(slots, s.id, at.x + d[0], at.y + d[1], specs, fitH))
  }

  return (
    <>
      {editing ? (
        <HStack gap={2} align="center" wrap="wrap" role="toolbar" aria-label="Layout" className="traders-dash-toolbar">
          <Text size="sm" weight="bold">Edit layout</Text>
          {props.blocks.map((b) => {
            const s = slots.find((x) => x.id === b.id)
            return (
              <CheckboxInput key={b.id} label={b.title} value={s !== undefined && !s.hidden}
                onChange={(on) => commit(setHidden(slots, b.id, !on, fitH))} />
            )
          })}
          <Button size="sm" variant="secondary" label="Reset to default"
            onClick={() => { clearLayout(user, props.page); setSlots(merge(null, defaults, specs)) }} />
          <Button size="sm" variant="primary" label="Done" onClick={() => props.onDone?.()} />
          {stacked ? null : <Text size="sm" color="secondary">Drag a block by its bar, or its corner to resize; or focus it: arrows move, Shift+arrows resize</Text>}
        </HStack>
      ) : null}
      <section ref={grid} aria-label={props.label} className={`${stacked ? 'traders-dash-stacked' : 'traders-dash'}${editing ? ' traders-dash-editing' : ''}`}
        onPointerMove={moveDrag} onPointerUp={endDrag} onPointerCancel={endDrag}>
        {order.map((s) => {
          const b = props.blocks.find((x) => x.id === s.id)
          if (b === undefined) return null
          const style = stacked ? undefined : { gridColumn: `${s.x + 1} / span ${s.w}`, gridRow: `${s.y + 1} / span ${s.h}` }
          return (
            <div key={s.id} className="traders-dash-block" data-block={s.id} style={style}
              {...(editing ? {
                tabIndex: 0, role: 'group', 'aria-label': `${b.title} block`, 'aria-roledescription': 'movable block',
                onKeyDown: (e: KeyboardEvent<HTMLElement>) => onKey(e, s),
              } : {})}>
              {editing ? (
                <div className="traders-dash-handle" onPointerDown={(e) => startDrag(e, s, 'move')}>
                  <Text size="sm" weight="bold">{b.title}</Text>
                  <Text size="sm" color="secondary">{`${s.w} × ${s.h}`}</Text>
                </div>
              ) : null}
              <Measured>{b.render()}</Measured>
              {editing && !stacked ? (
                <div className="traders-dash-corner" aria-hidden="true" onPointerDown={(e) => startDrag(e, s, 'resize')} />
              ) : null}
            </div>
          )
        })}
      </section>
    </>
  )
}
