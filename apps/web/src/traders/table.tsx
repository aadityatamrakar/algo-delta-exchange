/**
 * THE ONE TABLE OF THE TRADERS PAGES — every table on them goes through it.
 *
 * astryx lays a table out `fixed` at `width: 100%`, so a column with no width
 * of its own gets an equal share of the container: twenty-six VolHedge columns
 * in a 1,200px card each got 46px, every figure wrapped, the Vol (%) input
 * spilled into its neighbours, and the table never grew past the card, so it
 * had nothing to scroll. What this changes, all in `tables.css`:
 *
 *  - the table scrolls inside its own box, both ways, with the header row
 *    pinned at the top of it; the page itself never scrolls sideways;
 *  - no cell wraps, and figures are tabular so columns of numbers line up;
 *  - a table whose columns carry no widths is laid out by its content
 *    (`traders-table-auto`), so each column is as wide as its widest cell;
 *  - a table whose every column carries a width keeps astryx's fixed layout,
 *    which is what pinned columns need (their offsets are the widths);
 *  - a control inside a cell (an input, a picker, a tick) is compact and never
 *    wider than its cell — the same rule for every table, not one per input;
 *  - a column with a `sortValue` sorts the table on a click of its header
 *    (astryx's sort header: ascending, descending, back to the served order;
 *    aria-sort on the header cell; a button, so Enter and Space work). Blanks
 *    sort last both ways, `keepLast` rows (a totals row) stay at the bottom, and
 *    `isChild` rows (a book's month rows) move with the row above them.
 */

import type { ReactElement } from 'react'
import { useEffect, useState } from 'react'
import { Table, useTableSortable } from '@astryxdesign/core/Table'
import type { TableColumn, TableProps, TableSortState } from '@astryxdesign/core/Table'

/** The wrapper's classes: `traders-table`, plus `traders-table-auto` unless every column has a width. */
export function tableClass(columns: TableProps<Record<string, unknown>>['columns']): string {
  const sized = columns !== undefined && columns.length > 0 && columns.every((c) => c.width !== undefined)
  return sized ? 'traders-table' : 'traders-table traders-table-auto'
}

/** A traders column: astryx's, plus the raw value it sorts by (a number or text; null or NaN sorts last). */
export type TradersColumn<T extends Record<string, unknown>> = TableColumn<T> & {
  readonly sortValue?: (row: T) => number | string | null | undefined
}

export type TradersTableProps<T extends Record<string, unknown>> = Omit<TableProps<T>, 'columns'> & {
  readonly columns?: TradersColumn<T>[]
  /** Rows that stay last, in their served order, whatever the sort: a totals row. */
  readonly keepLast?: (row: T) => boolean
  /** Rows that belong to the row above them (a book's month rows): they move with it and keep their order. */
  readonly isChild?: (row: T) => boolean
}

/** `columns` with each listed key sorting by the row's own field of that name (a number or text; anything else blank). */
export function sortByField<T extends Record<string, unknown>>(columns: readonly TableColumn<T>[], keys: readonly string[]): TradersColumn<T>[] {
  return columns.map((c) => (keys.includes(c.key) ? { ...c, sortValue: (r: T) => fieldCell(r[c.key]) } : c))
}

const fieldCell = (v: unknown): number | string | null => (typeof v === 'number' || typeof v === 'string' ? v : null)

type SortCell = number | string | null

function sortCell(v: number | string | null | undefined): SortCell {
  if (v === null || v === undefined) return null
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  return v === '' ? null : v
}

/** `data` in `sort`'s order by its column's `sortValue`; the served order when unsorted or the column has none. */
export function sortRows<T extends Record<string, unknown>>(
  data: readonly T[],
  columns: readonly TradersColumn<T>[],
  sort: TableSortState,
  keepLast?: (row: T) => boolean,
  isChild?: (row: T) => boolean,
): T[] {
  const entry = sort[0]
  const get = entry === undefined ? undefined : columns.find((c) => c.key === entry.sortKey)?.sortValue
  if (entry === undefined || get === undefined) return [...data]
  const last: T[] = []
  const groups: { readonly head: T; readonly rows: T[]; readonly at: number }[] = []
  for (const row of data) {
    if (keepLast?.(row) === true) last.push(row)
    else if (isChild?.(row) === true && groups.length > 0) groups[groups.length - 1]!.rows.push(row)
    else groups.push({ head: row, rows: [row], at: groups.length })
  }
  const dir = entry.direction === 'descending' ? -1 : 1
  const keyed = groups.map((g) => ({ g, v: sortCell(get(g.head)) }))
  keyed.sort((a, b) => {
    if (a.v === null || b.v === null) return a.v === b.v ? a.g.at - b.g.at : a.v === null ? 1 : -1   // blanks last both ways
    const c = typeof a.v === 'number' && typeof b.v === 'number'
      ? a.v - b.v
      : String(a.v).localeCompare(String(b.v), undefined, { numeric: true, sensitivity: 'base' })
    return c !== 0 ? dir * c : a.g.at - b.g.at
  })
  return [...keyed.flatMap((k) => k.g.rows), ...last]
}

export function TradersTable<T extends Record<string, unknown>>(props: TradersTableProps<T>): ReactElement {
  const { columns, data, plugins, keepLast, isChild, ...rest } = props
  const [sort, setSort] = useState<TableSortState>([])
  const sortPlugin = useTableSortable<T>({ sort, onSortChange: setSort })
  const cols = columns ?? []
  const sortable = cols.some((c) => c.sortValue !== undefined)
  const shown: TableColumn<T>[] = cols.map(({ sortValue, ...c }) => (sortValue === undefined ? c : { ...c, sortable: { sortKey: c.key } }))
  const rows = sortable && data !== undefined ? sortRows(data, cols, sort, keepLast, isChild) : data
  return (
    <div className={tableClass(shown as TableProps<Record<string, unknown>>['columns'])}>
      <Table {...rest} columns={shown} {...(rows === undefined ? {} : { data: rows })}
        {...(sortable ? { plugins: { ...plugins, sort: sortPlugin } } : plugins === undefined ? {} : { plugins })} />
    </div>
  )
}

/**
 * The props an input inside a table cell takes: the compact size, and the
 * cell's own width (`tables.css` also caps any field at its cell).
 */
export const CELL_INPUT = { size: 'sm', isLabelHidden: true, width: '100%' } as const

/** Pinned columns take room a phone does not have: only pin from this width up. */
export const PIN_FROM = '(min-width: 1024px)'

/** Does the window match `query` now, following it as it changes. False where `matchMedia` is missing. */
export function useMedia(query: string): boolean {
  const read = (): boolean => typeof window.matchMedia === 'function' && window.matchMedia(query).matches
  const [on, setOn] = useState(read)
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return
    const mq = window.matchMedia(query)
    const change = (): void => { setOn(mq.matches) }
    change()
    mq.addEventListener('change', change)
    return () => { mq.removeEventListener('change', change) }
  }, [query])
  return on
}
