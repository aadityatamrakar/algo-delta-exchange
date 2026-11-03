import type { PremiumLegBookConfig } from '../config.ts'

export const BULL_S_1: PremiumLegBookConfig = {
  tag: 'Bull_S-1', class: 'premium-leg-book', enabled: true,
  underlying: { symbol: 'BANKNIFTY', reference: 'current-future', strikeStep: 100 },
  strike: { offsetPoints: 0 }, expiry: { select: 'nearest' },
  session: { startAt: '09:15:00', squareOffAt: '15:20:00' },
  sizing: { kind: 'pyramid-up', start: 1, step: 1, cap: null }, // D9: uncapped, matches bull-s-1.js:145 verbatim
  rail: { mode: 'sim', destinations: ['sim'], exitMechanism: 'local-tick' },
  risk: { maxLotsNet: null, dayLossRupees: null }, // D9: null is the signed-off, correct value
  data: [{ kind: 'future', underlying: 'BANKNIFTY' }, { kind: 'option-chain', underlying: 'BANKNIFTY', strikeWindow: 4 }],
  legacy: { files: ['server/slive/bull-s-1.js'] },
  legs: [{ type: 'CE', side: 'SELL' }, { type: 'PE', side: 'SELL' }],
  stop: { scope: 'combined', multiplier: 1.25 },
  reentry: 'paired',
  squareOffIstMinute: 15 * 60 + 20,
}

// bull-snx-1 differs from bull-s-1 ONLY in underlying (SENSEX vs BANKNIFTY, both step 100)
// and reference future token — confirmed by `diff server/slive/bull-s-1.js server/slive/bull-snx-1.js`,
// a 4-line diff limited to strategyTag, the require path spelling, and optionConfig('SENSEX')/futureToken=265.
export const BULL_SNX_1: PremiumLegBookConfig = {
  ...BULL_S_1,
  tag: 'Bull_SNX-1',
  underlying: { symbol: 'SENSEX', reference: 'current-future', strikeStep: 100 },
  data: [{ kind: 'future', underlying: 'SENSEX' }, { kind: 'option-chain', underlying: 'SENSEX', strikeWindow: 4 }],
  legacy: { files: ['server/slive/bull-snx-1.js'] },
}
