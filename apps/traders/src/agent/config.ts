/**
 * The assistant's settings, from the environment (spec §6.1), kept apart from
 * `TradersConfig`: the app runs exactly as before when they are absent (R4).
 *
 * Off unless `TRADERS_AI_ENABLED=1` AND a key is set AND the model can be
 * priced; every other reason it is off is a sentence the status endpoint shows.
 * A bad value never stops the app booting — it turns the assistant off and says
 * why, naming the variable and never echoing its value (every trader sees the
 * reason, and main.ts logs it). The key is held in a `Secret`, which prints and
 * serialises as `[redacted]`, so no log line or JSON dump can carry it.
 */

import { inspect } from 'node:util'
import { priceFor, TURN_LIMITS, type AiPrice } from './budget.ts'

export const AI_PROVIDERS = ['anthropic', 'openai', 'google', 'openai-compatible'] as const
export type AiProvider = (typeof AI_PROVIDERS)[number]

export const AI_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const
export type AiEffort = (typeof AI_EFFORTS)[number]

export const DEFAULT_AI_MODEL = 'claude-opus-5-5'
export const DEFAULT_AI_EFFORT: AiEffort = 'medium'
export const DEFAULT_DAILY_USD = 25
export const DEFAULT_TRADER_DAILY_USD = 5

const REDACTED = '[redacted]'

/** A value that never prints. `reveal()` is the one way out, and only model.ts calls it. */
export class Secret {
  readonly #value: string
  constructor(value: string) { this.#value = value }
  reveal(): string { return this.#value }
  toJSON(): string { return REDACTED }
  toString(): string { return REDACTED }
  [inspect.custom](): string { return REDACTED }
}

export interface AiConfig {
  readonly enabled: boolean
  /** Why it is off, a sentence for the page; null when on. */
  readonly reason: string | null
  readonly provider: AiProvider
  readonly model: string
  readonly baseUrl: string | null
  readonly key: Secret | null
  readonly effort: AiEffort
  /** Model steps per turn, 1–10 (R10). */
  readonly maxSteps: number
  /** USD per IST day, the whole desk. */
  readonly dailyUsd: number
  /** USD per IST day, each trader. */
  readonly traderDailyUsd: number
  /** null = the model is not in the price table and no override is set (then the assistant is off). */
  readonly price: AiPrice | null
}

export const AI_OFF: AiConfig = Object.freeze({
  enabled: false, reason: 'the assistant is not configured (TRADERS_AI_ENABLED is not 1)',
  provider: 'anthropic', model: DEFAULT_AI_MODEL, baseUrl: null, key: null, effort: DEFAULT_AI_EFFORT,
  maxSteps: TURN_LIMITS.maxSteps, dailyUsd: DEFAULT_DAILY_USD, traderDailyUsd: DEFAULT_TRADER_DAILY_USD, price: null,
})

const text = (env: NodeJS.ProcessEnv, k: string): string => (env[k] ?? '').trim()

/** A positive number, or the default when unset; a bad value is a problem, not a throw. */
function positive(env: NodeJS.ProcessEnv, k: string, dflt: number | null, problems: string[]): number | null {
  const t = text(env, k)
  if (t === '') return dflt
  const n = Number(t)
  if (!Number.isFinite(n) || n <= 0) { problems.push(`${k} is not a positive number`); return dflt }
  return n
}

export function aiConfigFromEnv(env: NodeJS.ProcessEnv = process.env): AiConfig {
  const problems: string[] = []
  const providerText = text(env, 'TRADERS_AI_PROVIDER') || 'anthropic'
  const provider = (AI_PROVIDERS as readonly string[]).includes(providerText) ? providerText as AiProvider : null
  if (provider === null) problems.push(`TRADERS_AI_PROVIDER is not one of ${AI_PROVIDERS.join(', ')}`)
  const model = text(env, 'TRADERS_AI_MODEL') || DEFAULT_AI_MODEL
  const effortText = text(env, 'TRADERS_AI_EFFORT') || DEFAULT_AI_EFFORT
  const effort = (AI_EFFORTS as readonly string[]).includes(effortText) ? effortText as AiEffort : DEFAULT_AI_EFFORT
  if (effort !== effortText) problems.push(`TRADERS_AI_EFFORT is not one of ${AI_EFFORTS.join(', ')}`)
  const baseUrl = text(env, 'TRADERS_AI_BASE_URL') || null
  if (baseUrl !== null) {
    try { new URL(baseUrl) } catch { problems.push('TRADERS_AI_BASE_URL is not a URL') }
  }
  if (provider === 'openai-compatible' && baseUrl === null) problems.push('the openai-compatible provider needs TRADERS_AI_BASE_URL')
  const steps = positive(env, 'TRADERS_AI_MAX_STEPS', TURN_LIMITS.maxSteps, problems) as number
  const maxSteps = Math.max(1, Math.min(TURN_LIMITS.maxSteps, Math.floor(steps)))
  const dailyUsd = positive(env, 'TRADERS_AI_DAILY_USD', DEFAULT_DAILY_USD, problems) as number
  const traderDailyUsd = positive(env, 'TRADERS_AI_TRADER_DAILY_USD', DEFAULT_TRADER_DAILY_USD, problems) as number
  const pin = positive(env, 'TRADERS_AI_PRICE_IN_PER_MTOK', null, problems)
  const pout = positive(env, 'TRADERS_AI_PRICE_OUT_PER_MTOK', null, problems)
  if ((pin === null) !== (pout === null)) problems.push('set both TRADERS_AI_PRICE_IN_PER_MTOK and TRADERS_AI_PRICE_OUT_PER_MTOK, or neither')
  const price = priceFor(model, pin !== null && pout !== null ? { inPerMTok: pin, outPerMTok: pout } : null)
  const keyText = text(env, 'TRADERS_AI_API_KEY')
  const key = keyText === '' ? null : new Secret(keyText)

  const base = {
    provider: provider ?? 'anthropic', model, baseUrl, key, effort, maxSteps, dailyUsd, traderDailyUsd, price,
  }
  let reason: string | null = null
  if (text(env, 'TRADERS_AI_ENABLED') !== '1') reason = AI_OFF.reason
  else if (key === null) reason = 'the assistant is enabled but has no API key (TRADERS_AI_API_KEY)'
  else if (problems.length > 0) reason = `the assistant is off: ${problems.join('; ')}`
  else if (price === null) reason = 'no price for the model in TRADERS_AI_MODEL — set TRADERS_AI_PRICE_IN_PER_MTOK and TRADERS_AI_PRICE_OUT_PER_MTOK so the daily caps can be kept'
  return { ...base, enabled: reason === null, reason }
}
