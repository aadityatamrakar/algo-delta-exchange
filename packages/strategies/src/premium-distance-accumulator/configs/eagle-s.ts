import type { PremiumDistanceAccumulatorConfig } from '../config.ts'

export const EAGLE_S_1: PremiumDistanceAccumulatorConfig = {
  tag: 'Eagle_S-1', class: 'premium-distance-accumulator', enabled: true,
  underlying: { symbol: 'BANKNIFTY', reference: 'current-future', strikeStep: 100 },
  strike: { offsetPoints: 0 }, expiry: { select: 'nearest' },
  session: { startAt: '09:15:00', squareOffAt: '15:24:00' },
  sizing: { kind: 'flat', lots: 1 },
  rail: { mode: 'sim', destinations: ['sim'], exitMechanism: 'local-tick' },
  risk: { maxLotsNet: null, dayLossRupees: null }, // D9: unbounded leg count is the verified legacy behaviour
  data: [{ kind: 'future', underlying: 'BANKNIFTY' }, { kind: 'option-chain', underlying: 'BANKNIFTY', strikeWindow: 8 }],
  legacy: { files: ['server/slive/eagle-s-1.js'], notes: 'D9 (owner, 2026-07-26): stays stopless, no resting-stop rollout' },
  premiumFloor: 20,
  stopPolicy: 'none', // D9, mandatory, matches eagle-s-1.js's verified BUY=0
  squareOffIstMinute: 15 * 60 + 24,
}
