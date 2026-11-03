export * from './range-breakout-directional/logic.ts'
export * from './range-breakout-directional/config.ts'
export * from './range-breakout-directional/strategy.ts'
export * from './premium-leg-book/logic.ts'
export * from './premium-leg-book/config.ts'
export * from './premium-leg-book/strategy.ts'
export * from './momentum-flip-directional/logic.ts'
export * from './momentum-flip-directional/config.ts'
export * from './momentum-flip-directional/strategy.ts'
// `isCrossover` is deliberately NOT re-exported here: it is byte-identical to
// (and would collide with) premium-leg-book/logic.ts's export of the same
// name — both are direct ports of the same ATM-crossover check. Neither
// downstream task references it via the barrel, only through its own class.
export type { PendingTrigger } from './premium-distance-accumulator/logic.ts'
export { initialTriggers, nextTriggers, triggerCrossed } from './premium-distance-accumulator/logic.ts'
export * from './premium-distance-accumulator/config.ts'
export * from './premium-distance-accumulator/strategy.ts'
export * from './external-signal-mirror/config.ts'
export * from './external-signal-mirror/adapter.ts'
