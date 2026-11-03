/**
 * The query language (spec §6.3): a small JSON query, validated by zod and
 * then against the catalogue, run in memory over rows a source built.
 *
 * where (AND) → groupBy/aggregate, or select → orderBy → limit. A result
 * longer than its limit carries the first rows plus a summary of every numeric
 * column over ALL matching rows, so the model still sees the shape of what it
 * did not get. Numbers are rounded to 4 decimals: no float noise in a prompt.
 */

import { z } from 'zod'
import { STOCK_RE } from '../../books/manual.ts'
import { BAND_EVENTS_MAX_DAYS, CATALOGUE, DATASETS, RECORDS_MAX_DAYS, type DatasetDef, type FieldDef, type FieldType, type ScopeParam } from './catalogue.ts'

export const QUERY_DEFAULT_LIMIT = 50
export const QUERY_MAX_LIMIT = 200

const scalar = z.union([z.string().max(200), z.number().finite(), z.boolean(), z.null()])
const fieldName = z.string().min(1).max(64)
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'a date, YYYY-MM-DD')

export const WHERE_OPS = ['=', '!=', '<', '<=', '>', '>=', 'in', 'between', 'contains'] as const
export const AGG_FNS = ['count', 'sum', 'avg', 'min', 'max', 'first', 'last', 'stddev'] as const

export const dataQuerySchema = z.object({
  dataset: z.enum(DATASETS).describe('which dataset; describe_data lists them with their fields'),
  params: z.object({
    stock: z.string().regex(STOCK_RE, 'an NSE symbol in upper case').optional(),
    expiry: isoDate.optional(),
    interval: z.enum(['5m', '15m']).optional(),
    days: z.number().int().min(1).max(400).optional(),
    of: z.enum(['spot', 'future']).optional(),
  }).strict().optional().describe('dataset scope, see describe_data'),
  where: z.array(z.object({
    field: fieldName,
    op: z.enum(WHERE_OPS),
    value: z.union([scalar, z.array(scalar).max(100)]).describe("a value; 'in' takes a list, 'between' a [low, high] pair"),
  }).strict()).max(20).optional(),
  select: z.array(fieldName).max(40).optional(),
  groupBy: z.array(fieldName).max(4).optional(),
  aggregate: z.array(z.object({
    fn: z.enum(AGG_FNS),
    field: fieldName.optional(),
    as: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,40}$/, 'a plain name'),
  }).strict()).max(12).optional(),
  orderBy: z.array(z.object({ field: fieldName, dir: z.enum(['asc', 'desc']) }).strict()).max(4).optional(),
  limit: z.number().int().min(1).max(QUERY_MAX_LIMIT).optional(),
}).strict()

export type DataQuery = z.infer<typeof dataQuerySchema>
export type Cell = string | number | boolean | null
export type Row = Readonly<Record<string, Cell>>

export interface Column { readonly name: string; readonly type: FieldType; readonly unit: string }
export interface ColumnSummary { readonly count: number; readonly min: number; readonly max: number; readonly mean: number; readonly sum: number }

export interface QueryResult {
  readonly dataset: string
  readonly columns: readonly Column[]
  readonly rows: readonly (readonly Cell[])[]
  readonly total: number
  readonly truncated: boolean
  readonly summary?: Readonly<Record<string, ColumnSummary>>
}

export class QueryError extends Error {}

const round = (x: number): number => Math.round(x * 1e4) / 1e4
const out = (v: Cell): Cell => (typeof v === 'number' ? (Number.isFinite(v) ? round(v) : null) : v)

