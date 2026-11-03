/**
 * THE DRY-RUN FEED — a scripted market, so a rehearsal is a rehearsal and not a
 * wait for something to happen.
 *
 * The supervisor decides off `md.tick` and nothing else. On a real desk those
 * ticks come from `apps/marketdata`, which needs a Kite login, a session, and a
 * market that happens to be doing the thing you want to watch. This script is the
 * other end of the same wire: it binds the SAME `WsTransportServer` marketdata
 * binds, on the same port, and publishes a fabricated walk over a 21-strike chain
 * and its future — so an operator can put each behaviour on the screen on
 * purpose, in order, before the first live session.
 *
 * ── USAGE ───────────────────────────────────────────────────────────────────
 *
 *     DESK_BROKER=simulate make up
 *     npx pm2 stop dx-marketdata          # it owns the bus port; see below
 *     node scripts/dryrun-feed.mjs rally
 *
 * Then create the book from the `recenter-relief-r` preset on the Books page and
 * watch. (The NSE repo's `docs/GOING-LIVE-RUNBOOK-SUPERVISOR.md` was the checklist
 * of what each scenario should do; it was not carried into the Delta desk.)
 *
 *     node scripts/dryrun-feed.mjs <scenario> [--symbol TCS] [--expiry 2026-08-28]
 *                                  [--spot 3000] [--seconds 900] [--rate 2]
 *
 * `node scripts/dryrun-feed.mjs` with no scenario lists them, with what each one
 * should produce and roughly how long it takes.
 *
 * ── WHY MARKETDATA HAS TO BE STOPPED ────────────────────────────────────────
 * `apps/marketdata/src/main.ts` binds `DESK_BUS_PORT`, and two processes cannot
 * hold one port. This script binds it instead, which also means the rest of the
 * desk needs no configuration at all to see this feed: desk-api, the supervisor
 * and the runner connect to the same URL they always do. Start marketdata again
 * when the rehearsal is over.
 *
 * ── THE TOKENS ARE REAL, THE PRICES ARE NOT ─────────────────────────────────
 * The instrument tokens come out of the `instrument` collection through the same
 * `OptionMaster` the supervisor resolves with. That is not decoration: a
 * `ChainView` DROPS a tick whose token belongs to no declared chain
 * (`chain-view.ts` §3), so a feed that invented its own token numbers would
 * publish perfectly and change nothing, which is the most expensive kind of
 * rehearsal there is. If the desk has no dump, run `make sync` first.
 *
 * Prices are Black-76 at a scenario-driven volatility — the same model the desk
 * MARKS with (`packages/greeks`) — so the greeks the engine computes off these
 * ticks are internally consistent and the bands it draws are the bands it would
 * draw. They are not a market: nothing here is calibrated to anything.
 *
 * ── THE TIMESTAMPS ARE THE WALL CLOCK, AND THEY HAVE TO BE ──────────────────
 * Every `md.tick` carries `ts: Date.now()`, and the status line prints the IST
 * clock beside it. A fabricated session timestamp — replaying yesterday's 11:30
 * onto today's desk — would be the one change that quietly disables the thing
 * this rehearsal is for: `shed.ts`'s liquidity gate refuses any quote older than
 * `quote_max_age_ms` (2 minutes), so every candidate would read as stale, every
 * sale would go out as a maker quote, and the `illiquid` scenario would be
 * indistinguishable from all five of the others. So the SHAPE of the session is
 * in the walk and the CLOCK is the real one, which is also what makes the marks
 * land on the desk's own 5-minute grid.
 *
 * ── DETERMINISM ─────────────────────────────────────────────────────────────
 * Every published PRICE is a pure function of the FRAME INDEX. Two things make
 * that true and both are load bearing:
 *
 *   - one seeded PRNG per scenario (`mulberry32`, seeded off the scenario name),
 *     drawn from once per frame, so the noise is a sequence rather than a
 *     sample;
 *   - `progress` counted in FRAMES (`frames / totalFrames`), never in elapsed
 *     milliseconds. A wall-clock `progress` would put scheduler jitter, GC
 *     pauses and machine load into the price path itself — two runs of one
 *     seeded scenario would then emit different prices, and this paragraph would
 *     be true of the noise and false of everything the noise is added to.
 *
 * So the clock reaches the `ts` field and the status line and nothing else, and
 * `node scripts/dryrun-feed.mjs breach` twice emits the same walk value for
 * value. `--seconds` is a wall-clock REQUEST, honoured by choosing how many
 * frames to spread the walk over.
 *
 * ── ONE THING THE FEED CANNOT DO: MOVE THE SESSION GATE ─────────────────────
 * `decide()` holds outside 09:20–15:30 IST and on a non-trading day
 * (`engine.ts:249`), and it reads the SUPERVISOR's clock, not this one. So a
 * rehearsal run after hours will show a healthy feed, a filling chain, journalled
 * marks — and not one decision, with `… is not an NSE trading day` or a session
 * hold in the reason string. Rehearse inside the session. On `DESK_BROKER=
 * simulate` with a paper book that is safe, and it is the same window the live
 * flip will happen in.
 *
 * ── THE SAFETY GATE ─────────────────────────────────────────────────────────
 * This script REFUSES to run unless the broker mode is `simulate`. It publishes
 * prices that are not the market onto the bus the whole desk trades off; on a box
 * armed for XTS that is not a rehearsal, it is an instruction to trade against
 * fabricated quotes. `FORCE=1` is deliberately NOT accepted.
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { WsTransportServer } from '@algomaker/bus'
import { DECISIONS_END_MIN, RULES_START_MIN, isTradingDay } from '@algomaker/desk-engine'
import { b76Price } from '@algomaker/greeks'
import { OptionMaster } from '@algomaker/instruments'
import { loadStoredInstruments } from '../apps/marketdata/src/sync-runner.ts'
import { connectMongo } from '../apps/api/src/mongo.ts'

// ───────────────────────────────────────────────────────────── the scenarios

/**
 * What each scenario is FOR — the behaviour it puts on the screen, and roughly
 * how long it takes to get there.
 *
 * `marks` is the honest cost of the ones that need the 5-minute mark grid: the
 * target lock counts CONSECUTIVE marks (`guards.ts`), so `lock` cannot fire in
 * under about a quarter of an hour no matter how fast the ticks arrive. Saying so
 * here is cheaper than an operator concluding the lock is broken.
 */
