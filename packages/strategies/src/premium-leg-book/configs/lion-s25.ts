import type { PremiumLegBookConfig } from '../config.ts'

export const LION_S25_2: PremiumLegBookConfig = {
  tag: 'Lion_S25_2', class: 'premium-leg-book', enabled: true,
  underlying: { symbol: 'BANKNIFTY', reference: 'current-future', strikeStep: 100 },
  strike: { offsetPoints: 0 }, expiry: { select: 'nearest' },
  session: { startAt: '09:15:00', squareOffAt: '15:20:00' },
  sizing: { kind: 'flat', lots: 1 }, // lion-s25-2.js always sends lots=1 per leg (no pyramid)
  // Target rail is LIVE (XTS) — but decision 3's resting-stop wiring is Phase B/D work,
  // out of scope here. This config is the destination-of-record, not yet runnable live.
  rail: { mode: 'live', destinations: ['xts'], exitMechanism: 'local-tick' },
  risk: { maxLotsNet: 1, dayLossRupees: null },
  data: [{ kind: 'future', underlying: 'BANKNIFTY' }, { kind: 'option-chain', underlying: 'BANKNIFTY', strikeWindow: 5 }],
  legacy: { files: ['server/slive/lion-s25-2.js'], notes: 'D3 resting-stop wiring deferred to Phase B/D — see design spec section 4.3' },
  legs: [{ type: 'CE', side: 'SELL' }, { type: 'PE', side: 'SELL' }],
  stop: { scope: 'per-leg', multiplier: 1.25 },
  reentry: 'per-leg',
  squareOffIstMinute: 15 * 60 + 20,
}