/** Everything the catalogue cannot check by shape: fields exist, ops suit their types, aggregates have what they need. */
export function checkQuery(q: DataQuery, def: DatasetDef = defOf(q.dataset)): void {
  const fields = new Map(def.fields.map((x) => [x.name, x]))
  const names = def.fields.map((x) => x.name).join(', ')
  const field = (name: string, where: string): FieldDef => {
    const x = fields.get(name)
    if (x === undefined) throw new QueryError(`${where}: no field "${name}" in ${def.name}; its fields are ${names}`)
    return x
  }
  for (const [k, v] of Object.entries(q.params ?? {})) {
    if (v === undefined) continue
    const allowed = def.params[k as ScopeParam]
    if (allowed === undefined) {
      const takes = Object.keys(def.params)
      throw new QueryError(`params.${k}: ${def.name} takes ${takes.length === 0 ? 'no params' : `only ${takes.map((t) => `params.${t}`).join(', ')}`}`)
    }
  }
  for (const [k, spec] of Object.entries(def.params)) {
    if (spec.startsWith('required') && (q.params as Record<string, unknown> | undefined)?.[k] === undefined) throw new QueryError(`${def.name} needs params.${k}`)
  }
  const days = q.params?.days
  const maxDays = def.name === 'band_events' ? BAND_EVENTS_MAX_DAYS : def.name === 'trades' || def.name === 'orders' ? RECORDS_MAX_DAYS : null
  if (days !== undefined && maxDays !== null && days > maxDays) throw new QueryError(`params.days: ${def.name} reaches back at most ${maxDays} days`)
  for (const w of q.where ?? []) {
    const fd = field(w.field, 'where')
    if (w.op === 'in' && !Array.isArray(w.value)) throw new QueryError(`where ${w.field} in: the value must be a list`)
    if (w.op === 'between' && (!Array.isArray(w.value) || w.value.length !== 2)) throw new QueryError(`where ${w.field} between: the value must be [low, high]`)
    if (w.op !== 'in' && w.op !== 'between' && Array.isArray(w.value)) throw new QueryError(`where ${w.field} ${w.op}: the value must be a single value`)
    if (w.op === 'contains' && fd.type !== 'string') throw new QueryError(`where ${w.field} contains: only a text field can be searched`)
  }
  if ((q.groupBy !== undefined || q.aggregate !== undefined) && q.select !== undefined) {
    throw new QueryError('select lists raw rows; with groupBy or aggregate the columns are the groupBy fields and the aggregate names')
  }
  for (const s of q.select ?? []) field(s, 'select')
  for (const g of q.groupBy ?? []) field(g, 'groupBy')
  const aliases = new Set<string>()
  for (const a of q.aggregate ?? []) {
    if (aliases.has(a.as) || (q.groupBy ?? []).includes(a.as)) throw new QueryError(`aggregate: the name "${a.as}" is used twice`)
    aliases.add(a.as)
    if (a.fn === 'count') { if (a.field !== undefined) field(a.field, 'aggregate'); continue }
    if (a.field === undefined) throw new QueryError(`aggregate ${a.fn}: name the field it runs over`)
    const fd = field(a.field, 'aggregate')
    if ((a.fn === 'sum' || a.fn === 'avg' || a.fn === 'stddev') && fd.type !== 'number') throw new QueryError(`aggregate ${a.fn}(${a.field}): ${a.field} is not a number`)
  }
  const grouped = q.groupBy !== undefined || q.aggregate !== undefined
  const outCols = grouped ? new Set([...(q.groupBy ?? []), ...aliases]) : new Set(def.fields.map((x) => x.name))
  for (const o of q.orderBy ?? []) {
    if (!outCols.has(o.field)) {
      throw new QueryError(`orderBy: "${o.field}" is not a column of the result; order by one of ${[...outCols].join(', ')}`)
    }
  }
}

export function defOf(name: string): DatasetDef {
  const d = CATALOGUE.find((x) => x.name === name)
  if (d === undefined) throw new QueryError(`no dataset "${name}"; the datasets are ${CATALOGUE.map((x) => x.name).join(', ')}`)
  return d
}

function compare(a: Cell, b: Cell): number {
  if (a === b) return 0
  if (a === null) return 1   // nulls last, either direction is decided by the caller
  if (b === null) return -1
  if (typeof a === 'number' && typeof b === 'number') return a - b
  return String(a) < String(b) ? -1 : 1
}

function matches(v: Cell, op: (typeof WHERE_OPS)[number], value: Cell | readonly Cell[]): boolean {
  switch (op) {
    case '=': return v === value
    case '!=': return v !== value
    case '<': return v !== null && compare(v, value as Cell) < 0
    case '<=': return v !== null && compare(v, value as Cell) <= 0
    case '>': return v !== null && value !== null && compare(v, value as Cell) > 0
    case '>=': return v !== null && value !== null && compare(v, value as Cell) >= 0
    case 'in': return (value as readonly Cell[]).includes(v)
    case 'between': {
      const [lo, hi] = value as readonly Cell[]
      return v !== null && compare(v, lo ?? null) >= 0 && compare(v, hi ?? null) <= 0
    }
    case 'contains': return typeof v === 'string' && typeof value === 'string' && v.toLowerCase().includes(value.toLowerCase())
  }
}

