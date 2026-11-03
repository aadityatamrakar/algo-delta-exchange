import { parseCsv } from './csv.ts'

export interface EodContract {
  readonly stock: string
  readonly instrument: 'option' | 'future' | 'share'
  /** '' for a share */
  readonly expiry: string
  readonly strike: number | null
  readonly optType: 'CE' | 'PE' | null
}
/** oi is null on cash rows */
export interface EodRow extends EodContract { readonly close: number; readonly oi: number | null }

export class EodParseError extends Error {}

export function eodKey(c: EodContract): string {
  return `${c.stock}|${c.instrument}|${c.expiry}|${c.strike ?? ''}|${c.optType ?? ''}`
}

/*
 * NSE end-of-day bhavcopies, either generation, picked by the header (V-J2:
 * verify on the operator's first download). The CLOSE price is used, never the
 * settlement price (SttlmPric / SETTLE_PR): whether VolHedge's "previous" basis
 * is the close or the settlement is Phase 0 Q3.
 */

const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC']

function isoDate(s: string): string | null {
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s
  const m = /^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/.exec(s)
  const mo = m ? MONTHS.indexOf(m[2]!.toUpperCase()) : -1
  return m && mo >= 0 ? `${m[3]}-${String(mo + 1).padStart(2, '0')}-${m[1]!.padStart(2, '0')}` : null
}

interface Table { col: (name: string) => number; rows: string[][] }

/** Finds the first generation whose columns are all in the header; throws naming the missing columns when none fits. */
function table(csv: string, generations: readonly (readonly string[])[]): { gen: number; t: Table } {
  const all = parseCsv(csv)
  const head = (all[0] ?? []).map((h) => h.trim())
  const col = (name: string): number => head.indexOf(name)
  for (let g = 0; g < generations.length; g++) {
    if (generations[g]!.every((c) => col(c) >= 0)) return { gen: g, t: { col, rows: all.slice(1) } }
  }
  const missing = generations.map((g) => g.filter((c) => col(c) < 0).join(', '))
  throw new EodParseError(`bhavcopy header matches neither generation; missing ${missing.join(' | or | ')} (header: ${head.join(',')})`)
}

/** Rows we wanted but could not read: one is skipped, all of them means the layout is not what we think. */
class Bad {
  first = ''
  note(n: number, why: string): void { if (!this.first) this.first = `row ${n + 2}: ${why}` }   // +2: header is row 1
  check(wanted: number, read: number): void {
    if (wanted > 0 && read === 0) throw new EodParseError(`no row could be read — first bad row: ${this.first}`)
  }
}

function cell(r: string[], i: number): string { return r[i] ?? '' }

// column order is the destructuring order in parseFoBhavcopy: symbol, kind, expiry, strike, option type, close, open interest
const FO_UDIFF = ['TckrSymb', 'FinInstrmTp', 'XpryDt', 'StrkPric', 'OptnTp', 'ClsPric', 'OpnIntrst'] as const
const FO_LEGACY = ['SYMBOL', 'INSTRUMENT', 'EXPIRY_DT', 'STRIKE_PR', 'OPTION_TYP', 'CLOSE', 'OPEN_INT'] as const
const CM_UDIFF = ['TckrSymb', 'SctySrs', 'ClsPric'] as const
const CM_LEGACY = ['SYMBOL', 'SERIES', 'CLOSE'] as const

export function parseFoBhavcopy(csv: string): readonly EodRow[] {
  const { gen, t } = table(csv, [FO_UDIFF, FO_LEGACY])
  const [cSym, cKind, cExp, cStrike, cOpt, cClose, cOi] = (gen === 0 ? FO_UDIFF : FO_LEGACY).map((n) => t.col(n)) as [number, number, number, number, number, number, number]
  const out: EodRow[] = []
  const bad = new Bad()
  let wanted = 0
  for (const [n, r] of t.rows.entries()) {
    const kind = cell(r, cKind)
    const instrument = gen === 0
      ? (kind === 'STO' || kind === 'IDO' ? 'option' : kind === 'STF' || kind === 'IDF' ? 'future' : null)
      : (kind === 'OPTSTK' || kind === 'OPTIDX' ? 'option' : kind === 'FUTSTK' || kind === 'FUTIDX' ? 'future' : null)
    const expiry = isoDate(cell(r, cExp))
    const close = Number(cell(r, cClose))
    if (!instrument) continue
    wanted++
    if (!expiry) { bad.note(n, `unreadable expiry '${cell(r, cExp)}'`); continue }
    if (cell(r, cClose) === '' || !Number.isFinite(close)) { bad.note(n, `unreadable close '${cell(r, cClose)}'`); continue }
    let strike: number | null = null
    let optType: 'CE' | 'PE' | null = null
    if (instrument === 'option') {
      strike = Number(cell(r, cStrike))
      optType = cell(r, cOpt) === 'CE' ? 'CE' : cell(r, cOpt) === 'PE' ? 'PE' : null
      if (cell(r, cStrike) === '' || !Number.isFinite(strike) || !optType) { bad.note(n, `unreadable strike or option type '${cell(r, cStrike)}' '${cell(r, cOpt)}'`); continue }
    }
    const oi = cell(r, cOi) === '' ? null : Number(cell(r, cOi))
    out.push({ stock: cell(r, cSym), instrument, expiry, strike, optType, close, oi: oi !== null && Number.isFinite(oi) ? oi : null })
  }
  bad.check(wanted, out.length)
  return out
}

export function parseCmBhavcopy(csv: string): readonly EodRow[] {
  const { gen, t } = table(csv, [CM_UDIFF, CM_LEGACY])
  const [cSym, cSeries, cClose] = (gen === 0 ? CM_UDIFF : CM_LEGACY).map((n) => t.col(n)) as [number, number, number]
  const out: EodRow[] = []
  const bad = new Bad()
  let wanted = 0
  for (const [n, r] of t.rows.entries()) {
    if (cell(r, cSeries) !== 'EQ') continue
    wanted++
    const close = Number(cell(r, cClose))
    if (cell(r, cClose) === '' || !Number.isFinite(close)) { bad.note(n, `unreadable close '${cell(r, cClose)}'`); continue }
    out.push({ stock: cell(r, cSym), instrument: 'share', expiry: '', strike: null, optType: null, close, oi: null })
  }
  bad.check(wanted, out.length)
  return out
}
