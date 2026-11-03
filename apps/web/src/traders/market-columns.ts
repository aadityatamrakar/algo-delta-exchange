/** Market Watch's columns: which, in what order, and what the page remembers of that. */

export type MarketColumn =
  | 'oiChange' | 'oi' | 'bf' | 'bf2' | 'straddle' | 'ratio' | 'volume'
  | 'delta' | 'gamma' | 'vega' | 'theta' | 'change' | 'changePct' | 'iv' | 'ltp'

/** Spec item 24's order, calls outward to inward; puts mirror it. Straddle sits by the strike. */
export const DEFAULT_COLUMNS: readonly MarketColumn[] = [
  'oiChange', 'oi', 'bf', 'bf2', 'straddle', 'ratio', 'volume', 'delta', 'gamma', 'vega', 'theta', 'change', 'changePct', 'iv', 'ltp',
]

export const COLUMN_LABELS: Readonly<Record<MarketColumn, string>> = {
  oiChange: 'OI chg', oi: 'OI', bf: 'BF', bf2: 'BF2', straddle: 'Straddle', ratio: 'Ratio', volume: 'Volume',
  delta: 'Delta', gamma: 'Gamma', vega: 'Vega', theta: 'Theta', change: 'Chg', changePct: 'Chg %', iv: 'IV %', ltp: 'LTP',
}

export const COLUMNS_KEY = 'traders.market.columns'

const KNOWN: ReadonlySet<string> = new Set(DEFAULT_COLUMNS)

/** The saved columns; the defaults when nothing usable is saved. Unknown names are dropped. */
export function loadColumns(storage: Pick<Storage, 'getItem'> | null): MarketColumn[] {
  try {
    const raw = storage?.getItem(COLUMNS_KEY)
    if (typeof raw !== 'string') return [...DEFAULT_COLUMNS]
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return [...DEFAULT_COLUMNS]
    const cols = [...new Set(parsed.filter((c): c is MarketColumn => typeof c === 'string' && KNOWN.has(c)))]
    return cols.length === 0 ? [...DEFAULT_COLUMNS] : cols
  } catch {
    return [...DEFAULT_COLUMNS]
  }
}

export function saveColumns(storage: Pick<Storage, 'setItem'> | null, cols: readonly MarketColumn[]): void {
  try {
    storage?.setItem(COLUMNS_KEY, JSON.stringify(cols))
  } catch {
    // Private window or blocked site data: the choice lasts this visit only.
  }
}
