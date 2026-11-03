/**
 * Phone alerts' plumbing (spec 2026-10-23-traders-gaps G7): the server's VAPID keys, each user's push subscriptions
 * (`traders-push`), and the Pusher that turns one alert into one encrypted POST per subscribed phone.
 *
 * The server POSTs to whatever endpoint a browser hands it, so an endpoint is accepted only on the push services
 * browsers use (`pushEndpointProblem`), over https, with no credentials and no port: the subscribe route checks it and
 * the Pusher checks it again before every send. A 404 or 410 from the push service means the phone unsubscribed, so
 * the row goes; any other failure is logged once per phone and kind, by host and a short hash, never the endpoint's
 * path (it is the phone's address).
 *
 * Revoked access stops the alerts: disabling a trader or resetting a password forgets the user's phones
 * (routes/admin.ts), and the Pusher reads each recipient on every send and skips one that is disabled or gone.
 */

import { createHash } from 'node:crypto'
// the parser web-push 3.6.7 sends with (web-push-lib.js): the guard checks an endpoint as it will be read
import { parse as legacyParse } from 'node:url'
import type { TraderStore } from '../auth/users.ts'
import type { TradersDb } from '../db.ts'
import { BadRequest, isObject, type Log } from '../routes/kit.ts'

export interface VapidKeys { readonly publicKey: string; readonly privateKey: string }
export interface Vapid extends VapidKeys { readonly subject: string }

/** Where one phone's browser receives pushes: the endpoint and its encryption keys (base64url). */
export interface PushTarget { readonly endpoint: string; readonly keys: { readonly p256dh: string; readonly auth: string } }

/** Sends one encrypted payload; resolves with the push service's status, rejects with an error carrying `statusCode` on a refusal. */
export type PushSender = (target: PushTarget, payload: string, vapid: Vapid) => Promise<number>

/** What a phone shows. `url` is under `/traders/`; `tag` folds a later alert of the same kind and book into the earlier one. */
export interface PushMessage { readonly title: string; readonly body: string; readonly url: string; readonly tag: string }

// ---- the endpoint guard ----------------------------------------------------------------

/** The push services browsers hand out endpoints on: Chrome and Android (FCM), Firefox, Safari and iPhone, Edge. */
const PUSH_HOSTS: readonly string[] = ['fcm.googleapis.com', 'updates.push.services.mozilla.com']
const PUSH_HOST_SUFFIXES: readonly string[] = ['.push.apple.com', '.notify.windows.com']
export const ENDPOINT_MAX = 1024

/** A plain DNS name: lower-case letters, digits, dots and hyphens (no IP literal brackets, no IDN, no escapes). */
const HOST_CHARS = /^[a-z0-9.-]+$/

/**
 * Why the server must not POST to `endpoint`, or null when it may.
 *
 * Two parsers read an endpoint: the WHATWG URL here, and web-push's legacy `url.parse`, which it sends with. They
 * disagree on hosts the WHATWG parser accepts and the legacy one cuts short (`https://evil.example;x.push.apple.com`
 * is Apple's to one and evil.example to the other), so the host must be a plain DNS name, and the legacy parse of
 * both the endpoint and its stored `href` must read the same https host, with no credentials and no port but 443.
 */
