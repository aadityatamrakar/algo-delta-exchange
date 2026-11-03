/**
 * Validation of a trader's hand-entered leg (spec item 4a). A manual leg is
 * for what ODIN history cannot show: older holdings, a position at another
 * broker. Every refusal is a BadRequest carrying a sentence the page shows.
 */

import { BadRequest, isIsoDate, isObject } from '../routes/kit.ts'
import type { Instrument, ManualLegInput, OptType } from '../types.ts'

export const STOCK_RE = /^[A-Z0-9&-]{1,20}$/
const QTY_MAX = 10_000_000
const NOTE_MAX = 200
const INSTRUMENTS: readonly string[] = ['option', 'future', 'share']

function absent(v: unknown): boolean {
  return v === undefined || v === null || v === ''
}

function qtyOf(v: unknown): number {
  if (typeof v !== 'number' || !Number.isInteger(v) || v === 0 || Math.abs(v) > QTY_MAX) {
    throw new BadRequest(`qty must be a non-zero whole number of shares, at most ${QTY_MAX.toLocaleString('en-US')} either way`)
  }
  return v
}

function priceOf(v: unknown): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new BadRequest('avgPrice must be a number')
  return v
}

function noteOf(v: unknown): string {
  if (typeof v !== 'string' || v.length > NOTE_MAX) throw new BadRequest(`note must be text of at most ${NOTE_MAX} characters`)
  return v
}

export function parseManualLeg(stock: string, body: unknown): ManualLegInput {
  if (!STOCK_RE.test(stock)) throw new BadRequest('the stock must be 1 to 20 letters, digits, & or -')
  if (!isObject(body)) throw new BadRequest('body must be a JSON object')
  const { instrument, expiry, strike, optType } = body
  if (typeof instrument !== 'string' || !INSTRUMENTS.includes(instrument)) {
    throw new BadRequest('instrument must be option, future or share')
  }
  let ex = ''
  let st: number | null = null
  let ot: OptType | null = null
  if (instrument === 'share') {
    if (!absent(expiry) || !absent(strike) || !absent(optType)) throw new BadRequest('a share takes no expiry, strike or option type')
  } else {
    if (!isIsoDate(expiry)) throw new BadRequest('expiry must be a date, YYYY-MM-DD')
    ex = expiry
    if (instrument === 'future') {
      if (!absent(strike) || !absent(optType)) throw new BadRequest('a future takes no strike or option type')
    } else {
      if (typeof strike !== 'number' || !Number.isFinite(strike) || strike <= 0) throw new BadRequest('strike must be a number above 0')
      if (optType !== 'CE' && optType !== 'PE') throw new BadRequest('optType must be CE or PE')
      st = strike
      ot = optType
    }
  }
  return {
    stock, instrument: instrument as Instrument, expiry: ex, strike: st, optType: ot,
    qty: qtyOf(body['qty']), avgPrice: priceOf(body['avgPrice']),
    note: body['note'] === undefined ? '' : noteOf(body['note']),
  }
}

export function parseManualPatch(body: unknown): { qty?: number; avgPrice?: number; note?: string } {
  if (!isObject(body)) throw new BadRequest('body must be a JSON object')
  const out: { qty?: number; avgPrice?: number; note?: string } = {}
  for (const k of Object.keys(body)) {
    if (k === 'qty') out.qty = qtyOf(body[k])
    else if (k === 'avgPrice') out.avgPrice = priceOf(body[k])
    else if (k === 'note') out.note = noteOf(body[k])
    else throw new BadRequest('only qty, avgPrice and note can be changed')
  }
  if (Object.keys(out).length === 0) throw new BadRequest('nothing to change: send qty, avgPrice or note')
  return out
}
