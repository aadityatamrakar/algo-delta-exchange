import type { RangeBreakoutDirectionalConfig } from '../config.ts'

// Every literal below is copied from server/slive/orb-scalp.js:31-33 (the CONFIGS array —
// all 3 run in one legacy process; here they become 3 independent config records/instances).
function orbScalpConfig(
  tag: string, symbol: 'BANKNIFTY' | 'NIFTY' | 'SENSEX', strikeStep: number,
  rangeFilterPts: number, targetPts: number, timeStopMin: number,
): RangeBreakoutDirectionalConfig {
  return {
    tag, class: 'range-breakout-directional', enabled: true,
    underlying: { symbol, reference: 'index-spot', strikeStep },
    strike: { offsetPoints: 0 }, expiry: { select: 'nearest' },
    session: { startAt: '09:15:00', squareOffAt: '15:30:00' },
    sizing: { kind: 'flat', lots: 1 },
    rail: { mode: 'sim', destinations: ['sim'], exitMechanism: 'local-tick' },
    risk: { maxLotsNet: 1, dayLossRupees: null },
    data: [{ kind: 'index', underlying: symbol }, { kind: 'option-chain', underlying: symbol, strikeWindow: 3 }],
    legacy: { files: ['server/slive/orb-scalp.js', 'server/slive/orb-scalp-logic.js', 'server/slive/orb-fut-logic.js'] },
    band: { source: 'opening-range', candleCount: 6, bufferPct: 0.001, rangeFilterPts, formAtIstMinute: 9 * 60 + 45 },
    executionMapping: 'atm-option-of-side',
    exit: {
      stop: { basis: 'fixed-points', value: 0 }, target: { basis: 'fixed-points', value: targetPts },
      precedence: ['EOD', 'TARGET', 'SL'], stopMeasuredOn: 'signal', stopPolicy: 'local-tick',
    },
    entryCheckEveryMinutes: 5, entryDeadlineIstMinute: 14 * 60, squareOffIstMinute: 15 * 60 + 15,
    timeStopMinutes: timeStopMin,
    dayBudget: { kind: 'per-day' },
  }
}

export const ORB_SCALP_BN = orbScalpConfig('ORB_SCALP_BN', 'BANKNIFTY', 100, 250, 40, 90)
export const ORB_SCALP_NIFTY = orbScalpConfig('ORB_SCALP_NIFTY', 'NIFTY', 50, 0, 20, 60)
export const ORB_SCALP_SNX = orbScalpConfig('ORB_SCALP_SNX', 'SENSEX', 100, 0, 25, 90)
