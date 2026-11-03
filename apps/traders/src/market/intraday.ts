/**
 * Today's 5- and 15-minute bars of every F&O underlying's spot and near future,
 * built in memory by sampling the quote cache once a second.
 *
 * WHY sampled and not fetched: the app holds no broker credential and must not
 * get one, and desk-marketdata's history endpoint sits behind the desk's token
 * (spec §5). The quote cache is fed read-only from the bus, so the bars are the
 * prices this app already shows. What that costs, said where it is read:
 *   - a bar is built from the ticks the sampler saw: one per second at most, so
 *     a high or low inside a second can be missed;
 *   - bars live in memory for today only: a restart loses the morning, and
 *     `coverage().since` says when sampling began (the context then has no open
 *     and no opening range);
 *   - volume comes from the tick's cumulative day volume (a bar's volume is the
 *     rise across it); a quote with none (an index) gives 0, never a guess.
 *
 * A tick is placed by its own time (`asOf`), not the sampler's, and only when
 * it is new, of today (IST), and in session (09:15 to before 15:40). Bars start
 * on IST clock multiples of 5 minutes; 15-minute bars are three of them folded.
 * A new IST day starts empty. The underlyings and their tokens are listed again
 * every minute (the near future rolls at an expiry; the master is refreshed).
 */

import { marketOpenAt } from '../analytics/calendar.ts'
import type { Bar } from '../analytics/context-wire.ts'
import { IST_OFFSET_MS, istDate, type Log } from '../routes/kit.ts'
import { nearestFuture, spotTokenOf, type TradersMaster } from './master.ts'
import type { TradersQuotes } from './quotes.ts'

export const SAMPLE_EVERY_MS = 1_000
export const WATCH_LIST_MS = 60_000
const MS_5M = 5 * 60_000
const MS_15M = 15 * 60_000

export type IntradayInterval = '5m' | '15m'
/** Which instrument of the underlying: its spot (an index's value) or its nearest listed future. */
export type IntradayOf = 'spot' | 'future'

interface MutableBar { t: number; o: number; h: number; l: number; c: number; v: number }

interface Series {
  readonly bars: MutableBar[]
  /** The newest tick time placed. */
  lastAsOf: number
  /** The cumulative day volume when the current bar began; null = none seen. */
  barBase: number | null
  lastCum: number | null
}

const startOf = (ms: number, size: number): number => Math.floor((ms + IST_OFFSET_MS) / size) * size - IST_OFFSET_MS

export class IntradayBars {
  readonly #master: () => TradersMaster
  readonly #quotes: TradersQuotes
  readonly #now: () => number
  readonly #everyMs: number
  readonly #log: Log
  #day: string | null = null
  #since: number | null = null
  readonly #series = new Map<string, Series>()
  #watch: readonly { readonly key: string; readonly token: number }[] = []
  #watchAt = -Infinity
  #watchMaster: TradersMaster | null = null
  #timer: ReturnType<typeof setInterval> | null = null
  #failing = false

  constructor(d: {
    readonly master: () => TradersMaster; readonly quotes: TradersQuotes; readonly now: () => number
    readonly everyMs?: number; readonly log?: Log
  }) {
    this.#master = d.master
    this.#quotes = d.quotes
    this.#now = d.now
    this.#everyMs = d.everyMs ?? SAMPLE_EVERY_MS
    this.#log = d.log ?? (() => {})
  }

  /** Samples every second until `stop()`; the timer never holds the process open. A second call is a no-op. */
  start(): void {
    if (this.#timer !== null) return
    this.#timer = setInterval(() => this.sample(), this.#everyMs)
    this.#timer.unref()
  }

  stop(): void {
    if (this.#timer !== null) clearInterval(this.#timer)
    this.#timer = null
  }

  /** One pass over the quote cache. Never throws: a pass that fails is logged once and the next one tries again. */
  sample(nowMs: number = this.#now()): void {
    try {
      this.#sample(nowMs)
      this.#failing = false
    } catch (err) {
      if (!this.#failing) this.#log('intraday sampling failed', { error: err instanceof Error ? err.message : String(err) })
      this.#failing = true
    }
  }

  /** Today's bars of `stock`, oldest → newest (the last one still forming); [] when none. */
  bars(stock: string, interval: IntradayInterval, of: IntradayOf = 'spot'): readonly Bar[] {
    const s = this.#series.get(`${stock}|${of}`)
    if (s === undefined) return []
    if (interval === '5m') return s.bars.map((b) => ({ ...b }))
    const out: MutableBar[] = []
    for (const b of s.bars) {
      const t = startOf(b.t, MS_15M)
      const last = out.at(-1)
      if (last === undefined || last.t !== t) out.push({ ...b, t })
      else { last.h = Math.max(last.h, b.h); last.l = Math.min(last.l, b.l); last.c = b.c; last.v += b.v }
    }
    return out
  }

  /** The IST day the bars are of, and when sampling began that day (null before the first pass). */
  coverage(): { readonly day: string | null; readonly since: number | null } {
    return { day: this.#day, since: this.#since }
  }

  #sample(nowMs: number): void {
    const today = istDate(nowMs)
    if (today !== this.#day) {
      this.#day = today
      this.#since = nowMs
      this.#series.clear()
      this.#watchAt = -Infinity
    }
    const m = this.#master()
    if (m !== this.#watchMaster || nowMs - this.#watchAt >= WATCH_LIST_MS) {
      const watch: { key: string; token: number }[] = []
      for (const u of m.options.underlyings()) {
        const spot = spotTokenOf(m, u)
        if (spot !== null) watch.push({ key: `${u}|spot`, token: spot })
        const fut = nearestFuture(m, u, today)?.instrumentToken
        if (fut !== undefined) watch.push({ key: `${u}|future`, token: fut })
      }
      this.#watch = watch
      this.#watchAt = nowMs
      this.#watchMaster = m
    }
    for (const { key, token } of this.#watch) {
      const q = this.#quotes.quote(token)
      if (q === null || !(q.price > 0) || !Number.isFinite(q.price)) continue
      const s = this.#series.get(key)
      if (s !== undefined && q.asOf <= s.lastAsOf) continue
      if (istDate(q.asOf) !== today || !marketOpenAt(q.asOf)) continue
      const series = s ?? { bars: [], lastAsOf: 0, barBase: null, lastCum: null }
      if (s === undefined) this.#series.set(key, series)
      this.#place(series, q.price, q.asOf, typeof q.volume === 'number' && Number.isFinite(q.volume) && q.volume >= 0 ? q.volume : null)
    }
  }

  #place(s: Series, price: number, asOf: number, cum: number | null): void {
    s.lastAsOf = asOf
    const t = startOf(asOf, MS_5M)
    let bar = s.bars.at(-1)
    if (bar === undefined || bar.t !== t) {
      // the volume a bar holds is the cumulative day volume's rise from the last reading before it
      s.barBase = s.lastCum ?? cum
      bar = { t, o: price, h: price, l: price, c: price, v: 0 }
      s.bars.push(bar)
    } else {
      bar.h = Math.max(bar.h, price)
      bar.l = Math.min(bar.l, price)
      bar.c = price
    }
    if (cum !== null) {
      if (s.barBase === null) s.barBase = cum
      bar.v = Math.max(0, cum - s.barBase)
      s.lastCum = cum
    }
  }
}
