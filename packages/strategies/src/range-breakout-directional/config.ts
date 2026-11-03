import type { BaseConfig, ExitRules } from '@algomaker/strategy-config'
import { assertValidConfig } from '@algomaker/strategy-config'
import type { Interval } from '@algomaker/strategy-kit'

/**
 * `atr-anchor` is the ONLY band source that forms in TWO phases, at TWO times,
 * off TWO DIFFERENT candle series — see design spec §4 "Multiple timeframes per
 * strategy", which names this strategy as the reason the model supports several
 * intervals at once.
 *
 *   `formAtIstMinute`   10:15, `widthInterval`  60minute -> the ATR-14/3 WIDTH
 *   `anchorAtIstMinute` 11:40, `anchorInterval` 5minute  -> the LINES, at
 *                                                           anchorClose +/- width
 *
 * They are separate fields rather than one `formAtIstMinute` because collapsing
 * them is the actual port defect this shape exists to make unrepresentable: a
 * single form-time forces the anchor to be a 60-minute close taken at 10:15,
 * which moves both lines by whatever the index does in the 85 minutes to 11:40.
 */
export type BandSource =
  | { readonly source: 'opening-range'; readonly candleCount: number; readonly bufferPct: number; readonly rangeFilterPts: number; readonly formAtIstMinute: number }
  | { readonly source: 'first-candle-pct'; readonly pct: number; readonly formAtIstMinute: number }
  | {
      readonly source: 'atr-anchor'
      readonly atrPeriod: number
      readonly divisor: number
      readonly formAtIstMinute: number
      readonly widthInterval: Interval
      readonly anchorAtIstMinute: number
      readonly anchorInterval: Interval
    }

export type ExecutionMapping = 'atm-option-of-side' | 'signal-instrument-itself'

export interface RangeBreakoutDirectionalConfig extends BaseConfig {
  readonly class: 'range-breakout-directional'
  readonly band: BandSource
  readonly executionMapping: ExecutionMapping
  readonly exit: ExitRules
  readonly entryCheckEveryMinutes: number
  readonly entryDeadlineIstMinute: number
  readonly squareOffIstMinute: number
  /** bn-breakout: 1 trade per SIDE, a non-loss ends the day. Others: 1 per day. */
  readonly dayBudget:
    | { readonly kind: 'per-day' }
    | { readonly kind: 'per-side'; readonly stopDayOnNonLoss: boolean }
  readonly timeStopMinutes?: number
}

export function assertValidRangeBreakoutConfig(
  cfg: RangeBreakoutDirectionalConfig,
  existingTags?: ReadonlySet<string>,
): void {
  assertValidConfig(cfg, existingTags, cfg.exit)
  if (cfg.entryDeadlineIstMinute <= (cfg.band.formAtIstMinute)) {
    throw new Error('entryDeadlineIstMinute must be after the band forms')
  }
  if (cfg.band.source === 'atr-anchor') {
    // The lines cannot be anchored before the width they are built from exists,
    // and there must be a real entry window left after they are. Ordering these
    // wrong does not throw at runtime — it silently produces a day with either no
    // band or no entries, which looks identical in the logs to "no signal today".
    if (cfg.band.anchorAtIstMinute <= cfg.band.formAtIstMinute) {
      throw new Error('band.anchorAtIstMinute must be after band.formAtIstMinute (width first, then lines)')
    }
    if (cfg.entryDeadlineIstMinute <= cfg.band.anchorAtIstMinute) {
      throw new Error('entryDeadlineIstMinute must be after band.anchorAtIstMinute')
    }
  }
}
