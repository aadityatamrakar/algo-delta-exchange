/**
 * Where desk-runner reaches optionbhai — read once, from the environment.
 *
 * WHY THIS EXISTS. optionbhai.com sits behind Cloudflare, and between 8 and 10
 * September Cloudflare answered every login with HTTP 403. The origin answers
 * directly, so the operator chose to connect to it by IP with the vhost named
 * in a `Host` header. Three variables, all optional:
 *
 *  - `OPTIONBHAI_BASE_URL`   — `http(s)://…`, default `https://optionbhai.com`
 *  - `OPTIONBHAI_SOCKET_URL` — `ws(s)://…`,   default `wss://optionbhai.com`
 *  - `OPTIONBHAI_HOST_HEADER` — a bare `host[:port]`; when set, every request
 *    and the socket handshake carry `Host: <value>`, so a connection to a bare
 *    IP still reaches the right virtual host.
 *
 * With none set the client behaves exactly as it did when the two URLs were
 * constants. A malformed value THROWS, naming the variable: falling back to the
 * default would put the mirrors straight back behind the block the operator
 * configured around, with nothing to say why.
 *
 * CLEARTEXT. `http://` / `ws://` carry the login password and the session
 * token unencrypted across the internet. That is the operator's choice for the
 * origin-IP route; `isCleartext` exists so the boot log says so out loud.
 */

import { readFileSync } from 'node:fs'
import type { Logger } from '@algomaker/strategy-kit'

export const DEFAULT_BASE_URL = 'https://optionbhai.com'
export const DEFAULT_SOCKET_URL = 'wss://optionbhai.com'

export interface OptionbhaiOptions {
  readonly baseUrl: string
  readonly socketUrl: string
  /** Sent as `Host` on every request and on the socket handshake. Absent = the URL's own host. */
  readonly hostHeader?: string
  readonly userAgent: string
}

export class InvalidOptionbhaiEnv extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'InvalidOptionbhaiEnv'
  }
}

let cachedUserAgent: string | null = null

/** `algomaker-desk-runner/<apps/runner/package.json version>`. */
export function runnerUserAgent(): string {
  if (cachedUserAgent === null) {
    let version = '0.0.0'
    try {
      const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
        version?: unknown
      }
      if (typeof pkg.version === 'string' && pkg.version !== '') version = pkg.version
    } catch {
      // A missing package.json must not stop the mirrors; the header is
      // informational. '0.0.0' is visibly not a real version.
    }
    cachedUserAgent = `algomaker-desk-runner/${version}`
  }
  return cachedUserAgent
}

export function optionbhaiOptionsFromEnv(env: NodeJS.ProcessEnv): OptionbhaiOptions {
  const baseUrl = url(env, 'OPTIONBHAI_BASE_URL', DEFAULT_BASE_URL, ['http:', 'https:'])
  const socketUrl = url(env, 'OPTIONBHAI_SOCKET_URL', DEFAULT_SOCKET_URL, ['ws:', 'wss:'])
  const host = value(env, 'OPTIONBHAI_HOST_HEADER')
  if (host !== null && !/^[A-Za-z0-9.-]+(:\d{1,5})?$/.test(host)) {
    throw new InvalidOptionbhaiEnv(
      `OPTIONBHAI_HOST_HEADER must be a bare host or host:port (e.g. optionbhai.com), got ${JSON.stringify(host)}`,
    )
  }
  return {
    baseUrl,
    socketUrl,
    ...(host === null ? {} : { hostHeader: host }),
    userAgent: runnerUserAgent(),
  }
}

/** True when either leg would carry the credentials or the token unencrypted. */
export function isCleartext(o: OptionbhaiOptions): boolean {
  return o.baseUrl.startsWith('http:') || o.socketUrl.startsWith('ws:')
}

export type ResolvedOptionbhaiOptions =
  | { readonly ok: true; readonly options: OptionbhaiOptions }
  | { readonly ok: false; readonly error: string }

/**
 * The boot step `main.ts` runs once: read the variables and say where the
 * mirrors will connect.
 *
 * A malformed variable does NOT throw out of here. desk-runner hosts every
 * strategy as well as the mirrors, and a typo in a mirror URL must not take
 * the strategies down with it; the caller parks each mirror as `failed` with
 * this error instead, where the portal shows it. The endpoints logged are the
 * bases only — the socket URL with the token is never built here.
 */
export function resolveOptionbhaiOptions(
  env: NodeJS.ProcessEnv,
  log: Logger,
): ResolvedOptionbhaiOptions {
  let options: OptionbhaiOptions
  try {
    options = optionbhaiOptionsFromEnv(env)
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err)
    log.error(`mirrors: optionbhai endpoint misconfigured — no mirror will start: ${error}`)
    return { ok: false, error }
  }
  const where = { baseUrl: options.baseUrl, socketUrl: options.socketUrl, hostHeader: options.hostHeader ?? null }
  if (isCleartext(options)) {
    log.warn(
      'mirrors: optionbhai endpoint is unencrypted (http/ws) — the login password and the session token ' +
        'cross the internet in clear',
      where,
    )
  } else {
    log.info('mirrors: optionbhai endpoint', where)
  }
  return { ok: true, options }
}

function value(env: NodeJS.ProcessEnv, name: string): string | null {
  const raw = env[name]
  if (raw === undefined) return null
  const trimmed = raw.trim()
  return trimmed === '' ? null : trimmed
}

function url(env: NodeJS.ProcessEnv, name: string, fallback: string, schemes: readonly string[]): string {
  const raw = value(env, name)
  if (raw === null) return fallback
  // Every refusal is logged at boot, so it never repeats a userinfo part.
  const shown = JSON.stringify(raw.replace(/\/\/[^/]*@/, '//[userinfo]@'))
  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    throw new InvalidOptionbhaiEnv(`${name} is not a URL: ${shown}`)
  }
  if (!schemes.includes(parsed.protocol)) {
    throw new InvalidOptionbhaiEnv(
      `${name} must start with ${schemes.map((s) => `${s}//`).join(' or ')}, got ${shown}`,
    )
  }
  // Userinfo would be printed in the boot log line; a query or fragment would
  // be mangled by the paths the client appends. Neither has a legitimate use.
  if (parsed.username !== '' || parsed.password !== '') {
    throw new InvalidOptionbhaiEnv(`${name} must not carry a user or password (got ${shown})`)
  }
  if (parsed.search !== '' || parsed.hash !== '' || /[?#]/.test(raw)) {
    throw new InvalidOptionbhaiEnv(`${name} must not carry a query or fragment, got ${shown}`)
  }
  // The client appends `/auth/login`, `/api/instruments`, `/ws`.
  return raw.replace(/\/+$/, '')
}
