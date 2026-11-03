/**
 * THE FIRST BULL-S PAPER BOOKS ON DELTA BTC OPTIONS — SIX OF THEM, NONE LIVE.
 *
 *     node scripts/dx-books.mjs                 # dry run: the six bodies, no network
 *     node scripts/dx-books.mjs --apply         # create, start, paper-enable
 *     node scripts/dx-books.mjs --now 2026-11-04T05:00:00Z   # plan for another instant
 *     node scripts/dx-books.mjs --expiry daily=2026-11-04,weekly=2026-11-06,monthly=2026-11-27
 *
 * One book per preset on the nearest daily, weekly and monthly expiry, in the
 * 1-strike and 2-strike flavours. Tag `BTC-<expiry>-bull-s-<cls>[-2]`.
 *
 * Expiries are computed from the calendar (settlement 12:00 UTC = 17:30 IST;
 * weekly = the Friday, monthly = the last Friday of the month) and CHECKED
 * against the live chain at --apply: an expiry with no listed strikes aborts.
 * Override with --expiry when Delta lists something else.
 *
 * --apply talks to the dx api at 127.0.0.1:${DESK_PORT ?? 8890} with
 * DESK_API_TOKEN from .env.local, and refuses when the feed is not ready or the
 * kill switch is on. Same three calls as stock-books.mjs: POST registry,
 * POST registry/:tag/start {mode:'paper'}, PATCH strategies/:tag paper on.
 * Mode is the literal 'paper' everywhere; there is no flag for anything else.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolve as resolvePath, dirname } from 'node:path'
import { PAPER, PAPER_ON, STRATEGIES, requestJson } from './delta-lean-books.mjs'

const REGISTRY = '/v1/desk/books/registry'
const SYMBOL = 'BTC'
const DAY_MS = 86_400_000
const SETTLE_UTC_H = 12
const TIMEOUT_MS = 15_000

// TODO(T3): import these from packages/desk-engine presets once lane/bulls lands.
/** Spec §6.2 / plan Task 3. Daily, weekly, monthly; the -2 twin only changes bs_strike_jump. */
const COMMON = Object.freeze({
  bs_enabled: true,
  bs_stop_mult: 1.25,
  bs_stop_basis: 1,
  bs_stop_confirm_s: 3,
  bs_target: 0,
  bs_after_halt: 0,
  bs_enter_on_start: true,
  bs_no_entry_before_expiry_min: 60,
})
const CLASSES = Object.freeze([
  { cls: 'daily', bs_strike_step: 200, bs_lots_start: 50, bs_lots_step: 50, bs_lots_cap: 150, bs_max_open: 4, bs_loss_cap: 250 },
  { cls: 'weekly', bs_strike_step: 500, bs_lots_start: 10, bs_lots_step: 10, bs_lots_cap: 30, bs_max_open: 4, bs_loss_cap: 500 },
  { cls: 'monthly', bs_strike_step: 1000, bs_lots_start: 10, bs_lots_step: 10, bs_lots_cap: 30, bs_max_open: 4, bs_loss_cap: 500 },
])

const isoDate = (ms) => new Date(ms).toISOString().slice(0, 10)
const utcMs = (iso) => Date.parse(`${iso}T00:00:00Z`)

/** The settlement date a moment is heading for: today until 12:00 UTC, then tomorrow. */
export function nearestDaily(nowMs) {
  const d = new Date(nowMs)
  const today = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())
  return isoDate(nowMs < today + SETTLE_UTC_H * 3_600_000 ? today : today + DAY_MS)
}

/** First Friday on or after `fromIso`. */
export function nextFriday(fromIso) {
  let ms = utcMs(fromIso)
  while (new Date(ms).getUTCDay() !== 5) ms += DAY_MS
  return isoDate(ms)
}

/** Last Friday of the month of `iso`. */
export function lastFridayOfMonth(iso) {
  const d = new Date(utcMs(iso))
  let ms = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)
  while (new Date(ms).getUTCDay() !== 5) ms -= DAY_MS
  return isoDate(ms)
}

/** Nearest daily/weekly/monthly expiry; the monthly rolls to next month once this month's is past. */
export function expiriesFor(nowMs) {
  const daily = nearestDaily(nowMs)
  const weekly = nextFriday(daily)
  let monthly = lastFridayOfMonth(daily)
  if (monthly < daily) {
    const d = new Date(utcMs(daily))
    monthly = lastFridayOfMonth(isoDate(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1)))
  }
  return { daily, weekly, monthly }
}

/** The six BookCreate bodies, exactly as sent. Pure. */
export function planBooks(expiries) {
  const books = []
  for (const c of CLASSES) {
    const { cls, ...own } = c
    for (const jump of [1, 2]) {
      const suffix = jump === 2 ? '-2' : ''
      const expiry = expiries[cls]
      books.push({
        tag: `${SYMBOL}-${expiry}-bull-s-${cls}${suffix}`,
        symbol: SYMBOL,
        expiry,
        mode: PAPER,
        variant: `bull-s-btc-${cls}${suffix}`,
        dials: { ...COMMON, ...own, bs_strike_jump: jump },
      })
    }
  }
  return books
}

