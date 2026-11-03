import type { MomentumFlipDirectionalConfig } from '../config.ts'

export const CHEETAH_B1_1: MomentumFlipDirectionalConfig = {
  tag: 'CheetahB1-1', class: 'momentum-flip-directional', enabled: true,
  underlying: { symbol: 'BANKNIFTY', reference: 'current-future', strikeStep: 100 },
  strike: { offsetPoints: 0 }, expiry: { select: 'nearest' },
  session: { startAt: '09:17:00', squareOffAt: '15:20:00' },
  sizing: { kind: 'martingale-capped', start: 1, cap: 12 }, // cheetah-b1-1.js:145
  rail: { mode: 'live', destinations: ['xts'], exitMechanism: 'local-tick' },
  risk: { maxLotsNet: 12, dayLossRupees: null }, // MUST equal sizing.cap — enforced at config load
  data: [{ kind: 'future', underlying: 'BANKNIFTY' }, { kind: 'option-chain', underlying: 'BANKNIFTY', strikeWindow: 2 }],
  legacy: { files: ['server/slive/cheetah-b1-1.js'], notes: 'D3 resting-stop wiring deferred to Phase B/D' },
  trailSlPoints: 10, targetPoints: 90,
  flip: { onStop: true, onTarget: false, strikeRef: 'frozen-first-atm' },
  bootstrapDelayMs: 10_000, squareOffIstMinute: 15 * 60 + 20,
}

// cheetah-b1-snx differs ONLY in underlying and bootstrap delay (confirmed by file diff).
export const CHEETAH_B1_SNX: MomentumFlipDirectionalConfig = {
  ...CHEETAH_B1_1,
  tag: 'Cheetah_B1_SNX',
  underlying: { symbol: 'SENSEX', reference: 'current-future', strikeStep: 100 },
  data: [{ kind: 'future', underlying: 'SENSEX' }, { kind: 'option-chain', underlying: 'SENSEX', strikeWindow: 2 }],
  legacy: { files: ['server/slive/cheetah-b1-snx.js'], notes: 'D3 resting-stop wiring deferred to Phase B/D' },
  bootstrapDelayMs: 3_000,
}
