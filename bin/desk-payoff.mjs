#!/usr/bin/env node
/**
 * THE PAYOFF COCKPIT AT A TERMINAL — one book's whole shape in one screen.
 *
 *   node bin/desk-payoff.mjs <TAG> [--mode live|paper] [--repair] [--json]
 *
 *   env: DESK_API_URL    where the bridge is (default http://127.0.0.1:8890)
 *        DESK_API_TOKEN  the machine bearer — see AUTH below
 *
 * A PRINTER AND NOTHING ELSE. It issues two GETs and formats what comes back.
 * There is no POST in this file, no order path, no `--flatten`, and nothing
 * that could grow one without an obvious diff: the repair menu is a menu, and
 * the operator takes a row to the order box themselves. That is the same safety
 * story `apps/api/src/routes/payoff.ts` tells about the endpoints, and it holds
 * on this side of the wire for the same structural reason.
 *
 * ── AUTH ────────────────────────────────────────────────────────────────────
 *
 * `Authorization: Bearer $DESK_API_TOKEN`, which is the MACHINE principal — the
 * same credential the Python desk presents and the same one `/v1/md/history`
 * wants. Traced through the API: `server.ts` calls `gate.authenticate`, and both
 * gates accept this header. `authsvc.ts`'s session gate tries the session store
 * first and falls back to `bearerMatches(req, DESK_API_TOKEN)` — the fallback its
 * own header calls load-bearing, because the Python desk holds a token and has
 * no way to log in — while `authgate.ts`'s `bearerGate` (the pre-login default)
 * accepts nothing else. The dashboard's `dx_desk_session` cookie is the OTHER
 * credential, and `credentialOf` reads it FIRST; a CLI has no cookie jar, so the
 * bearer is not merely accepted here, it is the only path available.
 *
 * A machine principal cannot `reauth`, deliberately. Nothing this CLI calls
 * needs to.
 *
 * ── PLAIN NODE, NO BUILD, NO DEPENDENCIES ───────────────────────────────────
 *
 * `.mjs` beside the other `bin/` launchers, so it runs from a checkout with
 * nothing installed and nothing compiled — which is the state a box is in when
 * somebody is trying to read a book at 09:20 because the dashboard will not
 * load. It imports NOTHING from `apps/` or `packages/`, including the web's
 * formatters: importing a `.ts` module would make this file depend on the
 * runtime's type-stripping, and importing the dashboard's `api.ts` would drag a
 * React module graph into a terminal. The two formatters it needs are twenty
 * lines and are reimplemented below, matching `inr`'s output for the cases a
 * CLI prints.
 *
 * ── node:http RATHER THAN fetch, and it is not a style preference ───────────
 *
 * `fetch`'s global dispatcher pools its sockets, and a pooled keep-alive socket
 * holds the event loop open for the agent's timeout AFTER the answer has been
 * printed — several seconds of a CLI that looks hung, and a `server.close()` on
 * the other end that blocks for exactly as long. `agent: false` below means one
 * socket, closed on response end, and a process that exits when it is done.
 */

import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'

const DEFAULT_URL = 'http://127.0.0.1:8890'
/** One read of one book. Generous, because a cold chain solve is not instant. */
const TIMEOUT_MS = 20_000
/** IST, as `routes/kit.ts` does it: shift the instant, then read it as UTC. */
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000
/** The menu shows three plans a goal. The engine may return more. */
const PLANS_SHOWN = 3

const USAGE = `usage: desk-payoff <TAG> [--mode live|paper] [--repair] [--json]

  <TAG>            the book, exactly as the Books page spells it
  --mode           live or paper. Default paper, which is the safe one to guess
  --repair         the four repair goals and their ranked plans, instead of the payoff
  --json           the bridge's answer verbatim, unformatted

  DESK_API_URL     default ${DEFAULT_URL}
  DESK_API_TOKEN   the machine bearer this desk's processes share`

// ------------------------------------------------------------------ formatting

