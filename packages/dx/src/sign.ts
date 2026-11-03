/**
 * Delta request signing (delta-api-reference.md §2).
 *
 *   signature = hex(HMAC_SHA256(secret, METHOD + ts + path + query + body))
 *
 * `query` INCLUDES its leading `?` (or is ''), `body` is the exact string put
 * on the wire (compact JSON, or '' for none), `ts` is unix SECONDS. Sign what
 * you send: the caller builds the query and body once and passes those same
 * strings here and to fetch.
 */
import { createHmac } from 'node:crypto'

export function signRequest(
  secret: string,
  method: string,
  path: string,
  query: string,
  body: string,
  tsSec: number,
): string {
  const prehash = method.toUpperCase() + String(tsSec) + path + query + body
  return createHmac('sha256', secret).update(prehash).digest('hex')
}

/** The private socket's `key-auth` signature: `GET + ts + /live`. */
export function signWsAuth(secret: string, tsSec: number): string {
  return signRequest(secret, 'GET', '/live', '', '', tsSec)
}