function aggregate(fn: (typeof AGG_FNS)[number], rows: readonly Row[], field: string | undefined): Cell {
  if (fn === 'count') return field === undefined ? rows.length : rows.filter((r) => r[field] !== null && r[field] !== undefined).length
  const vals = rows.map((r) => r[field as string] ?? null)
  if (fn === 'first') return vals[0] ?? null
  if (fn === 'last') return vals[vals.length - 1] ?? null
  if (fn === 'min' || fn === 'max') {
    const present = vals.filter((v) => v !== null)
    if (present.length === 0) return null
    return present.reduce((m, v) => ((fn === 'min' ? compare(v, m) < 0 : compare(v, m) > 0) ? v : m))
  }
  const nums = vals.filter((v): v is number => typeof v === 'number' && Number.isFinite(v))
  if (nums.length === 0) return null
  const sum = nums.reduce((s, x) => s + x, 0)
  if (fn === 'sum') return sum
  const mean = sum / nums.length
  if (fn === 'avg') return mean
  if (nums.length < 2) return null
  return Math.sqrt(nums.reduce((s, x) => s + (x - mean) ** 2, 0) / (nums.length - 1))
}

function summarise(columns: readonly Column[], rows: readonly (readonly Cell[])[]): Record<string, ColumnSummary> {
  const out: Record<string, ColumnSummary> = {}
  columns.forEach((c, i) => {
    if (c.type !== 'number') return
    const nums = rows.map((r) => r[i]).filter((v): v is number => typeof v === 'number')
    if (nums.length === 0) return
    const sum = nums.reduce((s, x) => s + x, 0)
    out[c.name] = { count: nums.length, min: round(Math.min(...nums)), max: round(Math.max(...nums)), mean: round(sum / nums.length), sum: round(sum) }
  })
  return out
}

/** Runs a checked query over `rows` (every row carries every field of the dataset). */
export function runQuery(q: DataQuery, rows: readonly Row[], def: DatasetDef = defOf(q.dataset)): QueryResult {
  checkQuery(q, def)
  const fields = new Map(def.fields.map((x) => [x.name, x]))
  const filtered = rows.filter((r) => (q.where ?? []).every((w) => matches(r[w.field] ?? null, w.op, w.value)))

  let columns: Column[]
  let table: Cell[][]
  if (q.groupBy !== undefined || q.aggregate !== undefined) {
    const by = q.groupBy ?? []
    const aggs = q.aggregate ?? [{ fn: 'count' as const, as: 'count' }]
    const groups = new Map<string, Row[]>()
    for (const r of filtered) {
      const k = JSON.stringify(by.map((g) => r[g] ?? null))
      const list = groups.get(k)
      if (list === undefined) groups.set(k, [r])
      else list.push(r)
    }
    if (by.length === 0 && groups.size === 0) groups.set('[]', [])
    columns = [
      ...by.map((g) => { const fd = fields.get(g) as FieldDef; return { name: g, type: fd.type, unit: fd.unit } }),
      ...aggs.map((a) => {
        const fd = a.field === undefined ? undefined : fields.get(a.field)
        const numeric = a.fn === 'count' || a.fn === 'sum' || a.fn === 'avg' || a.fn === 'stddev'
        return { name: a.as, type: numeric ? 'number' as const : fd?.type ?? 'number', unit: a.fn === 'count' ? '' : fd?.unit ?? '' }
      }),
    ]
    table = [...groups.values()].map((list) => [...by.map((g) => list[0]?.[g] ?? null), ...aggs.map((a) => aggregate(a.fn, list, a.field))])
  } else {
    const sel = q.select ?? def.fields.map((x) => x.name)
    columns = sel.map((s) => { const fd = fields.get(s) as FieldDef; return { name: s, type: fd.type, unit: fd.unit } })
    table = filtered.map((r) => sel.map((s) => r[s] ?? null))
  }

  const order = q.orderBy ?? []
  if (order.length > 0) {
    const idx = order.map((o) => ({ i: columns.findIndex((c) => c.name === o.field), dir: o.dir === 'desc' ? -1 : 1 }))
    table = table
      .map((row, at) => ({ row, at }))
      .sort((a, b) => {
        for (const { i, dir } of idx) {
          const x = a.row[i] ?? null, y = b.row[i] ?? null
          if (x === y) continue
          if (x === null) return 1
          if (y === null) return -1
          return dir * compare(x, y)
        }
        return a.at - b.at
      })
      .map((x) => x.row)
  }

  table = table.map((r) => r.map(out))
  const limit = q.limit ?? QUERY_DEFAULT_LIMIT
  const total = table.length
  const truncated = total > limit
  return {
    dataset: def.name, columns, rows: table.slice(0, limit), total, truncated,
    ...(truncated ? { summary: summarise(columns, table) } : {}),
  }
}
