/**
 * The `web-push` library (RFC 8291 encryption, RFC 8292 VAPID), reached through a NARROW port as the desk reaches the
 * Mongo driver (apps/api/src/store.ts): the package ships no types, and the two calls used here are all it is trusted
 * with. Loaded on first use, so a process that never sends never loads it.
 *
 * The one place a push leaves this server. Tests never reach it: the app takes a `PushSender` and the harness hands in
 * a fake.
 */

import { createRequire } from 'node:module'
import type { PushSender, VapidKeys } from './push.ts'

interface WebPushPort {
  generateVAPIDKeys(): { publicKey: string; privateKey: string }
  sendNotification(
    subscription: { endpoint: string; keys: { p256dh: string; auth: string } },
    payload: string,
    options: {
      vapidDetails: { subject: string; publicKey: string; privateKey: string }
      TTL: number; urgency: 'high'; timeout: number
    },
  ): Promise<{ statusCode: number }>
}

let port: WebPushPort | null = null
function lib(): WebPushPort {
  port ??= createRequire(import.meta.url)('web-push') as WebPushPort
  return port
}

/** How long a push service holds an alert for a phone that is off: an hour, past which the market has moved on. */
export const PUSH_TTL_S = 3600
/** A push service that has not answered in this long is given up on for this alert. */
export const PUSH_TIMEOUT_MS = 10_000

export function generateVapidKeys(): VapidKeys {
  const k = lib().generateVAPIDKeys()
  return { publicKey: k.publicKey, privateKey: k.privateKey }
}

/**
 * The real sender. A refusal rejects with web-push's own error, which carries `statusCode` (and the endpoint, which
 * the caller never logs).
 */
export const webPushSender: PushSender = async (target, payload, vapid) => {
  const r = await lib().sendNotification(
    { endpoint: target.endpoint, keys: { p256dh: target.keys.p256dh, auth: target.keys.auth } },
    payload,
    {
      vapidDetails: { subject: vapid.subject, publicKey: vapid.publicKey, privateKey: vapid.privateKey },
      TTL: PUSH_TTL_S, urgency: 'high', timeout: PUSH_TIMEOUT_MS,
    },
  )
  return r.statusCode
}