const SCENARIOS = {
  drift: {
    what: 'spot wanders inside the band; the engine holds and journals its marks',
    expect: 'hold — no decision, one `desk-book-marks` row per 5-minute mark',
    minutes: 5,
  },
  rally: {
    what: 'spot ramps up ~10%, taking a one-step-OTM short call a full strike step ITM',
    expect: 'trigger `shift` — "N ITM short(s) re-centred on spot"',
    note:
      'set shift_margin_frac: 0 on the row first — the gate wants a FRESH BROKER margin figure\n' +
      '              and a rehearsal book has none, so phase S is silently skipped and you see a\n' +
      '              shed instead. Put it back to 0.6 afterwards.',
    minutes: 4,
  },
  breach: {
    what: 'spot ramps ~5% — out of the corridor, and NOT far enough to be a shift',
    expect: 'trigger `shed` — "sell N <strike><wing> (netΔ … vs allowed …)"',
    minutes: 3,
  },
  decay: {
    what: 'the wings collapse to scrap prices while spot barely moves',
    expect: 'trigger `scrap` — the paise shorts are bought back before anything new is sold',
    minutes: 4,
  },
  lock: {
    what: 'every short decays hard, so the book runs past `target_pnl` and STAYS past it',
    expect: 'trigger `lock` after 3 consecutive marks — the guard flattens the book',
    minutes: 20,
  },
  illiquid: {
    what: 'every strike but the ATM goes UNQUOTED while spot breaches, so the sale cannot cross',
    expect: 'the sale is QUOTED, not crossed — an ERROR line naming the maker quote and its price',
    minutes: 3,
  },
}

// ────────────────────────────────────────────────────────────────── the walk

/**
 * A tiny seeded PRNG. Deterministic, and deliberately not `Math.random`: a
 * rehearsal that cannot be replayed is an anecdote.
 */