/**
 * Indian digit grouping — `250000` → `2,50,000`.
 *
 * Written out rather than handed to `toLocaleString('en-IN')`, which is what
 * `apps/web/src/api.ts`'s `inr` does. A browser always has full ICU; a node on
 * a server may not, and `packages/payoff/src/machine.ts` already made this call
 * for the same reason — grouping that depends on the box's ICU build is
 * grouping that differs between the dashboard and the terminal reading the same
 * number.
 */
function group(digits) {
  const head = digits.length > 3 ? digits.slice(0, -3) : ''
  const tail = digits.length > 3 ? digits.slice(-3) : digits
  return head === '' ? tail : `${head.replace(/\B(?=(\d{2})+(?!\d))/g, ',')},${tail}`
}

/**
 * A grouped number at `dp` decimals. NOT A NUMBER RENDERS AS `—`, it does not
 * throw — the same rule `inr` states: this is read during an incident, and a
 * stack trace where a dash belongs costs the operator the other nine figures.
 */
function plain(n, dp = 2) {
  if (typeof n !== 'number' || !Number.isFinite(n)) return '—'
  const fixed = Math.abs(n).toFixed(dp)
  const dot = fixed.indexOf('.')
  const digits = dot < 0 ? fixed : fixed.slice(0, dot)
  const frac = dot < 0 ? '' : fixed.slice(dot)
  // `-0.001` at 2dp is `0.00`; printing it as `-0.00` reads as a real loss.
  const negative = n < 0 && Number(fixed) !== 0
  return `${negative ? '-' : ''}${group(digits)}${frac}`
}

/** Rupees. The sign goes OUTSIDE the symbol: `-₹1,23,456.50`. */
function money(n, dp = 2) {
  if (typeof n !== 'number' || !Number.isFinite(n)) return '—'
  const body = plain(Math.abs(n), dp)
  return `${n < 0 && Number(Math.abs(n).toFixed(dp)) !== 0 ? '-' : ''}₹${body}`
}

/** Rupees with the direction always stated — for deltas, where it is the point. */
function signedMoney(n, dp = 2) {
  if (typeof n !== 'number' || !Number.isFinite(n)) return '—'
  const rounded = Number(n.toFixed(dp))
  return `${rounded > 0 ? '+' : ''}${money(n, dp)}`
}

/** A 0–1 fraction as a percentage. `0.724` → `72.40%`. */
function pct(n, dp = 2) {
  if (typeof n !== 'number' || !Number.isFinite(n)) return '—'
  return `${(n * 100).toFixed(dp)}%`
}

/**
 * A number that is ALREADY a percentage. `goals.ts` stores `profitableWidthPct`
 * on 0–100 ("Share of the ±10% ladder finishing at or above zero, 0–100"),
 * unlike `pop`, which is a 0–1 probability — so this is deliberately not `pct`,
 * and multiplying by a hundred here would print a plausible-looking 4,890%.
 */
function alreadyPct(n, dp = 2) {
  if (typeof n !== 'number' || !Number.isFinite(n)) return '—'
  return `${n.toFixed(dp)}%`
}

/** A market price. Always to the paisa, like every price on this desk. */
function price(n) {
  return plain(n, 2)
}

/**
 * A PLAN's breakevens — where carrying it to expiry finishes flat.
 *
 * `PlanScore.breakevens` arrives ASCENDING with the absent sides already dropped
 * (`goals.ts`'s `runBreakevens` filters the nulls out of the `{down, up}` pair),
 * so two values are the pair, none is a run that never crosses zero — unbounded
 * safety, not missing data — and ONE IS PRINTED WITHOUT A SIDE on purpose: the
 * repair wire carries no future price to compare a lone crossing against, and
 * calling it the down one when it is the up one names a level the operator would
 * defend from the wrong direction.
 */
function breakevensText(be) {
  const xs = (Array.isArray(be) ? be : []).filter((n) => typeof n === 'number' && Number.isFinite(n))
  return xs.length === 0 ? '—' : xs.map((n) => price(n)).join('/')
}

/**
 * A STRIKE, which is not the same thing: `720CE`, not `720.00CE`. Two decimals
 * appear only when the strike really carries them, as index strikes on a 50-point
 * ladder do not and a stock's 2437.50 does.
 */