function readEnv(file) {
  const out = {}
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const t = line.trim()
    const eq = t.indexOf('=')
    if (t === '' || t.startsWith('#') || eq < 0) continue
    out[t.slice(0, eq).trim()] = t.slice(eq + 1).trim().replace(/^(["'])(.*)\1$/, '$2')
  }
  return out
}

function parseExpiryArg(arg, base) {
  const out = { ...base }
  for (const part of arg.split(',')) {
    const [k, v] = part.split('=')
    if (!(k in out) || !/^\d{4}-\d{2}-\d{2}$/.test(v ?? '')) throw new Error(`bad --expiry '${part}' (daily|weekly|monthly=YYYY-MM-DD)`)
    out[k] = v
  }
  return out
}

async function apply(books, env) {
  const token = env.DESK_API_TOKEN
  if (!token) throw new Error('DESK_API_TOKEN missing from .env.local')
  if (env.DESK_VENUE !== 'dx') throw new Error('REFUSED: .env.local does not say DESK_VENUE=dx')
  const base = `http://127.0.0.1:${env.DESK_PORT ?? process.env.DESK_PORT ?? 8890}`
  const call = (m, p, b) => requestJson(base, m, p, b, token, { timeoutMs: TIMEOUT_MS })

  const feed = await call('GET', '/v1/desk/feed')
  if (feed.status !== 200 || feed.body?.ready !== true) throw new Error(`REFUSED: the feed is not ready (HTTP ${feed.status} ${feed.text.slice(0, 200)})`)
  const ks = await call('GET', '/v1/desk/killswitch')
  if (ks.status !== 200) throw new Error(`reading the kill switch failed: HTTP ${ks.status}`)
  if (ks.body?.enabled !== false) throw new Error('REFUSED: the kill switch is on')

  for (const expiry of new Set(books.map((b) => b.expiry))) {
    const ch = await call('GET', `/v1/desk/chain/${SYMBOL}?expiry=${expiry}`)
    const strikes = ch.body?.strikes
    if (ch.status !== 200 || !Array.isArray(strikes) || strikes.length === 0) {
      throw new Error(`REFUSED: no listed strikes for ${SYMBOL} ${expiry} (HTTP ${ch.status}); pass --expiry to name the real expiry`)
    }
  }

  for (const b of books) {
    if (b.mode !== PAPER) throw new Error(`REFUSED at the wire: ${b.tag} is mode ${JSON.stringify(b.mode)}`)
    const c = await call('POST', REGISTRY, b)
    if (c.status !== 200 && c.status !== 201) throw new Error(`create ${b.tag} failed: HTTP ${c.status} ${c.text}`)
    if (c.body && c.body.mode !== PAPER) throw new Error(`REFUSED: registry echoed mode ${JSON.stringify(c.body.mode)} for ${b.tag}`)
    const s = await call('POST', `${REGISTRY}/${b.tag}/start`, { mode: PAPER })
    if (s.status !== 200) throw new Error(`start ${b.tag} failed: HTTP ${s.status} ${s.text}`)
    const p = await call('PATCH', `${STRATEGIES}/${b.tag}`, PAPER_ON)
    if (p.status !== 200) throw new Error(`paper-enable ${b.tag} failed: HTTP ${p.status} ${p.text}`)
    console.log(`  ok  ${b.tag}`)
  }
  console.log(`\n  ${books.length} books registered, started and paper-enabled.`)
}

async function main() {
  const args = process.argv.slice(2)
  const val = (f) => (args.includes(f) ? args[args.indexOf(f) + 1] : undefined)
  const nowArg = val('--now')
  const nowMs = nowArg ? Date.parse(nowArg) : Date.now()
  if (!Number.isFinite(nowMs)) throw new Error(`bad --now '${nowArg}'`)
  let expiries = expiriesFor(nowMs)
  if (val('--expiry')) expiries = parseExpiryArg(val('--expiry'), expiries)
  const books = planBooks(expiries)
  const doApply = args.includes('--apply')

  console.log(`${doApply ? 'APPLY' : 'DRY RUN'}: ${books.length} PAPER books  daily ${expiries.daily}  weekly ${expiries.weekly}  monthly ${expiries.monthly}`)
  for (const b of books) console.log(`\n  ${b.tag}\n${JSON.stringify(b, null, 2).replace(/^/gm, '    ')}`)
  if (!doApply) {
    console.log('\n  No network was used. Add --apply to create, start and paper-enable them.')
    return
  }
  const here = dirname(fileURLToPath(import.meta.url))
  console.log('')
  await apply(books, readEnv(resolvePath(here, '..', '.env.local')))
}

if (process.argv[1] !== undefined && resolvePath(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err))
    process.exit(1)
  })
}