function mulberry32(seed) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const seedOf = (name) => {
  let h = 2166136261
  for (const ch of name) h = Math.imul(h ^ ch.charCodeAt(0), 16777619)
  return h >>> 0
}

/**
 * The scenario's state at a point in the run: where spot is, and what the
 * volatility surface is worth.
 *
 * `progress` is 0 → 1 across the scenario's own duration, so the shape of a
 * scenario does not depend on how fast frames go out.
 */
function walk(scenario, progress, rand) {
  // ±0.4% of jitter on every path, so nothing is a straight line.
  const jitter = (rand() - 0.5) * 0.008
  switch (scenario) {
    case 'rally':
      // FURTHER than `breach`, and that is the whole difference between them.
      // Phase S measures how deep the short strike is IN THE MONEY, in strike
      // STEPS — `shift_itm_steps: 1` on a 10-point ladder wants spot a full 10
      // points through the short call, which a 4% move on a 300-rupee underlying
      // does not deliver. +10% does, with room for the jitter.
      return { spotMult: 1 + 0.1 * Math.min(1, progress * 1.4) + jitter, volMult: 1 + 0.3 * progress }
    case 'breach':
      // Enough to leave the corridor and stay out — and deliberately NOT enough
      // to take a one-step-OTM short a full step ITM, so what this scenario shows
      // is phase R on its own rather than a shift that happens to shed after it.
      return { spotMult: 1 + 0.05 * Math.min(1, progress * 1.6) + jitter, volMult: 1 + 0.2 * progress }
    case 'decay':
      // Spot stands still and the time value goes. That is what makes a wing
      // scrap-priced rather than cheap.
      return { spotMult: 1 + jitter * 0.4, volMult: Math.max(0.06, 1 - 0.95 * progress) }
    case 'lock':
      /**
       * The same collapse, but FLOORED — and the floor is the whole scenario.
       *
       * The target lock counts three consecutive marks, so the book has to sit
       * past `target_pnl` for a quarter of an hour. Decay it all the way (as
       * `decay` does) and the shorts cross `scrap_close_px` in the first minute:
       * the scrap tier buys them back, the book goes flat, the P&L the lock was
       * counting disappears, and the guard never sees a second mark. Stopping at
       * 60% of the volatility leaves each short worth a fifth of what it was sold
       * for — well past any sane target, and well clear of scrap.
       *
       * The decay finishes in the first QUARTER of the scenario, because what
       * takes the time here is not the decay: it is the three consecutive
       * 5-minute marks the lock has to count afterwards.
       */
      return { spotMult: 1 + jitter * 0.3, volMult: Math.max(0.6, 1 - 0.4 * Math.min(1, progress * 4)) }
    case 'illiquid':
      // A breach, so the desk WANTS to sell — the illiquidity is in the book
      // shape, not in the path (see `quoteFor`).
      return { spotMult: 1 + 0.08 * Math.min(1, progress * 1.6) + jitter, volMult: 1 + 0.2 * progress }
    default:
      // `drift`: a random walk that goes nowhere.
      return { spotMult: 1 + jitter, volMult: 1 + (rand() - 0.5) * 0.1 }
  }
}

/**
 * The two-sided book on one contract — or the UNQUOTED one the `illiquid`
 * scenario needs.
 *
 * The liquidity gate refuses a book that is not two-sided outright
 * (`shed.ts:296`), and that refusal is what routes the sale through the maker
 * quote instead of across the spread.
 *
 * TWO DETAILS DECIDE WHETHER THIS ACTUALLY WORKS, and both were got wrong first:
 *
 *   1. **The tick carries NEITHER side, not one of them.** `ChainView` retains
 *      the last two-sided pair through a tick that has no book (§1 — the TCS
 *      2440 PE case), so a bid-only tick following any two-sided one leaves the
 *      OLD pair in place and the gate sees a healthy, ageing market. Publishing
 *      a print with no depth at all is what a strike nobody is quoting really
 *      looks like on this feed (`marketdata`'s `tickPayload` omits the fields).
 *   2. **The wing is fixed to spot0, not to the moving spot.** These scenarios
 *      ramp, so a boundary measured off the live spot would walk across the
 *      ladder and hand a strike a pair halfway through the run.
 *
 * EVERYTHING BUT THE ATM STRIKE GOES DARK, which is what an illiquid stock chain
 * really looks like — one strike with a book and a ladder of last prints (the TCS
 * 2440 PE of 2026-08-17, generalised). The ATM keeps its book on purpose:
 * `theoreticalPrice` walks the wing outwards from the sale strike and needs ONE
 * mid to solve a volatility off, and a chain with no mid anywhere prices nothing
 * — the host then DROPS the sale rather than crossing it, which is a different
 * behaviour and a different line in the log (`engine-host.ts:#quoteAt`).
 *
 * A dark strike is still MARKED: `midOf` falls back to the print for a genuinely
 * one-sided book, so the greeks and the band are unaffected. What it is not is
 * EXIT-priced — `exitPrice` never substitutes a print — so a book on dark strikes
 * shows unpriced legs in its P&L. That is the exit-side rule working, not the
 * rehearsal failing.
 */
