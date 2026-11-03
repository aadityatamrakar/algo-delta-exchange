/**
 * Cookie and bearer handling for the traders app.
 *
 * The browser authenticates by an httpOnly cookie the page can not read; the
 * watcher by an `Authorization: Bearer` token. Neither is ever taken from a
 * query string.
 */

import type { IncomingMessage } from 'node:http'

/** `dx_`-prefixed in the Delta clone: cookies are not port-scoped, so the live NSE traders app's `traders_session` would collide with it. */
export const SESSION_COOKIE = 'dx_traders_session'

/**
 * One cookie's value, or '' when absent or AMBIGUOUS.
 *
 * Two cookies of the same name is a refusal, not a pick: a sibling-domain
 * cookie scoped to another path is a different cookie from ours, so login would
 * not overwrite it, and taking the first match would hand its owner a session
 * that survives the trader logging in. An undecodable value is no credential.
 */
export function cookieOf(req: IncomingMessage, name: string): string {
  const header = req.headers.cookie
  if (typeof header !== 'string') return ''
  let found: string | null = null
  for (const part of header.split(';')) {
    const eq = part.indexOf('=')
    if (eq < 0) continue
    if (part.slice(0, eq).trim() !== name) continue
    if (found !== null) return ''
    try {
      found = decodeURIComponent(part.slice(eq + 1).trim())
    } catch {
      return ''
    }
  }
  return found ?? ''
}

/** The bearer credential, or '' when the request presents none. */
export function bearerOf(req: IncomingMessage): string {
  const header = req.headers.authorization ?? ''
  const prefix = 'Bearer '
  return header.startsWith(prefix) ? header.slice(prefix.length).trim() : ''
}

/**
 * `Secure` only when the request reached us over TLS. The app is served over
 * plain HTTP by operator decision; a Secure cookie would be dropped by the
 * browser and every login would look like it succeeded and did nothing.
 */
export function sessionCookie(token: string, maxAgeMs: number, secure: boolean): string {
  const parts = [
    `${SESSION_COOKIE}=${encodeURIComponent(token)}`,
    'HttpOnly',
    'SameSite=Strict',
    'Path=/',
    `Max-Age=${Math.max(0, Math.floor(maxAgeMs / 1000))}`,
  ]
  if (secure) parts.push('Secure')
  return parts.join('; ')
}

/** Expiring a cookie must repeat every attribute, or the browser keeps the original. */
export function clearedSessionCookie(secure: boolean): string {
  const parts = [`${SESSION_COOKIE}=`, 'HttpOnly', 'SameSite=Strict', 'Path=/', 'Max-Age=0']
  if (secure) parts.push('Secure')
  return parts.join('; ')
}

/** Whether the request came over TLS, honouring a terminating proxy. */
export function isSecureRequest(req: IncomingMessage): boolean {
  const proto = req.headers['x-forwarded-proto']
  if (typeof proto === 'string' && proto.split(',')[0]?.trim() === 'https') return true
  return (req.socket as { encrypted?: boolean }).encrypted === true
}
