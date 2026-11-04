/**
 * A QUIET SOCKET IS FILLED FROM REST, so a held leg's quote does not go stale
 * for want of a push.
 *
 * Delta's ticker socket pushes every contract every 5 s, but it pauses: the
 * testnet stream went silent on every held contract at once for 32 s and for
 * ~60 s on 4 Nov with the socket still open. The engine reads a held leg's
 * quote older than `bs_quote_max_age_s` (20 s) as stale — no new straddle —
 * and past `bs_stale_exit_s` buys the straddle back. A LIVE book has no
 * second feed to fall back to, so a long enough pause would close it.
 *
 * Every `everyMs` this asks the feed which HELD contracts it has not heard
 * from in `gapMs` and reads those from Delta's REST tickers, laying each in
 * with `DxFeed.fill` — the exchange's own timestamp, and only when newer than
 * what the feed holds. A market that is really frozen therefore stays stale:
 * this fills a quiet socket, never a quiet market.
 *
 * A few silent contracts are read one by one (`/v2/tickers/{symbol}`, the
 * freshest answer); more than `perSymbolMax` — the whole socket gone quiet —
 * is one `/v2/tickers` call for every BTC option.
 *
 * Each gap logs once when it opens and once when the socket is back, never
 * every pass.
 */

import { quoteFromTicker, type DxTicker } from '@algomaker/dx'
import type { DxFeed } from './dx-feed.ts'

/** Silent this long → read from REST. Two missed 5 s pushes. */
export const GAP_FILL_AFTER_MS = 10_000
export const GAP_FILL_EVERY_MS = 3_000
/** Above this many silent contracts, one bulk call instead of one call each. */
export const GAP_FILL_PER_SYMBOL_MAX = 10

export interface GapFillDeps {
  readonly feed: Pick<DxFeed, 'silent' | 'fill'>
  /** The contracts to keep fresh: every leg a book holds. */
  readonly held: () => readonly string[]
  readonly ticker: (symbol: string) => Promise<DxTicker>
  /** Every BTC option's ticker. */
  readonly tickers: () => Promise<readonly DxTicker[]>
  readonly gapMs?: number
  readonly perSymbolMax?: number
  readonly label?: string
  readonly log?: (msg: string, ctx?: Record<string, unknown>) => void
}

export interface GapFillPass {
  readonly silent: readonly string[]
  readonly filled: readonly string[]
}

export class DxGapFill {
  readonly #d: GapFillDeps
  /** Contracts in an open gap, so each gap logs once. */
  readonly #open = new Set<string>()
  #running = false
  #timer: ReturnType<typeof setInterval> | null = null
  #failing = false

  constructor(d: GapFillDeps) {
    this.#d = d
  }

  start(everyMs: number = GAP_FILL_EVERY_MS): void {
    if (this.#timer !== null) return
    this.#timer = setInterval(() => void this.runOnce(), everyMs)
    this.#timer.unref?.()
  }

  stop(): void {
    if (this.#timer !== null) clearInterval(this.#timer)
    this.#timer = null
  }

  /** One pass. Never throws; overlapping passes are skipped. */
  async runOnce(): Promise<GapFillPass> {
    if (this.#running) return { silent: [], filled: [] }
    this.#running = true
    try {
      return await this.#pass()
    } catch (err) {
      this.#d.log?.(`${this.#d.label ?? 'dx'} gap fill: pass failed`, { error: err instanceof Error ? err.message : String(err) })
      return { silent: [], filled: [] }
    } finally {
      this.#running = false
    }
  }

  async #pass(): Promise<GapFillPass> {
    const log = (msg: string, ctx?: Record<string, unknown>): void =>
      this.#d.log?.(`${this.#d.label ?? 'dx'} gap fill: ${msg}`, ctx)
    const silent = this.#d.feed.silent(this.#d.held(), this.#d.gapMs ?? GAP_FILL_AFTER_MS)
    const now = new Set(silent)
    const back = [...this.#open].filter((s) => !now.has(s))
    for (const s of back) this.#open.delete(s)
    if (back.length > 0) log('socket ticking again', { contracts: back.sort() })
    if (silent.length === 0) return { silent, filled: [] }

    let rows: readonly DxTicker[]
    try {
      if (silent.length > (this.#d.perSymbolMax ?? GAP_FILL_PER_SYMBOL_MAX)) {
        rows = (await this.#d.tickers()).filter((t) => now.has(t.symbol))
      } else {
        const got = await Promise.allSettled(silent.map((s) => this.#d.ticker(s)))
        rows = got.flatMap((g) => (g.status === 'fulfilled' ? [g.value] : []))
        const failed = got.find((g): g is PromiseRejectedResult => g.status === 'rejected')
        if (failed !== undefined && rows.length === 0) throw failed.reason
      }
      if (this.#failing) log('REST reads working again')
      this.#failing = false
    } catch (err) {
      if (!this.#failing) log('REST read failed', { error: err instanceof Error ? err.message : String(err) })
      this.#failing = true
      rows = []
    }

    const filled: string[] = []
    for (const t of rows) {
      if (this.#d.feed.fill(quoteFromTicker(t))) filled.push(t.symbol)
    }
    const opened = silent.filter((s) => !this.#open.has(s))
    for (const s of opened) this.#open.add(s)
    if (opened.length > 0) {
      log('socket quiet, reading REST', {
        contracts: [...opened].sort(),
        filled: filled.filter((s) => opened.includes(s)).sort(),
      })
    }
    return { silent, filled }
  }
}