function quoteFor(scenario, price, strike, optType, spot0, step, tickSize) {
  const round = (v) => Math.max(tickSize, Math.round(v / tickSize) * tickSize)
  const half = Math.max(tickSize, round(price * 0.01))
  if (scenario === 'illiquid' && Math.abs(strike - spot0) >= step) {
    // A print, and no book behind it.
    return { bid: null, ask: null }
  }
  return { bid: round(price - half), ask: round(price + half) }
}

// ────────────────────────────────────────────────────────────────── the shell

function usage(msg) {
  const rows = Object.entries(SCENARIOS)
    .map(
      ([k, v]) =>
        `    ${k.padEnd(9)} ${v.what}\n              → ${v.expect} (~${v.minutes}m)` +
        (v.note === undefined ? '' : `\n              ! ${v.note}`),
    )
    .join('\n')
  console.error(
    `${msg === undefined ? '' : `${msg}\n\n`}usage: node scripts/dryrun-feed.mjs <scenario> [options]\n\n` +
      `scenarios:\n${rows}\n\n` +
      'options:\n' +
      '    --symbol <SYM>     underlying (default: DESK_DRYRUN_SYMBOL, else the first chain in the dump)\n' +
      '    --expiry <DATE>    YYYY-MM-DD (default: the nearest listed expiry)\n' +
      '    --spot <PRICE>     where the walk starts (default: the middle listed strike)\n' +
      '    --seconds <N>      how long the scenario takes to play out (default: its own)\n' +
      '    --rate <N>         frames per second (default: 2)\n',
  )
  process.exit(2)
}

function args(argv) {
  const [scenario, ...rest] = argv
  if (scenario === undefined || !(scenario in SCENARIOS)) {
    usage(scenario === undefined ? undefined : `unknown scenario ${JSON.stringify(scenario)}`)
  }
  const opts = { scenario }
  for (let i = 0; i < rest.length; i += 2) {
    const key = rest[i]
    const value = rest[i + 1]
    if (key === undefined || !key.startsWith('--') || value === undefined) usage(`bad option near ${String(key)}`)
    opts[key.slice(2)] = value
  }
  return opts
}

/**
 * The broker mode, read the way the Makefile's `ARM_GUARD` reads it — from
 * `.env.local`, tolerating whitespace and quotes.
 *
 * The Makefile's own comment records why this is not a naive grep: `  DESK_BROKER
 * = "xts"` armed the real broker under a banner saying `simulate`.
 */
