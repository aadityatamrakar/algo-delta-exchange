/**
 * What every route module shares: the request context, the error classes the
 * server maps to statuses, the body caps, and IST date helpers.
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Principal } from '../types.ts'
import type { Endpoint } from './endpoints.ts'

export type Log = (msg: string, ctx?: Record<string, unknown>) => void

export interface TradersGate {
  authenticate(req: IncomingMessage): Promise<Principal | null>
}

export interface RouteCtx {
  readonly req: IncomingMessage
  readonly res: ServerResponse
  readonly url: URL
  readonly path: string
  readonly method: string
  readonly endpoint: Endpoint
  readonly params: Readonly<Record<string, string>>
  /** null only on a public endpoint. */
  readonly principal: Principal | null
  readonly log: Log
  /** At most JSON_BODY_MAX; an empty body is `{}`; bad JSON is a BadRequest. */
  readJson(): Promise<unknown>
  /** Raw endpoints only; at most RAW_BODY_MAX. */
  readRaw(): Promise<Buffer>
  send(status: number, body: unknown): void
}

/** Returns true when it handled the request. */
export type Route = (ctx: RouteCtx) => Promise<boolean>

export class BadRequest extends Error {}
export class NotFound extends Error {}
export class Forbidden extends Error {}
export class Conflict extends Error {}
export class PayloadTooLarge extends Error {}

export const JSON_BODY_MAX = 64 * 1024
export const RAW_BODY_MAX = 20 * 1024 * 1024
export const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000

/** IST calendar day, `YYYY-MM-DD`. */
export function istDate(ms: number): string {
  return new Date(ms + IST_OFFSET_MS).toISOString().slice(0, 10)
}

/** IST wall clock, `HH:MM`. */
export function istClock(ms: number): string {
  return new Date(ms + IST_OFFSET_MS).toISOString().slice(11, 16)
}

export function isIsoDate(v: unknown): v is string {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false
  const d = new Date(`${v}T00:00:00.000Z`)
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v
}

export function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}