function strikeText(n) {
  if (typeof n !== 'number' || !Number.isFinite(n)) return '—'
  return plain(n, Number.isInteger(n) ? 0 : 2)
}

/** `2026-08-19 14:32:05 IST` — the desk's own clock, never the box's. */
function istStamp(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return '—'
  const iso = new Date(ms + IST_OFFSET_MS).toISOString()
  return `${iso.slice(0, 10)} ${iso.slice(11, 19)} IST`
}

// -------------------------------------------------------------------- layout

/** A `label   value` block, values right-aligned against each other. */
function fields(rows) {
  const live = rows.filter((r) => r !== null)
  if (live.length === 0) return []
  const labelWidth = Math.max(...live.map(([label]) => label.length))
  const valueWidth = Math.max(...live.map(([, value]) => value.length))
  return live.map(([label, value, note]) => {
    const line = `  ${label.padEnd(labelWidth)}  ${value.padStart(valueWidth)}`
    return note === undefined || note === '' ? line : `${line}  ${note}`
  })
}

/**
 * A column table. `aligns` is one `l`/`r` per column; every cell is already a
 * string, because the caller knows which of them are money and which are not.
 */
function columns(headers, aligns, rows) {
  const widths = headers.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => (r[i] ?? '').length)),
  )
  const line = (cells) =>
    `  ${cells
      .map((c, i) => (aligns[i] === 'r' ? (c ?? '').padStart(widths[i]) : (c ?? '').padEnd(widths[i])))
      .join('  ')}`.trimEnd()
  return [line(headers), ...rows.map(line)]
}

function section(title, body) {
  return body.length === 0 ? [] : ['', title, ...body]
}

/** Response warnings and the view's own, in order, without repeats. */
function allWarnings(...lists) {
  const seen = new Set()
  const out = []
  for (const list of lists) {
    for (const w of Array.isArray(list) ? list : []) {
      if (typeof w !== 'string' || w === '' || seen.has(w)) continue
      seen.add(w)
      out.push(w)
    }
  }
  return out
}

function warningBlock(warnings) {
  return section(
    'WARNINGS',
    warnings.map((w) => `  ! ${w}`),
  )
}

// -------------------------------------------------------------- the payoff

function renderPayoff(res) {
  const out = []
  const where = [res.symbol, res.expiry].filter((s) => typeof s === 'string' && s !== '').join(' ')
  out.push(`${res.tag}  ·  ${res.mode}${where === '' ? '' : `  ·  ${where}`}`)
  out.push(
    `future ${price(res.future)}   spot ${price(res.spot)}   as of ${istStamp(res.asOf)}`,
  )

  const view = res.view
  if (view === null || view === undefined) {
    out.push('')
    out.push('  no payoff could be built — see the warnings below')
    out.push(...renderMachine(res.machine))
    out.push(...warningBlock(allWarnings(res.warnings)))
    return out.join('\n')
  }

  const s = view.summary ?? {}
  const be = s.breakevens ?? {}
  const bothWays =
    be.down === null || be.down === undefined
      ? be.up === null || be.up === undefined
        ? 'none — this book never crosses zero at expiry'
        : `up ${price(be.up)}`
      : be.up === null || be.up === undefined
        ? `down ${price(be.down)}`
        : `${price(be.down)}  ·  ${price(be.up)}`

  out.push(
    ...section(
      /**
       * THE CAVEAT IS PART OF THE HEADING, not a footnote. `floor`, `max profit`
       * and `max loss` are all read off the ±10% expiry scan (`view.ts:93-100`),
       * and that file is emphatic that `maxLossAt` landing on the scan's own
       * edge is the NORMAL case for short premium — a strangle's real downside
       * is unbounded, and the number printed here is "how bad is a 10% move",
       * never "how bad can it get". An operator sizing against an unqualified
       * `floor` is sizing against a number that does not mean what it says.
       */
      'SUMMARY (P&L at expiry; floor/max loss over the ±10% scan — not a bound)',
      fields([
        ['floor', money(s.floor)],
        ['max profit', money(s.maxProfit)],
        ['max loss', money(s.maxLoss), `@ ${price(s.maxLossAt)}`],
        ['breakevens', bothWays],
        // NAMED, because it is not the run's probability: `view.ts` computes it
        // on the OPEN legs' unshifted expiry column, so a book carrying a big
        // realised profit has a POP that ignores it. An unlabelled "POP" beside
        // a `booked` line reads as the run's, and it is not.
        ['POP (open legs)', pct(s.pop)],
        ['net credit', money(s.netCredit)],
        ['booked', money(s.booked)],
        s.targetPnl === null || s.targetPnl === undefined
          ? ['target', 'none set']
          : ['target', money(s.targetPnl)],
      ]),
    ),
  )

  const rows = (view.table ?? []).map((r) => [
    price(r.price),
    String(r.label ?? ''),
    plain(r.expiry),
    plain(r.t0),
    plain(r.mid),
  ])
  out.push(
    ...section(
      `PAYOFF   T+0 today, mid ${view.midDate || '—'}, expiry ${res.expiry || '—'}`,
      rows.length === 0 ? [] : columns(['price', 'label', 'expiry', 'T+0', 'mid'], ['r', 'l', 'r', 'r', 'r'], rows),
    ),
  )

  const g = view.greeks ?? {}
  out.push(
    ...section(
      'GREEKS (Black-76, per point of future)',
      fields([
        ['delta', plain(g.delta)],
        ['gamma', plain(g.gamma, 4)],
        ['theta', plain(g.theta)],
        ['vega', plain(g.vega)],
      ]),
    ),
  )

  out.push(...renderMachine(res.machine))
  out.push(...warningBlock(allWarnings(res.warnings, view.warnings)))
  return out.join('\n')
}

