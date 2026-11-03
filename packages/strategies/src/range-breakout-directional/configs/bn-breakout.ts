import type { RangeBreakoutDirectionalConfig } from '../config.ts'

// Every literal below is copied from server/slive/bn-breakout.js:29-35.
export const BN_BREAKOUT: RangeBreakoutDirectionalConfig = {
  tag: 'BN_BREAKOUT', class: 'range-breakout-directional', enabled: true,
  underlying: { symbol: 'BANKNIFTY', reference: 'index-spot', strikeStep: 100 },
  strike: { offsetPoints: 0 }, expiry: { select: 'nearest' },
  session: { startAt: '09:15:00', squareOffAt: '15:30:00' },
  sizing: { kind: 'flat', lots: 1 },
  rail: { mode: 'sim', destinations: ['sim'], exitMechanism: 'local-tick' },
  risk: { maxLotsNet: 1, dayLossRupees: null },
  data: [{ kind: 'index', underlying: 'BANKNIFTY' }, { kind: 'option-chain', underlying: 'BANKNIFTY', strikeWindow: 3 }],
  legacy: { files: ['server/slive/bn-breakout.js', 'server/slive/bn-breakout-logic.js'] },
  band: { source: 'first-candle-pct', pct: 0.0009, formAtIstMinute: 9 * 60 + 21 },
  executionMapping: 'atm-option-of-side',
  exit: {
    stop: { basis: 'fixed-points', value: 0 }, target: { basis: 'fixed-points', value: 45 },
    precedence: ['EOD', 'TARGET', 'SL'], stopMeasuredOn: 'signal', stopPolicy: 'local-tick',
  },
  entryCheckEveryMinutes: 5, entryDeadlineIstMinute: 13 * 60 + 30, squareOffIstMinute: 15 * 60 + 15,
  timeStopMinutes: 90,
  dayBudget: { kind: 'per-side', stopDayOnNonLoss: true }, // a non-loss (incl. breakeven) ends the day
}