export function pushEndpointProblem(endpoint: unknown): string | null {
  if (typeof endpoint !== 'string' || endpoint === '') return 'endpoint must be a URL'
  if (endpoint.length > ENDPOINT_MAX) return `endpoint must be at most ${ENDPOINT_MAX} characters`
  // printable ASCII only (an IDN, a space, a control character are none of a push service's), and never @ or \
  if (/[^\x21-\x7e]|[@\\]/.test(endpoint)) return 'endpoint is not a push service URL'
  let u: URL
  try { u = new URL(endpoint) } catch { return 'endpoint is not a URL' }
  if (u.protocol !== 'https:') return 'endpoint must be https'
  if (u.username !== '' || u.password !== '') return 'endpoint must not carry credentials'
  if (u.port !== '') return 'endpoint must not name a port'
  const host = u.hostname
  const labels = host.split('.')
  if (!HOST_CHARS.test(host) || labels.some((l) => l === '' || l.startsWith('-') || l.endsWith('-') || l.startsWith('xn--'))) {
    return 'endpoint host is not a plain DNS name'
  }
  for (const s of [endpoint, u.href]) {
    const legacy = legacyParse(s)
    const port = legacy.port ?? ''
    if (legacy.protocol !== 'https:' || legacy.auth !== null || legacy.hostname !== host || (port !== '' && port !== '443')) {
      return 'endpoint is not read the same by the push library'
    }
  }
  const known = PUSH_HOSTS.includes(host) || PUSH_HOST_SUFFIXES.some((s) => host.endsWith(s) && host.length > s.length)
  return known ? null : 'endpoint is not on a known push service'
}

const B64URL = /^[A-Za-z0-9_-]+={0,2}$/
const bytesOf = (s: string): number => Buffer.from(s, 'base64url').length

/** A browser's `PushSubscription.toJSON()`: the endpoint (guarded) and its keys (a P-256 point, a 16-byte secret). */
export function parseSubscription(body: unknown): PushTarget {
  if (!isObject(body)) throw new BadRequest('body must be a push subscription')
  const problem = pushEndpointProblem(body['endpoint'])
  if (problem !== null) throw new BadRequest(problem)
  const keys = body['keys']
  if (!isObject(keys)) throw new BadRequest('keys must be { p256dh, auth }')
  const { p256dh, auth } = keys
  if (typeof p256dh !== 'string' || !B64URL.test(p256dh) || bytesOf(p256dh) !== 65 || Buffer.from(p256dh, 'base64url')[0] !== 4) {
    throw new BadRequest('keys.p256dh must be an uncompressed P-256 public key, base64url')
  }
  if (typeof auth !== 'string' || !B64URL.test(auth) || bytesOf(auth) !== 16) throw new BadRequest('keys.auth must be 16 bytes, base64url')
  return { endpoint: new URL(body['endpoint'] as string).href, keys: { p256dh, auth } }
}

/** A short, stable name for a phone in a log line: never the endpoint, whose path is the phone's address. */
export const phoneId = (endpoint: string): string => createHash('sha256').update(endpoint).digest('hex').slice(0, 8)

const hostOf = (endpoint: string): string => {
  try { return new URL(endpoint).hostname } catch { return '?' }
}

const isDuplicateKey = (err: unknown): boolean => (err as { code?: unknown } | null)?.code === 11000

const NO_ID = { projection: { _id: 0 } } as const

// ---- the VAPID keys ----------------------------------------------------------------------

interface VapidDoc { readonly kind: 'vapid'; readonly trader: null; readonly publicKey?: unknown; readonly privateKey?: unknown; readonly createdAt?: number }
const VAPID_KEY = { kind: 'vapid', trader: null } as const

function keysOf(d: VapidDoc | null): VapidKeys | null {
  if (d === null) return null
  const { publicKey, privateKey } = d
  if (typeof publicKey !== 'string' || !B64URL.test(publicKey) || bytesOf(publicKey) !== 65) return null
  if (typeof privateKey !== 'string' || !B64URL.test(privateKey) || bytesOf(privateKey) !== 32) return null
  return { publicKey, privateKey }
}

/**
 * `traders-settings` `{ kind: 'vapid', trader: null }`: the server's one key pair, made on first use, so there is no
 * operator secret. Two first uses at once (two requests, or two processes) both try to insert; R1's unique
 * `{ kind, trader }` index lets one win and both read the winner's keys. Read once per process.
 */
export class VapidStore {
  readonly #db: TradersDb
  readonly #now: () => number
  readonly #generate: () => VapidKeys
  #keys: Promise<VapidKeys> | null = null

  constructor(db: TradersDb, now: () => number, generate: () => VapidKeys) {
    this.#db = db
    this.#now = now
    this.#generate = generate
  }