/** What the BOT is about to do about this book, in its own words. */
function renderMachine(machine) {
  if (machine === null || machine === undefined) {
    return section('MACHINE MIND', ['  the machine card could not be read for this book'])
  }
  const yesNo = (v) => (v === null || v === undefined ? 'unknown' : v ? 'yes' : 'no')
  const body = fields([
    ['delta tolerance', pct(machine.deltaTolPct)],
    ['delta imbalance', pct(machine.deltaImbalance)],
    ['would rebalance', yesNo(machine.wouldRebalance)],
    [
      'margin gate',
      machine.shiftEnabled === null || machine.shiftEnabled === undefined
        ? 'unknown'
        : machine.shiftEnabled
          ? 'open'
          : 'shut',
      machine.marginFrac === null || machine.marginFrac === undefined
        ? ''
        : `(${pct(machine.marginFrac)} of the cap)`,
    ],
    ['flatten target', machine.targetPnl === null || machine.targetPnl === undefined ? 'none set' : money(machine.targetPnl)],
  ])
  // Verbatim: `machine.ts` writes these to be rendered as they are, each one
  // naming its own numbers.
  const notes = (machine.notes ?? []).map((n) => `  · ${n}`)
  return section('MACHINE MIND', [...body, ...(notes.length === 0 ? [] : ['', ...notes])])
}

// -------------------------------------------------------------- the repair

/**
 * Lots, from shares, using the chain's own lot size.
 *
 * A size that is not a whole number of lots is printed in SHARES rather than
 * rounded into a lie — `dials.lotSize` is 0 when the instrument master does not
 * know the contract, and "0.4 lots" is not an order anybody can place.
 */
function lotsOf(qty, lotSize) {
  const shares = Math.abs(Number(qty) || 0)
  if (!(lotSize > 0)) return `${plain(shares, 0)} shares`
  const lots = shares / lotSize
  if (!Number.isInteger(lots)) return `${plain(shares, 0)} shares`
  return `${plain(lots, 0)} lot${lots === 1 ? '' : 's'}`
}

