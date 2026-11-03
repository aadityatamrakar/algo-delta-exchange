/**
 * Daily returns for the risk view (spec 2026-10-24-traders-risk-design.md R3, R5, R7): log returns of closes aligned
 * by date, beta and correlation to NIFTY, the nearest-rank percentile the replay's VaR reads, and the union-find that
 * joins correlated stocks into clusters. Pure: bars in, numbers out.
 *
 * Alignment is on the CLOSES: only dates every series has a close on are kept, and each return runs from the previous
 * kept date to this one — so a day one series is missing merges two days into one return in every series alike, and
 * no return ever pairs one stock's one-day move with another's two-day move.
 *
 * Under `MIN_DAYS` returns a beta or correlation is null (the caller warns); at most the last `MAX_DAYS` are used.
 */

/** Fewer aligned returns than this: no beta, no correlation (R3). */
export const MIN_DAYS = 60
/** At most this many of the newest aligned returns (R3). */
export const MAX_DAYS = 250
/** Pairwise correlation at or above this joins two stocks (R7). */
export const CLUSTER_CORR = 0.6

/** What a bar series needs here: its date and close (HistoryStore.bars, oldest → newest, back-adjusted). */
export interface Close {
  readonly date: string
  readonly close: number
}

/** Aligned returns: `dates[k]` is the day `returns[s][k]` ends on and `starts[k]` the kept date before it, oldest first. */
export interface Aligned {
  readonly dates: readonly string[]
  readonly starts: readonly string[]
  readonly returns: readonly (readonly number[])[]
}

const usable = (c: Close): boolean => typeof c.close === 'number' && Number.isFinite(c.close) && c.close > 0

/**
 * The daily log returns of every series over the dates all of them have a usable close on, the newest `max` kept.
 * A date given twice in one series keeps its last bar. Empty when any series is empty.
 */
export function alignedReturns(series: readonly (readonly Close[])[], max: number = MAX_DAYS): Aligned {
  if (series.length === 0) return { dates: [], starts: [], returns: [] }
  const maps = series.map((s) => new Map(s.filter(usable).map((c) => [c.date, c.close])))
  const first = maps[0] as Map<string, number>
  const common = [...first.keys()].filter((d) => maps.every((m) => m.has(d))).sort()
  const dates: string[] = []
  const starts: string[] = []
  const returns: number[][] = series.map(() => [])
  for (let k = 1; k < common.length; k++) {
    const prev = common[k - 1] as string
    const day = common[k] as string
    dates.push(day)
    starts.push(prev)
    maps.forEach((m, i) => (returns[i] as number[]).push(Math.log((m.get(day) as number) / (m.get(prev) as number))))
  }
  const from = Math.max(0, dates.length - Math.max(0, Math.floor(max)))
  return { dates: dates.slice(from), starts: starts.slice(from), returns: returns.map((r) => r.slice(from)) }
}

/** Beta of `a` to `b`, their correlation, and how many aligned returns they rest on; null under `MIN_DAYS` or a flat series. */
export interface PairStats {
  readonly beta: number | null
  readonly corr: number | null
  readonly days: number
}

/** cov(a, b) ÷ var(b) and cov ÷ (σa σb) over two equal-length return lists. */
export function pairOf(a: readonly number[], b: readonly number[]): PairStats {
  const n = Math.min(a.length, b.length)
  if (n < MIN_DAYS) return { beta: null, corr: null, days: n }
  let ma = 0
  let mb = 0
  for (let k = 0; k < n; k++) { ma += a[k] as number; mb += b[k] as number }
  ma /= n
  mb /= n
  let cov = 0
  let va = 0
  let vb = 0
  for (let k = 0; k < n; k++) {
    const x = (a[k] as number) - ma
    const y = (b[k] as number) - mb
    cov += x * y
    va += x * x
    vb += y * y
  }
  const beta = vb > 0 ? cov / vb : null
  const corr = va > 0 && vb > 0 ? Math.max(-1, Math.min(1, cov / Math.sqrt(va * vb))) : null
  return { beta: beta !== null && Number.isFinite(beta) ? beta : null, corr: corr !== null && Number.isFinite(corr) ? corr : null, days: n }
}

/** Beta and correlation of `stock`'s closes to `index`'s (R3): aligned by date, the last ≤ `MAX_DAYS` returns. */
export function betaOf(stock: readonly Close[], index: readonly Close[]): PairStats {
  const { returns } = alignedReturns([stock, index])
  return pairOf(returns[0] ?? [], returns[1] ?? [])
}

/**
 * Nearest-rank percentile, `p` in (0, 100]: the ⌈p/100 × n⌉-th smallest value. Null for an empty list or a `p`
 * outside the range. With losses negative, p = 5 is the 95% VaR (R5).
 */
export function percentile(xs: readonly number[], p: number): number | null {
  if (xs.length === 0 || !(p > 0 && p <= 100)) return null
  const sorted = [...xs].sort((x, y) => x - y)
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length))
  return sorted[rank - 1] as number
}

/**
 * Groups of indices joined when `corr[i][j] ≥ threshold`, transitively (union-find, R7). Only groups of two or more,
 * each in ascending index order, the groups by their first index. A null correlation joins nothing.
 */
export function clustersOf(corr: readonly (readonly (number | null)[])[], threshold: number = CLUSTER_CORR): number[][] {
  const n = corr.length
  const parent = Array.from({ length: n }, (_, i) => i)
  const find = (i: number): number => {
    let r = i
    while (parent[r] !== r) r = parent[r] as number
    while (parent[i] !== r) { const next = parent[i] as number; parent[i] = r; i = next }
    return r
  }
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const c = corr[i]?.[j] ?? null
      if (c !== null && c >= threshold) {
        const [a, b] = [find(i), find(j)]
        if (a !== b) parent[Math.max(a, b)] = Math.min(a, b)
      }
    }
  }
  const groups = new Map<number, number[]>()
  for (let i = 0; i < n; i++) {
    const r = find(i)
    const g = groups.get(r)
    if (g === undefined) groups.set(r, [i])
    else g.push(i)
  }
  return [...groups.values()].filter((g) => g.length >= 2).sort((x, y) => (x[0] as number) - (y[0] as number))
}
