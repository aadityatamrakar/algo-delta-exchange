/**
 * The traders app's settings, all from the environment. `TRADERS_MONGO_URL` has
 * no default so this process can never open the desk's database by accident.
 */

import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DEFAULT_SESSION_TTL_MS } from '@algomaker/auth'
import { DEFAULT_MARKET_WATCH_MAX_TOKENS } from './market/on-screen.ts'
import { DEFAULT_MAX_TOKENS } from './market/subscriptions.ts'

export interface TradersConfig {
  readonly port: number
  readonly mongoUrl: string
  readonly busUrl: string
  /** Exact browser origins (scheme + host + port) allowed to call the API with credentials. */
  readonly origins: readonly string[]
  readonly sessionTtlMs: number
  /** `TRADERS_MAX_TOKENS`: the most feed tokens the app declares (they join the desk's Kite feed pool). */
  readonly maxTokens: number
  /** `TRADERS_NSE_DIR`: where scripts/span_job.py saves NSE's SPAN, exposure and end-of-day files, one `<YYYY-MM-DD>/` folder a day. */
  readonly nseDir: string
  /**
   * `TRADERS_MARKET_WATCH_MAX_TOKENS`: the most tokens Market Watch's on-screen chains declare, across all viewers (P3), and
   * never more than TRADERS_MAX_TOKENS (they join the same declaration, and yield to the books). Absent = the default.
   */
  readonly marketWatchMaxTokens?: number
  /**
   * `TRADERS_PUSH_SUBJECT`: the contact the phone alerts' VAPID tokens name (an `https:` or `mailto:` URL); the push
   * services read it, nothing here ever fetches it. Absent = DEFAULT_PUSH_SUBJECT.
   */
  readonly pushSubject?: string
}

/** The traders page itself: a contact the push services can reach without anyone's mailbox. */
export const DEFAULT_PUSH_SUBJECT = 'https://delta.optionbhai.com/traders/'

/** An `https:` or `mailto:` URL, as RFC 8292 and every push service ask of the VAPID subject. */
export function isPushSubject(s: string): boolean {
  try {
    const u = new URL(s)
    return (u.protocol === 'https:' && u.hostname !== '' && u.hostname !== 'localhost') || (u.protocol === 'mailto:' && u.pathname.includes('@'))
  } catch {
    return false
  }
}

/** The repository root, from this file's own place: pm2's working directory does not matter. */
const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url))
const DEFAULT_NSE_DIR = resolve(REPO_ROOT, 'data/nse')

/**
 * Origins are matched exactly and credentials are on, so `*` and `null` (what a
 * sandboxed page sends) would let any page act as the signed-in trader. Plain
 * `http://<ip>` is fine: the operator serves the app over HTTP on port 80.
 */
export function assertOrigins(origins: readonly string[]): void {
  for (const o of origins) {
    if (o.includes('*') || o.toLowerCase() === 'null') {
      throw new Error(`TRADERS_ORIGINS must list exact origins; ${JSON.stringify(o)} is not allowed`)
    }
    let canonical: string | null = null
    try { canonical = new URL(o).origin } catch { /* not a URL */ }
    if (canonical !== o) {
      const hint = canonical === null || canonical === 'null' ? 'scheme://host[:port]' : canonical
      throw new Error(`TRADERS_ORIGINS entry "${o}" is not an origin — use ${hint}`)
    }
  }
}

export function configFromEnv(env: NodeJS.ProcessEnv = process.env): TradersConfig {
  const mongoUrl = (env['TRADERS_MONGO_URL'] ?? '').trim()
  if (mongoUrl === '') throw new Error('TRADERS_MONGO_URL is required')

  const portText = (env['TRADERS_PORT'] ?? '').trim()
  const port = portText === '' ? 8894 : Number(portText)
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`TRADERS_PORT is not a port number: ${portText}`)

  const origins = (env['TRADERS_ORIGINS'] ?? '').split(',').map((s) => s.trim()).filter((s) => s !== '')
  assertOrigins(origins)

  const ttl = Number(env['TRADERS_SESSION_TTL_MS'])
  const sessionTtlMs = Number.isFinite(ttl) && ttl > 0 ? ttl : DEFAULT_SESSION_TTL_MS

  const capText = (env['TRADERS_MAX_TOKENS'] ?? '').trim()
  const maxTokens = capText === '' ? DEFAULT_MAX_TOKENS : Number(capText)
  if (!Number.isSafeInteger(maxTokens) || maxTokens < 1) throw new Error(`TRADERS_MAX_TOKENS is not a positive whole number: ${capText}`)

  // unset, it is the default or TRADERS_MAX_TOKENS when that is less; set over TRADERS_MAX_TOKENS, it could never be met
  const watchText = (env['TRADERS_MARKET_WATCH_MAX_TOKENS'] ?? '').trim()
  const marketWatchMaxTokens = watchText === '' ? Math.min(DEFAULT_MARKET_WATCH_MAX_TOKENS, maxTokens) : Number(watchText)
  if (!Number.isSafeInteger(marketWatchMaxTokens) || marketWatchMaxTokens < 1) {
    throw new Error(`TRADERS_MARKET_WATCH_MAX_TOKENS is not a positive whole number: ${watchText}`)
  }
  if (marketWatchMaxTokens > maxTokens) {
    throw new Error(`TRADERS_MARKET_WATCH_MAX_TOKENS (${marketWatchMaxTokens}) is over TRADERS_MAX_TOKENS (${maxTokens}): Market Watch's tokens join the same declaration`)
  }

  // a relative folder is from the repository root, never from wherever the process was started
  const nseText = (env['TRADERS_NSE_DIR'] ?? '').trim()
  const nseDir = nseText === '' ? DEFAULT_NSE_DIR : resolve(REPO_ROOT, nseText)

  const subjectText = (env['TRADERS_PUSH_SUBJECT'] ?? '').trim()
  const pushSubject = subjectText === '' ? DEFAULT_PUSH_SUBJECT : subjectText
  if (!isPushSubject(pushSubject)) throw new Error(`TRADERS_PUSH_SUBJECT must be an https: or mailto: URL: ${subjectText}`)

  const busUrl = (env['DESK_BUS_URL'] ?? '').trim()
  return { port, mongoUrl, busUrl: busUrl === '' ? 'ws://127.0.0.1:8891' : busUrl, origins, sessionTtlMs, maxTokens, nseDir, marketWatchMaxTokens, pushSubject }
}
