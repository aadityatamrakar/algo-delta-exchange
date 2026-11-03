import type { RangeBreakoutDirectionalConfig } from '../config.ts'

// Every literal below is copied from server/slive/atr-band-nifty.js:28-37.
export const ATR_BAND_NIFTY: RangeBreakoutDirectionalConfig = {
  tag: 'ATR_BAND_NIFTY', class: 'range-breakout-directional', enabled: true,
  underlying: { symbol: 'NIFTY', reference: 'index-spot', strikeStep: 50 },
  strike: { offsetPoints: 0 }, expiry: { select: 'nearest' },
  session: { startAt: '09:15:00', squareOffAt: '15:30:00' },
  sizing: { kind: 'flat', lots: 1 },
  rail: { mode: 'sim', destinations: ['sim'], exitMechanism: 'local-tick' },
  risk: { maxLotsNet: 1, dayLossRupees: null },
  data: [{ kind: 'index', underlying: 'NIFTY' }, { kind: 'option-chain', underlying: 'NIFTY', strikeWindow: 3 }],
  legacy: { files: ['server/slive/atr-band-nifty.js', 'server/slive/atr-band-logic.js'] },
  // TWO phases, from atr-band-nifty.js's own cron block (lines 314-315):
  //   `20 15 10 * * 1-5` computeWidth  -> 10:15, Wilder ATR-14 / 3 of 60-MINUTE spot bars
  //   `20 40 11 * * 1-5` computeLines  -> 11:40, lines at the 11:35-11:40 5-MINUTE close +/- width
  band: {
    source: 'atr-anchor', atrPeriod: 14, divisor: 3,
    formAtIstMinute: 10 * 60 + 15, widthInterval: '60minute',
    anchorAtIstMinute: 11 * 60 + 40, anchorInterval: '5minute',
  },
  executionMapping: 'atm-option-of-side',
  exit: {
    stop: { basis: 'fixed-points', value: 0 }, target: { basis: 'fixed-points', value: 20 },
    precedence: ['EOD', 'TARGET', 'SL'], stopMeasuredOn: 'traded', stopPolicy: 'local-tick',
  },
  entryCheckEveryMinutes: 5, entryDeadlineIstMinute: 14 * 60 + 15, squareOffIstMinute: 15 * 60 + 15,
  timeStopMinutes: 60,
  dayBudget: { kind: 'per-side', stopDayOnNonLoss: false },
}