/**
 * The per-share fill a move assumes, or null when it cannot be known.
 *
 * THE WIRE CARRIES NO PRICE ON A MOVE — `Move` is `{op, strike, type, qty}` and
 * nothing more, so this is a recovery, not a field. `applyMoves` books an open
 * as `credit += -qty · entry`, exactly, so a plan whose ONLY move is an open
 * has `score.credit / -qty` as that open's entry, to the paisa. A plan with two
 * moves has one credit over two fills and no unique split, so it gets no price
 * at all rather than a guessed one — which is why this is conditioned on the
 * move count and not on the op alone.
 */
function fillOf(plan, move) {
  if (!Array.isArray(plan.moves) || plan.moves.length !== 1) return null
  if (move.op !== 'add' && move.op !== 'hedge') return null
  const qty = Number(move.qty)
  const credit = Number(plan.score?.credit)
  if (!Number.isFinite(qty) || qty === 0 || !Number.isFinite(credit)) return null
  const per = credit / -qty
  return Number.isFinite(per) && per > 0 ? per : null
}

/** One move as a sentence an operator could read down the phone. */
function moveLine(move, plan, dials) {
  if (move === null || typeof move !== 'object') return 'an unreadable move'
  if (move.op === 'add' || move.op === 'hedge') {
    // The SIGN is the side, always — `add` and `hedge` are the operator's words
    // for the two directions and `applyMoves` treats them identically. Reading
    // the op as the side is what turns a long wing into a short one.
    const side = Number(move.qty) < 0 ? 'Sell' : 'Buy'
    const at = fillOf(plan, move)
    return `${side} ${lotsOf(move.qty, dials?.lotSize)} ${strikeText(move.strike)}${move.type}${
      at === null ? '' : ` @ ${money(at)}`
    }`
  }
  if (move.op === 'shift') return `Shift ${move.legId} → ${strikeText(move.toStrike)}`
  if (move.op === 'close') return `Close ${move.legId}`
  return `an unrecognised move: ${JSON.stringify(move)}`
}

function renderRepair(res) {
  const out = []
  const dials = res.dials ?? {}
  out.push(`REPAIR  ·  ${res.tag}  ·  ${res.mode}  ·  ${istStamp(res.asOf)}`)
  out.push(
    `lot size ${dials.lotSize > 0 ? plain(dials.lotSize, 0) : 'unknown'}   ` +
      `${plain(res.universe?.atomic, 0)} single moves over ${plain(res.universe?.evaluated, 0)} quotable contracts`,
  )

  for (const entry of res.goals ?? []) {
    const plans = (entry.plans ?? []).slice(0, PLANS_SHOWN)
    out.push('')
    out.push(entry.goal)
    if (plans.length === 0) {
      out.push('  no plan found — the chain offered nothing this goal could use')
      continue
    }
    for (const [i, plan] of plans.entries()) {
      if (i > 0) out.push('')
      const head = `  ${String(i + 1).padStart(2)}. `
      const pad = ' '.repeat(head.length)
      const moves = (plan.moves ?? []).map((m) => moveLine(m, plan, dials))
      const lines = moves.length === 0 ? ['do nothing — the baseline every plan is scored against'] : moves
      out.push(`${head}${lines[0]}`)
      for (const l of lines.slice(1)) out.push(`${pad}${l}`)
      const s = plan.score ?? {}
      /**
       * `width` IS THE RANKING NUMBER FOR ONE OF THE FOUR GOALS, and without it
       * a whole section reads as mis-sorted. PROFITABLE-BY-EXPIRY's objective is
       * `[profitableWidthPct, pop]` (`goals.ts:390`) and nothing else — so its
       * plan 1 routinely shows a worse credit, a worse floor, a worse shock AND
       * a worse margin than its plan 2, which is not a bug and looks exactly
       * like one. The other three goals rank on numbers already on this line;
       * width is printed for all of them anyway, because one score line that
       * changes its columns per section is harder to read than one wide one.
       *
       * `@ <price>` ON THE FLOOR AND `BE` BESIDE THE WIDTH complete the columns
       * the spec's decision table promises. WHERE a floor happens is half of
       * what the floor means — a −₹98,000 at the bottom of the ±10% scan is a
       * crash away, the same number at the money is the next tick — and the
       * breakevens are the two prices a desk watches the tape against, which no
       * other column on this line implies.
       */
      out.push(
        `${pad}credit ${money(s.credit)}   floor ${money(s.maxLoss)} @ ${price(s.maxLossAt)}   ` +
          `worst shock ${money(s.worstShock)}   margin Δ ${signedMoney(s.marginDelta)}   ` +
          `width ${alreadyPct(s.profitableWidthPct)}   BE ${breakevensText(s.breakevens)}`,
      )
      const flags = (plan.flags ?? []).filter((f) => typeof f === 'string' && f !== '')
      if (flags.length > 0) out.push(`${pad}${flags.map((f) => `[${f}]`).join(' ')}`)
    }
  }

  out.push(...warningBlock(allWarnings(res.warnings)))
  return out.join('\n')
}

