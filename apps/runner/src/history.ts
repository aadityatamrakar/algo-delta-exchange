/**
 * The `HistoryFetcher` the runner was missing.
 *
 * `RunnerMarketData.seed()` is a no-op without one — `market-data.ts:200`
 * returns immediately when `history` is undefined — and `main.ts` never injected
 * one, so EVERY candle series in the runner started cold and filled only from
 * live ticks. A strategy needing 15 completed hourly bars therefore had them at
 * roughly 09:15 + 15 hours, i.e. never: `ATR_BAND_NIFTY` logged "not enough
 * hourly candles, retrying in 30s" until the day ended, and would have done so
 * on the first paper day and every day after it.
 *
 * IT TALKS TO `apps/marketdata`, NOT TO KITE. The runner has no broker
 * credentials by design and must not grow any; the market-data process already
 * holds the single Kite login and now exposes a read-only
 * `GET /v1/md/history`. This adapter is the client half.
 *
 * FAIL-SOFT IS THE CALLER'S JOB, deliberately. `seed()` already catches per
 * series so one instrument's failure cannot abort a batch, and it logs which
 * one. Swallowing failures here too would mean a series that seeded EMPTY and a
 * series that seeded successfully looked identical.
 */

import type { Interval as StoreInterval } from '@algomaker/marketdata-core'
import type { Candle, Logger } from '@algomaker/strategy-kit'
import type { HistoryFetcher } from './market-data.ts'

export interface HttpHistoryFetcherDeps {
  /** The market-data process, e.g. `http://127.0.0.1:8892`. */
  readonly baseUrl: string
  /** `DESK_API_TOKEN` — the same machine principal the bridge authenticates. */
  readonly token: string
  readonly log: Logger
  /** Injected so the adapter is testable with no socket. */
  fetch?: typeof globalThis.fetch
  /**
   * Deadline for one request.
   *
   * `fetch` has NO timeout of its own, and `seed()` is awaited on the path that
   * builds a strategy. Without this, a market-data process that accepts the
   * connection and then never answers would hold up the runner's boot — the
   * "gating boot on something external" mistake `main.ts`'s header names.
   */
  readonly timeoutMs?: number
}

const DEFAULT_TIMEOUT_MS = 20_000

/** A finite number, or null. Never a coercion — see the loop in `bars`. */
function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

export class HttpHistoryFetcher implements HistoryFetcher {
  readonly #d: HttpHistoryFetcherDeps

  constructor(deps: HttpHistoryFetcherDeps) {
    this.#d = deps
  }

  async bars(
    token: number,
    interval: StoreInterval,
    count: number,
  ): Promise<readonly Candle[]> {
    const doFetch = this.#d.fetch ?? globalThis.fetch
    const url = `${this.#d.baseUrl}/v1/md/history?token=${token}&interval=${interval}&count=${count}`
    const res = await doFetch(url, {
      headers: { authorization: `Bearer ${this.#d.token}` },
      signal: AbortSignal.timeout(this.#d.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    })
    const text = await res.text()
    if (!res.ok) throw new Error(`history HTTP ${res.status}: ${text.slice(0, 200)}`)
    const body = JSON.parse(text) as { candles?: unknown }
    const raw = body.candles
    if (!Array.isArray(raw)) throw new Error('history response carried no candles array')
    /**
     * Re-validated on THIS side of the wire as well.
     *
     * Not defensiveness for its own sake: these bars go straight into
     * `CandleStore.seed`, and one row with a NaN close makes every ATR and every
     * breakout band computed off that series NaN — which reads downstream as
     * "the strategy declined to trade" rather than as a data fault. Dropping the
     * row loses one bar; keeping it loses the day, silently.
     */
    const out: Candle[] = []
    for (const row of raw as readonly Record<string, unknown>[]) {
      if (row === null || typeof row !== 'object') continue
      const values = (['ts', 'open', 'high', 'low', 'close'] as const).map((k) => num(row[k]))
      // `Number(null)` is 0 and `Number('')` is 0, so the check is on the TYPE,
      // not on `Number.isFinite` of a coercion. A null low that coerced to 0
      // would look like a perfectly valid bar and drag an ATR to several
      // thousand points.
      if (values.some((v) => v === null)) continue
      const [ts, open, high, low, close] = values as [number, number, number, number, number]
      const volume = num(row['volume'])
      out.push({ ts, open, high, low, close, ...(volume === null ? {} : { volume }) })
    }
    if (out.length < raw.length) {
      this.#d.log.warn('runner history: dropped unusable bars', {
        token,
        interval,
        received: raw.length,
        usable: out.length,
      })
    }
    return out
  }
}
