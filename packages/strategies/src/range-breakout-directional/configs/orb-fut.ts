import type { RangeBreakoutDirectionalConfig } from '../config.ts'

function orbFutConfig(
  tag: string, symbol: 'BANKNIFTY' | 'NIFTY' | 'SENSEX', strikeStep: number,
  rangeFilterPts: number, lots: number, legacyFile: string,
): RangeBreakoutDirectionalConfig {
  return {
    tag, class: 'range-breakout-directional', enabled: true,
    underlying: { symbol, reference: 'current-future', strikeStep },
    strike: { offsetPoints: 0 }, expiry: { select: 'nearest' },
    session: { startAt: '09:15:00', squareOffAt: '15:15:00' },
    sizing: { kind: 'flat', lots },
    rail: { mode: 'sim', destinations: ['sim'], exitMechanism: 'local-tick' },
    risk: { maxLotsNet: lots, dayLossRupees: null },
    data: [{ kind: 'future', underlying: symbol }],
    legacy: { files: [legacyFile, 'server/slive/orb-fut-core.js', 'server/slive/orb-fut-logic.js'] },
    band: { source: 'opening-range', candleCount: 6, bufferPct: 0.001, rangeFilterPts, formAtIstMinute: 9 * 60 + 45 },
    executionMapping: 'signal-instrument-itself',
    exit: {
      stop: { basis: 'fixed-points', value: 0 }, target: { basis: 'none' },
      precedence: ['EOD', 'SL', 'T1'], stopMeasuredOn: 'traded', stopPolicy: 'local-tick',
    },
    entryCheckEveryMinutes: 5, entryDeadlineIstMinute: 14 * 60, squareOffIstMinute: 15 * 60 + 15,
    dayBudget: { kind: 'per-day' },
  }
}

// rangeFilterPts/lots/bufferPct copied verbatim from the legacy wrapper literals.
export const ORB_FUT_BN = orbFutConfig('ORB_FUT_BN', 'BANKNIFTY', 100, 250, 1, 'server/slive/orb-fut-bn.js')
export const ORB_FUT_NIFTY = orbFutConfig('ORB_FUT_NIFTY', 'NIFTY', 50, 0, 1, 'server/slive/orb-fut-nifty.js')
export const ORB_FUT_SNX = orbFutConfig('ORB_FUT_SNX', 'SENSEX', 100, 0, 1, 'server/slive/orb-fut-snx.js')
