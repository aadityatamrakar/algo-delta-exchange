/**
 * The shared strategy config schema — the five axes (underlying, strike, exit,
 * sizing, rail) plus session/expiry/risk, common to every class in
 * packages/strategies.
 *
 * D9 (owner, 2026-07-26): risk limits are OPT-IN, not mandatory.
 *   - `risk.maxLotsNet: null` means UNLIMITED and is a VALID, supported config
 *     (bull-s-1 / bull-snx-1 keep their legacy uncapped pyramid).
 *   - `stopPolicy: 'none'` means NO STOP and is a VALID, supported config
 *     (eagle-s-1 stays stopless, relying on the central EOD flatten).
 * assertValidConfig() must never reject either. It rejects a maxLotsNet that IS
 * provided but is not a positive number — that is still a config bug, just not
 * "null."
 */

import type { DataNeed } from '@algomaker/strategy-kit'

export type Underlying = 'NIFTY' | 'BANKNIFTY' | 'SENSEX'

export interface UnderlyingSpec {
  readonly symbol: Underlying
  /** Futures basis matters: lion-s25-2, bull-s-1, eagle-s-1, cheetah-b1-1/-snx
   *  all reference the current future, not spot. Never collapse the two. */
  readonly reference: 'index-spot' | 'current-future'
  readonly strikeStep: number
}

const STRIKE_STEP: Readonly<Record<Underlying, number>> = {
  NIFTY: 50,
  BANKNIFTY: 100,
  SENSEX: 100,
}

/** otmSelector returning 0 is intentional (D7). Default is ATM. */
export interface StrikeOffset {
  readonly offsetPoints: number
}

export type StopBasis =
  | { readonly basis: 'none' }
  | { readonly basis: 'fixed-pct'; readonly value: number }
  | { readonly basis: 'trailing-pct'; readonly value: number }
  | { readonly basis: 'fixed-points'; readonly value: number }

export type TargetBasis =
  | { readonly basis: 'none' }
  | { readonly basis: 'fixed-points'; readonly value: number }
  | { readonly basis: 'premium-target'; readonly value: number }

/**
 * Where the protective stop is enforced. D9: 'none' is first-class, not an
 * error case — eagle-s-1 has never had an intraday stop and stays that way.
 */
export type StopPolicy = 'resting' | 'local-tick' | 'none'

export interface ExitRules {
  readonly stop: StopBasis
  readonly target: TargetBasis
  readonly precedence: readonly ('EOD' | 'TARGET' | 'SL' | 'T1')[]
  readonly stopMeasuredOn: 'signal' | 'traded'
  readonly stopPolicy: StopPolicy
}

export type Sizing =
  | { readonly kind: 'flat'; readonly lots: number }
  | { readonly kind: 'pyramid-up'; readonly start: number; readonly step: number; readonly cap: number | null }
  | { readonly kind: 'pyramid-down'; readonly start: number; readonly step: number; readonly floor: number }
  | { readonly kind: 'martingale-capped'; readonly start: number; readonly cap: number }

export type ExecMode = 'sim' | 'live'

export interface Rail {
  readonly mode: ExecMode
  /** Zerodha is never a destination (D1) — it is data-only. */
  readonly destinations: readonly ('sim' | 'xts')[]
  readonly exitMechanism: 'local-tick' | 'broker-resting-stop'
}

export interface Session {
  readonly startAt: string // 'HH:mm:ss' IST
  readonly squareOffAt: string // MANDATORY — no legacy active file owns this in code
}

export interface ExpiryPolicy {
  readonly select: 'nearest' | 'next'
}

/**
 * D9: maxLotsNet: null means UNLIMITED. A non-null value must be a positive
 * integer-ish number; a bare 0 or a negative is a config bug and IS rejected.
 */
export interface Risk {
  readonly maxLotsNet: number | null
  readonly dayLossRupees: number | null
}

export type StrategyClassId = 'premium-leg-book'

export interface BaseConfig {
  /** Unique. Sizing key, P&L grouping key, square-off key. */
  readonly tag: string
  readonly class: StrategyClassId
  readonly enabled: boolean
  readonly underlying: UnderlyingSpec
  readonly strike: StrikeOffset
  readonly expiry: ExpiryPolicy
  readonly session: Session
  readonly sizing: Sizing
  readonly rail: Rail
  readonly risk: Risk
  readonly data: readonly DataNeed[]
  /** Provenance, so the migration is auditable. */
  readonly legacy: { readonly files: readonly string[]; readonly notes?: string }
}

/**
 * Config-load-time assertions. Throws with a message naming the offending
 * field on the first violation found.
 *
 * `existingTags`, when passed, catches the four-files-share-one-tag class of
 * bug the taxonomy found in the legacy estate (`STGL-25`). `exit`, when
 * passed, runs the exit-specific D9 checks — not every BaseConfig caller has
 * an ExitRules yet at the point this is called (class-level configs extend
 * BaseConfig with their own exit shape), so it is optional here and the
 * per-class config modules in packages/strategies call it explicitly.
 */
export function assertValidConfig(
  cfg: BaseConfig,
  existingTags?: ReadonlySet<string>,
  exit?: ExitRules,
): void {
  if (cfg.tag.length === 0) {
    throw new Error('BaseConfig.tag must be non-empty')
  }
  if (existingTags?.has(cfg.tag) === true) {
    throw new Error(`BaseConfig.tag '${cfg.tag}' is not unique — a config with this tag already exists`)
  }

  const expectedStep = STRIKE_STEP[cfg.underlying.symbol]
  if (cfg.underlying.strikeStep !== expectedStep) {
    throw new Error(
      `underlying.strikeStep for ${cfg.underlying.symbol} must be ${expectedStep}, got ${cfg.underlying.strikeStep}`,
    )
  }

  if (cfg.session.squareOffAt.length === 0) {
    throw new Error('session.squareOffAt is mandatory — no config may omit it')
  }
  if (cfg.session.startAt.length === 0) {
    throw new Error('session.startAt is mandatory')
  }

  // D9: maxLotsNet may be null (unlimited, explicit — bull-s-1/bull-snx-1).
  // It must NEVER be rejected for being null. A provided-but-nonsensical
  // value (<=0) IS rejected.
  if (cfg.risk.maxLotsNet !== null && cfg.risk.maxLotsNet <= 0) {
    throw new Error(`risk.maxLotsNet, when provided, must be a positive number; got ${cfg.risk.maxLotsNet}`)
  }

  if (exit !== undefined) {
    // D9: stopPolicy 'none' is valid and must never be rejected here. There is
    // nothing further to assert for it — the whole point is that no stop
    // exists. Non-'none' policies just need a non-'none' stop basis to back
    // them, so the pairing is not internally contradictory.
    if (exit.stopPolicy !== 'none' && exit.stop.basis === 'none') {
      throw new Error(
        `exit.stopPolicy is '${exit.stopPolicy}' but exit.stop.basis is 'none' — ` +
          `either set stopPolicy to 'none' explicitly (a reviewed decision) or give the stop a basis`,
      )
    }
  }
}