// ------------------------------------------------------------------ the wire

/**
 * One GET. NEVER THROWS — every outcome is an answer, because the caller's job
 * is to print one and set an exit code.
 */
function get(target, token) {
  return new Promise((resolve) => {
    let url
    try {
      url = new URL(target)
    } catch {
      resolve({ ok: false, why: `${target} is not a URL` })
      return
    }
    const send = url.protocol === 'https:' ? httpsRequest : httpRequest
    const req = send(
      url,
      {
        method: 'GET',
        headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
        // See the file header: one socket, no pool, prompt exit.
        agent: false,
        timeout: TIMEOUT_MS,
      },
      (res) => {
        const chunks = []
        res.on('data', (c) => chunks.push(c))
        /**
         * A CONNECTION THAT DIES AFTER THE HEADERS DIES ON THE RESPONSE.
         *
         * Once the headers are through, node has handed the socket to `res`,
         * and every subsequent failure is emitted THERE: probed against a stub
         * that writes a header and then destroys its socket, the order is `res`
         * 'aborted' → `req` 'close' → `res` 'error' ECONNRESET, and `req`'s
         * 'error' — which used to be the only listener in this function — never
         * fires at all. Neither does `res` 'end'. So the promise never settled,
         * `main` never returned, the event loop emptied, and the process exited
         * 0 having printed NOTHING: a `pm2 restart dx-api` mid-answer looked,
         * to anything reading the exit code, like a book with no floor to
         * report.
         */
        res.on('error', (err) => {
          resolve({
            ok: false,
            why: `the connection to ${url.origin} broke mid-answer: ${
              err instanceof Error ? err.message : String(err)
            }`,
          })
        })
        res.on('end', () => {
          // `res.complete` is false when 'end' arrives on a body the socket cut
          // short. A truncated body is not an answer — and the dangerous case
          // is not the one that fails to parse, it is the prefix that happens
          // to parse into a book missing half its legs.
          if (res.complete === false) {
            resolve({ ok: false, why: `${url.origin} stopped answering part-way through the body` })
            return
          }
          resolve({ ok: true, status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString('utf8') })
        })
      },
    )
    req.on('timeout', () => {
      req.destroy(new Error(`no answer from ${url.origin} in ${TIMEOUT_MS}ms`))
    })
    req.on('error', (err) => {
      resolve({ ok: false, why: err instanceof Error ? err.message : String(err) })
    })
    /**
     * THE BACKSTOP, and it costs nothing. A request that has closed has no
     * answer coming, whatever did or did not emit first. `resolve` is a no-op
     * after the first call and 'close' arrives AFTER 'end' on every healthy
     * response (probed), so on the ordinary path this listener does nothing —
     * it exists so that a settle-less exit is unreachable by construction
     * rather than by having enumerated the ways a socket can die.
     */
    req.on('close', () => {
      resolve({ ok: false, why: `the connection to ${url.origin} closed with no answer` })
    })
    req.end()
  })
}