  keys(): Promise<VapidKeys> {
    // a failed read is not remembered: the next use tries again
    this.#keys ??= this.#load().catch((err: unknown) => { this.#keys = null; throw err })
    return this.#keys
  }

  async #load(): Promise<VapidKeys> {
    const col = this.#db.collection<VapidDoc>('traders-settings')
    const stored = keysOf(await col.findOne(VAPID_KEY, NO_ID))
    if (stored !== null) return stored
    const fresh = this.#generate()
    try {
      await col.updateOne(VAPID_KEY, { $setOnInsert: { ...VAPID_KEY, ...fresh, createdAt: this.#now() } }, { upsert: true })
    } catch (err) {
      if (!isDuplicateKey(err)) throw err   // another first use inserted at the same moment: its keys are read below
    }
    const won = keysOf(await col.findOne(VAPID_KEY, NO_ID))
    if (won === null) throw new Error('the stored VAPID keys do not parse (traders-settings, kind vapid)')
    return won
  }
}

// ---- the subscriptions -----------------------------------------------------------------

export interface PushSubscriptionDoc {
  readonly username: string
  readonly endpoint: string
  readonly keys: { readonly p256dh: string; readonly auth: string }
  readonly createdAt: number
  /** The last subscribe from this browser: the cap keeps the newest. */
  readonly seenAt: number
  /** The last send the push service took; null = none yet. */
  readonly lastOkAt: number | null
}

/** Phones (browsers) per user: a sixth subscribe drops the one least recently subscribed. */
export const SUBSCRIPTIONS_PER_USER = 5

/** `traders-push`: one row per browser endpoint (unique), owned by the user who subscribed it last. */
export class PushStore {
  readonly #db: TradersDb
  readonly #now: () => number

  constructor(db: TradersDb, now: () => number) {
    this.#db = db
    this.#now = now
  }

  async ensureIndexes(): Promise<void> {
    await this.#col().createIndex({ endpoint: 1 }, { unique: true })
    await this.#col().createIndex({ username: 1, seenAt: -1 })
  }

  /**
   * Subscribes this browser for `username`. An endpoint is one browser, so a second user subscribing it takes it over.
   * Returns how many phones the user now has (at most SUBSCRIPTIONS_PER_USER).
   */
  async add(username: string, t: PushTarget): Promise<number> {
    const now = this.#now()
    const set = { username, keys: { p256dh: t.keys.p256dh, auth: t.keys.auth }, seenAt: now }
    try {
      await this.#col().updateOne({ endpoint: t.endpoint }, { $set: set, $setOnInsert: { endpoint: t.endpoint, createdAt: now, lastOkAt: null } }, { upsert: true })
    } catch (err) {
      if (!isDuplicateKey(err)) throw err
      await this.#col().updateOne({ endpoint: t.endpoint }, { $set: set })   // two first subscribes of one endpoint raced: this one updates
    }
    const mine = await this.#col().find({ username }, NO_ID).sort({ seenAt: -1 }).toArray()
    for (const old of mine.slice(SUBSCRIPTIONS_PER_USER)) await this.#col().deleteOne({ endpoint: old.endpoint, username })
    return Math.min(mine.length, SUBSCRIPTIONS_PER_USER)
  }

  /** Only the user's own row: an endpoint someone else holds is left alone. */
  async remove(username: string, endpoint: string): Promise<boolean> {
    const r = (await this.#col().deleteOne({ username, endpoint })) as { deletedCount?: number } | null
    return (r?.deletedCount ?? 0) > 0
  }

  async of(usernames: readonly string[]): Promise<PushSubscriptionDoc[]> {
    if (usernames.length === 0) return []
    return await this.#col().find({ username: { $in: [...usernames] } }, NO_ID).toArray()
  }

  async count(username: string): Promise<number> {
    return await this.#col().countDocuments({ username })
  }

  async ok(endpoint: string, at: number): Promise<void> {
    await this.#col().updateOne({ endpoint }, { $set: { lastOkAt: at } })
  }

  async drop(endpoint: string): Promise<void> {
    await this.#col().deleteOne({ endpoint })
  }

  /** Every phone of `username` (its access was revoked: disabled, or its password reset); how many went. */
  async forget(username: string): Promise<number> {
    const r = (await this.#col().deleteMany({ username })) as { deletedCount?: number } | null
    return r?.deletedCount ?? 0
  }

  #col() {
    return this.#db.collection<PushSubscriptionDoc>('traders-push')
  }
}

// ---- sending -----------------------------------------------------------------------------

export interface PusherDeps {
  readonly subs: Pick<PushStore, 'of' | 'ok' | 'drop'>
  /** Read on each send: a user disabled (or gone) since subscribing gets nothing, whatever phones are still on file. */
  readonly users: Pick<TraderStore, 'find'>
  readonly vapid: Pick<VapidStore, 'keys'>
  /** The VAPID subject (config `pushSubject`): named in each token, never fetched. */
  readonly subject: string
  readonly send: PushSender
  readonly now: () => number
  readonly log: Log
}

/** A notification body longer than this is cut: a phone shows a few lines, and a push payload is at most 4 KB. */
const BODY_MAX = 600

const statusOf = (err: unknown): number | null => {
  const s = (err as { statusCode?: unknown } | null)?.statusCode
  return typeof s === 'number' ? s : null
}
const codeOf = (err: unknown): string => {
  const c = (err as { code?: unknown } | null)?.code
  return typeof c === 'string' ? c : err instanceof Error ? err.name : 'error'
}

export class Pusher {
  readonly #d: PusherDeps
  /** `<phone>|<status or code>` already logged: a phone that keeps failing the same way is one log line. */
  readonly #logged = new Set<string>()

  constructor(d: PusherDeps) {
    this.#d = d
  }

  /**
   * Sends `m` to every phone of `usernames` that is still an enabled user; resolves with how many took it. Never throws
   * for a phone's failure.
   */
  async send(usernames: readonly string[], m: PushMessage): Promise<number> {
    const enabled: string[] = []
    for (const name of new Set(usernames)) {
      const u = await this.#d.users.find(name)   // one indexed read a recipient: a send is rare
      if (u !== null && !u.disabled) enabled.push(u.username)
    }
    const subs = await this.#d.subs.of(enabled)
    if (subs.length === 0) return 0
    const vapid: Vapid = { ...(await this.#d.vapid.keys()), subject: this.#d.subject }
    const body = m.body.length > BODY_MAX ? `${m.body.slice(0, BODY_MAX - 1)}…` : m.body
    const payload = JSON.stringify({ title: m.title, body, url: m.url, tag: m.tag })
    const reached = await Promise.all(subs.map((s) => this.#one(s, payload, vapid)))
    return reached.filter(Boolean).length
  }

  async #one(s: PushSubscriptionDoc, payload: string, vapid: Vapid): Promise<boolean> {
    const { log } = this.#d
    if (pushEndpointProblem(s.endpoint) !== null) {
      // a row from before the guard, or written by hand: never POSTed to
      await this.#d.subs.drop(s.endpoint).catch(() => undefined)
      log('phone alert: a stored endpoint is not a push service, dropped', { phone: phoneId(s.endpoint) })
      return false
    }
    try {
      await this.#d.send(s, payload, vapid)
      await this.#d.subs.ok(s.endpoint, this.#d.now()).catch(() => undefined)
      return true
    } catch (err) {
      const status = statusOf(err)
      if (status === 404 || status === 410) {
        await this.#d.subs.drop(s.endpoint).catch(() => undefined)
        log('phone alert: the phone unsubscribed, its row is dropped', { host: hostOf(s.endpoint), phone: phoneId(s.endpoint), status })
        return false
      }
      const what = status === null ? codeOf(err) : String(status)
      const key = `${phoneId(s.endpoint)}|${what}`
      if (!this.#logged.has(key)) {
        this.#logged.add(key)
        log('phone alert not delivered', { host: hostOf(s.endpoint), phone: phoneId(s.endpoint), ...(status === null ? { error: what } : { status }) })
      }
      return false
    }
  }
}
