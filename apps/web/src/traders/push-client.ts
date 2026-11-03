/**
 * Phone alerts in the browser (spec 2026-10-23-traders-gaps G7): the service worker at /traders/sw.js, the
 * notification permission, and this browser's push subscription, kept in step with the server's copy.
 *
 * The state a user sees: `unsupported` (no service worker or Push API: an iPhone's Safari until the page is added to
 * the Home Screen), `blocked` (notifications denied for the site), `off`, `on`. Everything the browser offers comes
 * through a `PushEnv`, so a test hands in its own.
 */

import { tapi } from './api.ts'

export type PhoneAlertState = 'unsupported' | 'blocked' | 'off' | 'on'

/** Where Caddy serves the page and its service worker (vite's `base`); the worker's scope is the page's folder. */
export const SW_SCOPE = '/traders/'
export const SW_URL = `${SW_SCOPE}sw.js`

/** The parts of a PushSubscription used here. */
export interface SubscriptionLike {
  readonly endpoint: string
  readonly options?: { readonly applicationServerKey?: ArrayBuffer | null }
  toJSON(): unknown
  unsubscribe(): Promise<boolean>
}

export interface RegistrationLike {
  readonly pushManager: {
    getSubscription(): Promise<SubscriptionLike | null>
    subscribe(o: { userVisibleOnly: true; applicationServerKey: Uint8Array<ArrayBuffer> }): Promise<SubscriptionLike>
  }
}

export interface PushEnv {
  /** null = no service workers here (an insecure page, an old browser). */
  readonly serviceWorker: {
    register(url: string, o: { scope: string }): Promise<unknown>
    getRegistration(scope: string): Promise<RegistrationLike | undefined>
    /** The active registration of this page's scope. */
    readonly ready: Promise<RegistrationLike>
  } | null
  /** The Push API is here (`PushManager`). */
  readonly pushManager: boolean
  /** null = no Notification API. */
  readonly notification: {
    readonly permission: NotificationPermission
    requestPermission(): Promise<NotificationPermission>
  } | null
  /** An iPhone or iPad: push only from the page added to the Home Screen. */
  readonly iPhone: boolean
  /** Opened from the Home Screen (display-mode standalone). */
  readonly standalone: boolean
}

/** The real browser's. */
export function browserEnv(): PushEnv {
  const nav = typeof navigator === 'undefined' ? null : navigator
  const sw = nav !== null && 'serviceWorker' in nav ? nav.serviceWorker : null
  const N = typeof Notification === 'undefined' ? null : Notification
  const ua = nav?.userAgent ?? ''
  let standalone = false
  try {
    standalone = (typeof window.matchMedia === 'function' && window.matchMedia('(display-mode: standalone)').matches)
      || (nav as { standalone?: boolean } | null)?.standalone === true
  } catch { /* not standalone */ }
  return {
    serviceWorker: sw === null ? null : {
      register: (url, o) => sw.register(url, o),
      getRegistration: (scope) => sw.getRegistration(scope) as Promise<RegistrationLike | undefined>,
      get ready() { return sw.ready as unknown as Promise<RegistrationLike> },
    },
    pushManager: typeof window !== 'undefined' && 'PushManager' in window,
    notification: N === null ? null : { get permission() { return N.permission }, requestPermission: () => N.requestPermission() },
    iPhone: /iPhone|iPad|iPod/.test(ua) || (nav?.platform === 'MacIntel' && (nav?.maxTouchPoints ?? 0) > 1),
    standalone,
  }
}

/** A VAPID public key (base64url) as the bytes `pushManager.subscribe` takes. */
export function keyBytes(base64url: string): Uint8Array<ArrayBuffer> {
  const b64 = base64url.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (base64url.length % 4)) % 4)
  const raw = atob(b64)
  const out = new Uint8Array(new ArrayBuffer(raw.length))
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i)
  return out
}

function sameKey(a: ArrayBuffer | null | undefined, b: Uint8Array): boolean {
  if (a === null || a === undefined) return true   // a browser that does not say: trust the subscription
  const x = new Uint8Array(a)
  return x.length === b.length && x.every((v, i) => v === b[i])
}

const supported = (env: PushEnv): boolean => env.serviceWorker !== null && env.pushManager && env.notification !== null

/** The state now, and the worker's registration when alerts are on. */
export async function readPhoneAlerts(env: PushEnv): Promise<{ state: PhoneAlertState; reg: RegistrationLike | null }> {
  if (!supported(env)) return { state: 'unsupported', reg: null }
  if (env.notification?.permission === 'denied') return { state: 'blocked', reg: null }
  const reg = await env.serviceWorker?.getRegistration(SW_SCOPE)
  const sub = reg === undefined ? null : await reg.pushManager.getSubscription()
  return sub !== null && reg !== undefined && env.notification?.permission === 'granted' ? { state: 'on', reg } : { state: 'off', reg: null }
}

/**
 * Turns phone alerts on: the permission (asked first, while the tap still counts as the user's), the service worker,
 * a subscription to the server's key (a subscription to an older key is replaced), and the server's copy of it.
 */
export async function turnOnPhoneAlerts(env: PushEnv): Promise<PhoneAlertState> {
  if (!supported(env) || env.serviceWorker === null || env.notification === null) return 'unsupported'
  const permission = await env.notification.requestPermission()
  if (permission === 'denied') return 'blocked'
  if (permission !== 'granted') return 'off'
  await env.serviceWorker.register(SW_URL, { scope: SW_SCOPE })
  await syncSubscription(await env.serviceWorker.ready)
  return 'on'
}

/**
 * This browser's subscription to the server's current key, and the server's copy of it: run on turning on, and on
 * each load while on (the server may have dropped its copy, or have new keys after its settings were reset).
 */
export async function syncSubscription(reg: RegistrationLike): Promise<void> {
  const key = keyBytes((await tapi.pushKey()).publicKey)
  let sub = await reg.pushManager.getSubscription()
  if (sub !== null && !sameKey(sub.options?.applicationServerKey, key)) {
    await sub.unsubscribe()
    sub = null
  }
  sub ??= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key })
  await tapi.pushSubscribe(sub.toJSON())
}

/** Turns them off on this browser: the subscription goes, and the server forgets it. */
export async function turnOffPhoneAlerts(env: PushEnv): Promise<PhoneAlertState> {
  const reg = await env.serviceWorker?.getRegistration(SW_SCOPE)
  const sub = reg === undefined ? null : await reg.pushManager.getSubscription()
  if (sub !== null) {
    const endpoint = sub.endpoint
    await sub.unsubscribe()
    await tapi.pushUnsubscribe(endpoint).catch(() => undefined)   // the browser's is gone; the server drops its copy on the next 410
  }
  return 'off'
}