/** The answer as an object, or the sentence explaining its absence. */
async function ask(base, path, params, token) {
  const url = `${base.replace(/\/+$/, '')}${path}?${new URLSearchParams(params).toString()}`
  const res = await get(url, token)
  if (!res.ok) return { ok: false, why: `${res.why} (DESK_API_URL is ${base})` }
  let body = null
  try {
    body = JSON.parse(res.text)
  } catch {
    // A body that is not JSON is a failure whatever the status says — the same
    // rule `routes/payoff.ts` applies to the broker proxy, and for the same
    // reason: a 200 carrying a login page is not a 200.
    return { ok: false, why: `HTTP ${res.status} from ${url}: ${res.text.slice(0, 200)}` }
  }
  if (res.status === 401) {
    return {
      ok: false,
      body,
      why:
        token === ''
          ? 'the bridge refused us and DESK_API_TOKEN is not set — export the same token the desk processes share'
          : 'the bridge refused this DESK_API_TOKEN (401)',
    }
  }
  if (res.status < 200 || res.status >= 300) {
    const stated = body !== null && typeof body === 'object' && typeof body.error === 'string' ? body.error : ''
    return { ok: false, body, why: stated === '' ? `HTTP ${res.status} from ${url}` : stated }
  }
  return { ok: true, body }
}

// ------------------------------------------------------------------ the entry

function parseArgs(argv) {
  let tag = null
  let mode = 'paper'
  let repair = false
  let json = false
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]
    if (a === '--help' || a === '-h') return { help: true }
    else if (a === '--repair') repair = true
    else if (a === '--json') json = true
    else if (a === '--mode' || a.startsWith('--mode=')) {
      const v = a === '--mode' ? argv[(i += 1)] : a.slice('--mode='.length)
      if (v === undefined) return { error: '--mode needs a value: live or paper' }
      if (v !== 'live' && v !== 'paper') return { error: `--mode takes live or paper, not '${v}'` }
      mode = v
    } else if (a.startsWith('-')) return { error: `unknown option '${a}'` }
    else if (tag === null) tag = a
    else return { error: `one book at a time — got '${tag}' and '${a}'` }
  }
  if (tag === null) return { error: 'a book tag is required' }
  return { tag, mode, repair, json }
}

async function main(argv) {
  const args = parseArgs(argv)
  if (args.help === true) {
    process.stdout.write(`${USAGE}\n`)
    return 0
  }
  if (args.error !== undefined) {
    process.stderr.write(`desk-payoff: ${args.error}\n\n${USAGE}\n`)
    return 1
  }

  const base = (process.env['DESK_API_URL'] ?? '').trim() || DEFAULT_URL
  const token = process.env['DESK_API_TOKEN'] ?? ''
  const answer = await ask(
    base,
    args.repair ? '/v1/desk/repair' : '/v1/desk/payoff',
    { tag: args.tag, mode: args.mode },
    token,
  )

  if (!answer.ok) {
    // `--json` still prints whatever body arrived, so a caller piping this into
    // `jq` sees the bridge's own words rather than an empty stdout.
    if (args.json && answer.body !== undefined && answer.body !== null) {
      process.stdout.write(`${JSON.stringify(answer.body, null, 2)}\n`)
    }
    process.stderr.write(`desk-payoff: ${answer.why}\n`)
    return 1
  }

  const body = answer.body ?? {}
  if (args.json) process.stdout.write(`${JSON.stringify(body, null, 2)}\n`)

  /**
   * A 200 CARRYING `error` IS STILL A FAILURE. The endpoints answer "no such
   * book" as a 200 with a sentence, on purpose — a polling dashboard has to
   * render that as text rather than as a failed fetch. A shell has no such
   * need, and a script that reads a payoff for a tag it typo'd must not carry
   * on as though it got one.
   */
  if (typeof body.error === 'string' && body.error !== '') {
    process.stderr.write(`desk-payoff: ${body.error}\n`)
    return 1
  }

  if (!args.json) {
    process.stdout.write(`${args.repair ? renderRepair(body) : renderPayoff(body)}\n`)
  }
  return 0
}

/**
 * `process.exitCode` rather than `process.exit`, so a piped stdout is flushed
 * before the process goes: `process.exit` truncates a pending write to a pipe,
 * which is exactly what a `| less` or a `> file` is.
 */
main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code
  },
  (err) => {
    process.stderr.write(`desk-payoff: ${err instanceof Error ? err.stack : String(err)}\n`)
    process.exitCode = 1
  },
)