function brokerMode() {
  const fromEnv = process.env['DESK_BROKER']
  if (fromEnv !== undefined && fromEnv.trim() !== '') return fromEnv.trim().replace(/^["']|["']$/g, '')
  try {
    const text = readFileSync(new URL('../.env.local', import.meta.url), 'utf8')
    const hit = /^[ \t]*DESK_BROKER[ \t]*=[ \t]*(.*)$/m.exec(text)
    if (hit === null) return 'simulate'
    return (hit[1] ?? '').trim().replace(/^["']|["']$/g, '')
  } catch {
    // No `.env.local` at all is a fresh checkout, which is `simulate`.
    return 'simulate'
  }
}

/**
 * The bus port, from `DESK_BUS_URL` if it names one, else `DESK_BUS_PORT`.
 *
 * `DESK_BUS_URL` is what every CONSUMER reads and `DESK_BUS_PORT` is what
 * `apps/marketdata` BINDS, so a rehearsal has to agree with the consumers first
 * and fall back to the binder. A URL that does not parse is not an error worth
 * stopping for — it means the same thing an absent one does.
 */
function busPort() {
  const url = process.env['DESK_BUS_URL']
  if (url !== undefined && url.trim() !== '') {
    try {
      const port = Number(new URL(url).port)
      if (Number.isInteger(port) && port > 0) return port
    } catch {
      // Not a URL. Fall through to the port variable.
    }
  }
  const port = Number(process.env['DESK_BUS_PORT'] ?? 8891)
  return Number.isInteger(port) && port > 0 ? port : 8891
}

const IST_OFFSET_MIN = 5 * 60 + 30

/** `HH:MM:SS` in IST — the clock every log on this desk is read against. */
function istClock(ms) {
  const d = new Date(ms + IST_OFFSET_MIN * 60_000)
  return d.toISOString().slice(11, 19)
}

/** Minutes since IST midnight; 555 is 09:15 and 930 is 15:30. */
function istMinutes(ms) {
  const d = new Date(ms + IST_OFFSET_MIN * 60_000)
  return d.getUTCHours() * 60 + d.getUTCMinutes()
}

/** `YYYY-MM-DD` in IST — the shape `isTradingDay` reads. */
function istDate(ms) {
  return new Date(ms + IST_OFFSET_MIN * 60_000).toISOString().slice(0, 10)
}

// ──────────────────────────────────────────────────────────────────── main

async function main() {
  try {
    // `fileURLToPath`, not `.pathname`: a URL percent-encodes, and a checkout
    // under a path with a space in it would look like a missing file.
    // An environment variable already set WINS over the file (Node's own
    // `--env-file` rule), so `DESK_BROKER=simulate node …` still means what it
    // says on a box whose `.env.local` says otherwise.
    process.loadEnvFile(fileURLToPath(new URL('../.env.local', import.meta.url)))
  } catch {
    // Nothing to load, or an older Node. The environment stands as it is.
  }

  const opts = args(process.argv.slice(2))
  const scenario = opts.scenario
  const spec = SCENARIOS[scenario]

  const mode = brokerMode()
  if (mode !== 'simulate') {
    console.error(
      `\nREFUSED: DESK_BROKER is "${mode}", not "simulate".\n\n` +
        '  This script publishes prices that are NOT the market onto the bus the whole desk\n' +
        '  trades off. On a box armed for a real broker that is not a rehearsal — every book\n' +
        '  steering off this feed would be deciding against quotes nobody quoted.\n\n' +
        '  Set DESK_BROKER=simulate in .env.local and `make restart` first.\n',
    )
    process.exit(1)
  }

  const mongoUrl = process.env['DESK_MONGO_URL']
  if (mongoUrl === undefined || mongoUrl.trim() === '') {
    console.error('DESK_MONGO_URL is required — the tokens come out of the instrument dump.')
    process.exit(1)
  }

  const mongo = await connectMongo(mongoUrl)
  const master = new OptionMaster(await loadStoredInstruments(mongo.db.collection('instrument')))

  const symbol = opts.symbol ?? process.env['DESK_DRYRUN_SYMBOL'] ?? master.underlyings()[0]
  if (symbol === undefined) {
    console.error(
      'the instrument dump lists no option chain at all — run `make sync` before rehearsing.',
    )
    await mongo.close()
    process.exit(1)
  }
  const today = istDate(Date.now())
  const expiry = opts.expiry ?? master.nearestExpiry(symbol, today)
  if (expiry === null || expiry === undefined) {
    console.error(`the dump lists no expiry for ${symbol} on or after ${today}.`)
    await mongo.close()
    process.exit(1)
  }
  const chain = master.chain(symbol, expiry)
  const future = master.future(symbol)
  if (chain === null || chain.strikes.length < 3) {
    console.error(`the dump lists no usable chain for ${symbol} ${expiry}.`)
    await mongo.close()
    process.exit(1)
  }
  if (future === null) {
    // `ChainView` cannot snap without one: the forward IS the spot contract
    // (`chain-view.ts` §4), and a chain with no future never decides anything.
    console.error(`the dump lists no future for ${symbol} — the supervisor cannot snap this chain.`)
    await mongo.close()
    process.exit(1)
  }

  const step = chain.strikeStep ?? 0
  if (!(step > 0)) {
    console.error(`the dump does not imply a strike step for ${symbol} ${expiry}.`)
    await mongo.close()
    process.exit(1)
  }

  /**
   * WHERE THE WALK STARTS. The middle listed strike by default, so the 21-strike
   * window is centred on a strike that really exists — the same reason
   * `atmStrike` snaps to the list rather than to `round(spot/step)*step`.
   */
  const listed = [...chain.strikes].sort((a, b) => a - b)
  const spot0 = Number(opts.spot ?? listed[Math.floor(listed.length / 2)])
  if (!(spot0 > 0)) usage(`--spot ${String(opts.spot)} is not a price`)

  const atm = master.atmStrike(symbol, expiry, spot0) ?? spot0
  const ladder = []
  for (let i = -10; i <= 10; i++) {
    const strike = atm + i * step
    if (listed.includes(strike)) ladder.push(strike)
  }
  if (ladder.length < 5) {
    console.error(
      `only ${String(ladder.length)} of the 21 strikes around ${String(atm)} are listed — ` +
        'pass a --spot inside the chain.',
    )
    await mongo.close()
    process.exit(1)
  }

  /** Every contract the walk will publish, resolved ONCE through the master. */
  const contracts = []
  for (const strike of ladder) {
    for (const optType of ['CE', 'PE']) {
      const ref = master.resolve(symbol, expiry, strike, optType)
      if (ref === null) continue
      contracts.push({ token: ref.instrumentToken, strike, optType, tickSize: ref.tickSize || 0.05 })
    }
  }

  const seconds = Number(opts.seconds ?? spec.minutes * 60)
  if (!(seconds > 0)) usage(`--seconds ${String(opts.seconds)} is not a duration`)
  const rate = Number(opts.rate ?? 2)
  // Refused rather than clamped: a `NaN` here makes `1000 / rate` a `NaN`, and
  // `setInterval` reads that as "as fast as you can" — a scenario that publishes
  // several thousand frames a second at a desk that expected two.
  if (!(rate > 0) || rate > 50) usage(`--rate ${String(opts.rate)} must be between 0 and 50 frames/s`)
  const frameMs = Math.max(20, Math.round(1000 / rate))
  const rand = mulberry32(seedOf(scenario))
  const rate0 = 0.065
  const dte = Math.max(
    0.5,
    (Date.parse(`${expiry}T10:00:00.000Z`) - Date.now()) / 86_400_000,
  )
  const baseVol = 0.32

  const port = busPort()
  const bus = new WsTransportServer({ port })
  // AWAITED ON THE NEXT LINE, and it has to be: `ready()` waits on
  // `once('listening')`, so a caller that constructs the server, does something
  // slow, and only then asks, waits forever on an event that has already fired.
  await bus.ready()

  console.log(
    `\n  dry-run feed · ${scenario}\n` +
      `  ${spec.what}\n` +
      `  expect: ${spec.expect}\n` +
      (spec.note === undefined ? '' : `  NOTE:   ${spec.note.replace(/\n {14}/g, '\n          ')}\n`) +
      '\n' +
      `  chain    ${symbol} ${expiry} · ${String(ladder.length)} strikes · step ${String(step)} · lot ${String(chain.lotSize)}\n` +
      `  future   ${future.tradingsymbol} (${String(future.instrumentToken)})\n` +
      `  spot0    ${spot0.toFixed(2)} (ATM ${String(atm)})\n` +
      `  bus      ws://127.0.0.1:${String(port)} · ${String(rate)} frames/s · ${String(contracts.length + 1)} ticks per frame\n` +
      `  runs for ${String(seconds)}s, then holds the last market until Ctrl-C\n`,
  )

  /**
   * The session warning, measured against the ENGINE'S OWN constants rather than
   * against two numbers copied into this file — `RULES_START_MIN` moved once
   * already (09:15 → 09:20, user-directed 2026-08-03: "option prints on the 09:15
   * candle move too much to act on"), and a rehearsal script that still warned
   * against the old one would say the market was open when the engine did not
   * agree.
   */
  const nowMs = Date.now()
  const openMin = istMinutes(nowMs)
  const dateIst = istDate(nowMs)
  if (!isTradingDay(dateIst) || openMin < RULES_START_MIN || openMin > DECISIONS_END_MIN) {
    console.log(
      `  NOTE: it is ${istClock(nowMs)} IST on ${dateIst}, which is outside the engine's session\n` +
        "  gate. That gate is the SUPERVISOR's clock, not this feed's — so every book will take\n" +
        '  ticks, journal its marks and decide NOTHING, with the session hold in the reason\n' +
        '  string. Rehearse inside 09:20–15:30 on a trading day.\n',
    )
  }

  /**
   * THE SCENARIO'S LENGTH, IN FRAMES — and the whole of what `progress` is
   * measured against.
   *
   * `--seconds` is a wall-clock REQUEST, honoured by choosing how many frames to
   * spread the walk over; it is not the walk's clock. A `progress` taken from
   * `Date.now()` would make the price path itself a function of scheduler jitter,
   * GC pauses and machine load — two runs of one seeded scenario would emit
   * different prices, and the determinism this script promises would be true only
   * of the noise and false of everything the noise is added to.
   *
   * Derived from `frameMs` rather than from `rate` so it stays honest when the
   * two differ: `rate` is what was asked for and `frameMs` is what `setInterval`
   * will actually do with it.
   */
  const totalFrames = Math.max(1, Math.round((seconds * 1000) / frameMs))
  const startedAt = Date.now()
  let frames = 0
  let lastSpot = spot0

  const tick = () => {
    const now = Date.now()
    // THE FRAME INDEX, never the clock. See `totalFrames`.
    const progress = Math.min(1, frames / totalFrames)
    const { spotMult, volMult } = walk(scenario, progress, rand)
    const spot = spot0 * spotMult
    lastSpot = spot
    const vol = Math.max(0.02, baseVol * volMult)
    const t = dte / 365

    bus.publish(
      'md.tick',
      {
        token: future.instrumentToken,
        price: Number(spot.toFixed(2)),
        ts: now,
        bid: Number((spot - Math.max(0.05, spot * 0.0002)).toFixed(2)),
        ask: Number((spot + Math.max(0.05, spot * 0.0002)).toFixed(2)),
      },
      now,
    )

    for (const c of contracts) {
      const price = Math.max(
        c.tickSize,
        b76Price({ future: spot, strike: c.strike, t, vol, rate: rate0, type: c.optType }),
      )
      const book = quoteFor(scenario, price, c.strike, c.optType, spot0, step, c.tickSize)
      bus.publish(
        'md.tick',
        {
          token: c.token,
          price: Number(price.toFixed(2)),
          ts: now,
          ...(book.bid === null ? {} : { bid: Number(book.bid.toFixed(2)) }),
          ...(book.ask === null ? {} : { ask: Number(book.ask.toFixed(2)) }),
        },
        now,
      )
    }
    frames++
  }

  const timer = setInterval(tick, frameMs)
  const status = setInterval(() => {
    const elapsed = Math.round((Date.now() - startedAt) / 1000)
    console.log(
      `  ${istClock(Date.now())} IST · ${String(elapsed)}s · spot ${lastSpot.toFixed(2)} ` +
        `(${(((lastSpot - spot0) / spot0) * 100).toFixed(2)}%) · ${String(frames)} frames · ` +
        `${String(bus.clientCount)} subscriber(s)`,
    )
  }, 5_000)

  const stop = async () => {
    clearInterval(timer)
    clearInterval(status)
    console.log(`\n  stopped after ${String(frames)} frames. Start desk-marketdata again when you are done.\n`)
    await bus.close()
    await mongo.close()
    process.exit(0)
  }
  process.on('SIGINT', () => void stop())
  process.on('SIGTERM', () => void stop())
}

main().catch((err) => {
  console.error('[dryrun-feed] fatal', err)
  process.exit(1)
})
