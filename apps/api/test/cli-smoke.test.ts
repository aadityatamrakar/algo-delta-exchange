/**
 * `bin/desk-payoff.mjs` — the cockpit at a terminal, run for real.
 *
 * A SMOKE TEST, and deliberately only that. What it proves is the seam nothing
 * else can: that the file parses under a plain `node`, that it speaks the wire
 * shapes `routes/payoff.ts` actually serves, that it presents the bearer the
 * Python desk presents, and that a failure leaves a non-zero exit code behind
 * for whatever shell called it. The rendering itself is asserted only where a
 * wrong answer would be silent — the floor, which is the number an operator
 * opens this thing to read.
 *
 * IT IS SPAWNED, NOT IMPORTED. The CLI is a `.mjs` with no exports and no build
 * step, so there is nothing to import; and importing it would skip exactly the
 * two things that break in practice — the shebang-free entry running under the
 * installed node, and `process.exit` codes.
 *
 * THE SERVER IS A STUB, NOT THE BRIDGE. Standing up `apps/api` here would drag
 * in Mongo, a quote cache and an instrument master to test a printer. The
 * canned bodies below are typed as `PayoffResponse` / `RepairResponse` — the
 * route module's own exported types — so a wire change that would break the CLI
 * breaks this file at `make typecheck` instead of at 09:15 on a live desk.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type IncomingMessage, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { join } from 'node:path'
import type { PayoffResponse, RepairResponse } from '../src/routes/payoff.ts'

const run = promisify(execFile)

/** `apps/api/test` → the repo root → `bin/desk-payoff.mjs`. */
const CLI = join(import.meta.dirname, '..', '..', '..', 'bin', 'desk-payoff.mjs')

const TOKEN = 'smoke-token'

/** 2026-08-19T09:02:05Z — 14:32:05 in IST, which is what the header must say. */
const AS_OF = Date.parse('2026-08-19T09:02:05.000Z')

const PAYOFF: PayoffResponse = {
  tag: 'BHEL_STRANGLE',
  mode: 'paper',
  symbol: 'BHEL',
  expiry: '2026-08-28',
  future: 415.2,
  spot: 414.85,
  asOf: AS_OF,
  marketClosed: false,
  view: {
    // The dense scan is not rendered — one point is enough to prove the CLI
    // reads the table rather than the curve.
    curve: [{ price: 373.68, expiry: -123456.5, t0: -98000.25, mid: -110000 }],
    table: [
      { price: 373.68, label: '-10%', expiry: -123456.5, t0: -98000.25, mid: -110000 },
      { price: 415.2, label: 'spot', expiry: 18750, t0: 2300.5, mid: 9000.75 },
      { price: 456.72, label: '+10%', expiry: -91000, t0: -70000, mid: -80000 },
    ],
    midDate: '2026-08-23',
    summary: {
      maxProfit: 21050,
      maxLoss: -123456.5,
      maxLossAt: 373.68,
      breakevens: { down: 383.2, up: 447.1 },
      pop: 0.724,
      netCredit: 18750,
      worstShock: -45000,
      worstShockAt: 373.68,
      floor: -123456.5,
      booked: 2300,
      targetPnl: 15000,
    },
    greeks: { delta: -120.5, gamma: -4.25, theta: 850.25, vega: -300.75 },
    warnings: [],
  },
  machine: {
    deltaTolPct: 0.02,
    deltaImbalance: 0.031,
    wouldRebalance: true,
    shiftEnabled: false,
    marginFrac: 0.62,
    targetPnl: 15000,
    notes: ['netD is 3.1% of spot away from zero against a 2% tolerance'],
  },
  ivs: [],
  warnings: ['the feed is not ticking: every price below is the last one seen, not a live one'],
}

const REPAIR: RepairResponse = {
  tag: 'BHEL_STRANGLE',
  mode: 'paper',
  asOf: AS_OF,
  // The legs these cards address, fingerprinted — see `repair-plan.ts`.
  legsPrint: 'da39a3ee5e6b4b0d3255bfef95601890afd80709',
  dials: {
    addDeltaMin: 0.15,
    addDeltaMax: 0.35,
    shiftDeltaMin: 0.2,
    shiftDeltaMax: 0.3,
    hedgeDeltaMax: 0.1,
    hedgeBudgetFrac: 0.2,
    minCreditPerShare: 1,
    maxMarginAdd: null,
    lotSize: 5250,
    maxQuoteAgeMs: 120_000,
  },
  goals: [
    {
      goal: 'REDUCE-LOSS',
      plans: [
        {
          goal: 'REDUCE-LOSS',
          moves: [],
          score: {
            credit: 0,
            maxLoss: -123456.5,
            maxLossAt: 373.68,
            breakevens: [383.2, 447.1],
            worstShock: -45000,
            worstShockAt: 373.68,
            marginBefore: 250000,
            marginAfter: 250000,
            marginDelta: 0,
            profitableWidthPct: 41.3,
            pop: 0.724,
          },
          flags: ['baseline'],
        },
        {
          goal: 'REDUCE-LOSS',
          // One move, one open — which is also the only shape a per-share fill
          // price can be recovered from. See the CLI's `fillOf`.
          moves: [{ op: 'add', strike: 720, type: 'CE', qty: -5250 }],
          score: {
            credit: 32025,
            maxLoss: -98000,
            maxLossAt: 373.68,
            breakevens: [379.1, 452.4],
            worstShock: -30000,
            worstShockAt: 373.68,
            marginBefore: 250000,
            marginAfter: 262000,
            marginDelta: 12000,
            profitableWidthPct: 48.9,
            pop: 0.761,
          },
          flags: ['degrades-floor', 'bot-may-reshift'],
        },
        {
          goal: 'REDUCE-LOSS',
          moves: [
            { op: 'hedge', strike: 680, type: 'PE', qty: 5250 },
            { op: 'close', legId: 'BHEL26AUG700CE' },
            { op: 'shift', legId: 'BHEL26AUG440PE', toStrike: 420 },
          ],
          score: {
            credit: -8000,
            maxLoss: -60000,
            maxLossAt: 373.68,
            breakevens: [391.5, 441.2],
            worstShock: -22000,
            worstShockAt: 373.68,
            marginBefore: 250000,
            marginAfter: 210000,
            marginDelta: -40000,
            profitableWidthPct: 52.1,
            pop: 0.688,
          },
          flags: [],
        },
        // A FOURTH plan, which must NOT be printed: the menu shows three.
        {
          goal: 'REDUCE-LOSS',
          moves: [{ op: 'close', legId: 'BHEL26AUG440PE' }],
          score: {
            credit: -1000,
            maxLoss: -111111,
            maxLossAt: 373.68,
            breakevens: [],
            worstShock: -50000,
            worstShockAt: 373.68,
            marginBefore: 250000,
            marginAfter: 240000,
            marginDelta: -10000,
            profitableWidthPct: 30,
            pop: 0.5,
          },
          flags: ['NEVER-PRINTED'],
        },
      ],
    },
    {
      /**
       * THE GOAL WHOSE RANKING IS INVISIBLE unless the width is printed.
       * `goals.ts:390` ranks this one on `[profitableWidthPct, pop]` and on
       * nothing else, so these two plans are in the engine's correct order —
       * and plan 2 beats plan 1 on EVERY other column the CLI prints: better
       * credit, better floor, better worst shock, and it releases margin
       * instead of costing it. Without `width` on the line, the screen argues
       * for the plan the engine ranked second.
       */
      goal: 'PROFITABLE-BY-EXPIRY',
      plans: [
        {
          goal: 'PROFITABLE-BY-EXPIRY',
          moves: [
            { op: 'shift', legId: 'BHEL26AUG440PE', toStrike: 400 },
            { op: 'add', strike: 760, type: 'CE', qty: -5250 },
          ],
          score: {
            credit: 5000,
            maxLoss: -85000,
            maxLossAt: 373.68,
            breakevens: [370.4, 470.9],
            worstShock: -40000,
            worstShockAt: 373.68,
            marginBefore: 250000,
            marginAfter: 280000,
            marginDelta: 30000,
            profitableWidthPct: 61.2,
            pop: 0.7,
          },
          flags: [],
        },
        {
          goal: 'PROFITABLE-BY-EXPIRY',
          moves: [{ op: 'close', legId: 'BHEL26AUG760CE' }],
          score: {
            credit: 9000,
            maxLoss: -70000,
            maxLossAt: 373.68,
            /**
             * NO CROSSING EITHER SIDE, and that is a real shape rather than
             * missing data: `runBreakevens` drops the null sides, so a run whose
             * expiry payoff never reaches zero comes back empty. It must print
             * as a dash — a blank `BE` reads as a column the CLI forgot.
             */
            breakevens: [],
            worstShock: -25000,
            worstShockAt: 373.68,
            marginBefore: 250000,
            marginAfter: 245000,
            marginDelta: -5000,
            profitableWidthPct: 44.5,
            pop: 0.66,
          },
          flags: [],
        },
      ],
    },
    { goal: 'CHEAP-TAIL-CAP', plans: [] },
    { goal: 'MAX-CREDIT-SAFE', plans: [] },
  ],
  universe: { atomic: 42, evaluated: 80 },
  warnings: [],
}

interface Seen {
  readonly path: string
  readonly authorization: string
}

/**
 * A throwaway bridge on a random port, and the requests it received.
 *
 * `serve` returns the body for a path; returning `null` is a 404, which is how
 * a route the CLI must not call is proven uncalled.
 */
async function withStub(
  serve: (req: IncomingMessage) => unknown,
  fn: (base: string, seen: Seen[]) => Promise<void>,
): Promise<void> {
  const seen: Seen[] = []
  const server: Server = createServer((req, res) => {
    seen.push({ path: req.url ?? '', authorization: req.headers.authorization ?? '' })
    const body = serve(req)
    if (body === null) {
      res.writeHead(404, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: 'no such route' }))
      return
    }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify(body))
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  try {
    await fn(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen)
  } finally {
    await new Promise<void>((r) => server.close(() => r()))
  }
}

/** A port with nothing behind it — bound to learn the number, then released. */
async function deadPort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const port = (server.address() as AddressInfo).port
  await new Promise<void>((r) => server.close(() => r()))
  return port
}

function cli(base: string, args: readonly string[]): Promise<{ stdout: string; stderr: string }> {
  return run(process.execPath, [CLI, ...args], {
    env: { ...process.env, DESK_API_URL: base, DESK_API_TOKEN: TOKEN },
    // A cockpit dump is a few KB; the default 1MB is ample, but pinning it
    // means a runaway printer fails here rather than truncating silently.
    maxBuffer: 4 * 1024 * 1024,
  })
}

const payoffOnly = (req: IncomingMessage): unknown =>
  (req.url ?? '').startsWith('/v1/desk/payoff') ? PAYOFF : null

test('desk-payoff prints the floor, exits 0, and presents the machine bearer', async () => {
  await withStub(payoffOnly, async (base, seen) => {
    const { stdout } = await cli(base, ['BHEL_STRANGLE'])

    // THE ONE NUMBER THIS SCREEN EXISTS FOR — grouped the Indian way, two
    // decimals, and on a line labelled `floor`.
    assert.match(stdout, /^\s*floor\s+-₹1,23,456\.50/m)

    // AND IT IS NOT A BOUND, which the header has to say. `view.ts:93-100` is
    // emphatic: `maxLossAt` sitting on the edge of the ±10% scan is the NORMAL
    // case for short premium, and a short strangle's real downside is
    // unbounded. An unqualified `floor` is read as the worst that can happen.
    assert.match(stdout, /^SUMMARY .*±10% scan.*not a bound/m)

    // The rest of the summary block, spot-checked where a mis-wire would be
    // silent: POP is the OPEN-LEGS one and must say so.
    assert.match(stdout, /POP \(open legs\)\s+72\.40%/)
    assert.match(stdout, /max profit\s+₹21,050\.00/)
    assert.match(stdout, /max loss\s+-₹1,23,456\.50\s+@ 373\.68/)
    assert.match(stdout, /breakevens\s+383\.20/)
    assert.match(stdout, /net credit\s+₹18,750\.00/)
    assert.match(stdout, /booked\s+₹2,300\.00/)
    assert.match(stdout, /target\s+₹15,000\.00/)

    // The table, as aligned columns.
    assert.match(stdout, /price\s+label\s+expiry\s+T\+0\s+mid/)
    assert.match(stdout, /373\.68\s+-10%\s+-1,23,456\.50\s+-98,000\.25\s+-1,10,000\.00/)

    // The machine card and the warning channel both reach the terminal.
    assert.match(stdout, /netD is 3\.1% of spot away from zero/)
    assert.match(stdout, /the feed is not ticking/)

    // The header, with the instant rendered in IST rather than UTC.
    assert.match(stdout, /2026-08-19 14:32:05 IST/)

    assert.equal(seen.length, 1)
    assert.equal(seen[0]?.authorization, `Bearer ${TOKEN}`)
    // Mode defaults to paper — the safe one — and the tag is passed through.
    assert.match(seen[0]?.path ?? '', /^\/v1\/desk\/payoff\?tag=BHEL_STRANGLE&mode=paper$/)
  })
})

test('--mode live asks for the live book', async () => {
  await withStub(payoffOnly, async (base, seen) => {
    await cli(base, ['BHEL_STRANGLE', '--mode', 'live'])
    assert.match(seen[0]?.path ?? '', /mode=live/)
  })
})

test('--json prints the response verbatim and nothing else', async () => {
  await withStub(payoffOnly, async (base) => {
    const { stdout } = await cli(base, ['BHEL_STRANGLE', '--json'])
    assert.deepEqual(JSON.parse(stdout), JSON.parse(JSON.stringify(PAYOFF)))
  })
})

test('--repair prints four goals, three plans each, one line per move', async () => {
  await withStub(
    (req) => ((req.url ?? '').startsWith('/v1/desk/repair') ? REPAIR : null),
    async (base, seen) => {
      const { stdout } = await cli(base, ['BHEL_STRANGLE', '--repair'])

      // Every goal gets a section, including the three that came back empty.
      for (const goal of ['REDUCE-LOSS', 'PROFITABLE-BY-EXPIRY', 'CHEAP-TAIL-CAP', 'MAX-CREDIT-SAFE']) {
        assert.ok(stdout.includes(goal), `missing goal section ${goal}`)
      }

      // A goal the search could not serve says so rather than showing a gap.
      assert.match(stdout, /^CHEAP-TAIL-CAP\n\s+no plan found/m)

      // One human line per move. Lots come from `dials.lotSize`, and the fill
      // price is recovered from a single-move plan's credit.
      assert.match(stdout, /Sell 1 lot 720CE @ ₹6\.10/)
      assert.match(stdout, /Close BHEL26AUG700CE/)
      assert.match(stdout, /Shift BHEL26AUG440PE → 420/)
      assert.match(stdout, /do nothing/)

      // A MULTI-MOVE PLAN CARRIES NO PRICE, and the assertion is anchored to
      // the end of the line so that a guessed `@ ₹…` suffix — one credit split
      // across three fills, which has no unique answer — fails it rather than
      // slipping past a substring match.
      assert.match(stdout, /^\s*\d+\. Buy 1 lot 680PE$/m)

      // The four score columns the brief asks for.
      assert.match(stdout, /credit ₹32,025\.00/)
      assert.match(stdout, /floor -₹98,000\.00/)
      assert.match(stdout, /worst shock -₹30,000\.00/)
      assert.match(stdout, /margin Δ \+₹12,000\.00/)

      // WHERE THE FLOOR IS, and BETWEEN WHAT the plan is defended — the last two
      // columns the spec's decision table promises. A floor with no price beside
      // it cannot be told from one at the money, and no other column on the line
      // implies the breakevens.
      assert.match(stdout, /floor -₹98,000\.00 @ 373\.68/)
      assert.match(stdout, /BE 379\.10\/452\.40/)
      assert.match(stdout, /BE 383\.20\/447\.10/)
      // A run that never crosses zero is UNBOUNDED SAFETY, not a gap — one dash,
      // never a blank column and never an `undefined`.
      assert.match(stdout, /width 44\.50%\s+BE —$/m)

      // THE FIFTH COLUMN: the share of the ±10% ladder that finishes green.
      // It is on every plan line, because it is the number PROFITABLE-BY-EXPIRY
      // is ranked on and the reader cannot otherwise see why plan 1 is plan 1.
      assert.match(stdout, /width 41\.30%/)
      assert.match(stdout, /width 48\.90%/)
      assert.match(stdout, /width 52\.10%/)
      assert.match(stdout, /width 61\.20%/)
      assert.match(stdout, /width 44\.50%/)

      // And the goal that ranks on it shows its winner FIRST while losing every
      // other printed column — the exact shape that reads as a mis-ranking when
      // the ranking number is missing.
      const winner = stdout.indexOf('width 61.20%')
      const runnerUp = stdout.indexOf('width 44.50%')
      assert.ok(winner > 0 && winner < runnerUp, 'PROFITABLE-BY-EXPIRY plans are out of engine order')

      // Flags as badges, and the fourth plan left unprinted.
      assert.match(stdout, /\[degrades-floor\]/)
      assert.ok(!stdout.includes('NEVER-PRINTED'), 'more than three plans were printed')

      assert.equal(seen[0]?.authorization, `Bearer ${TOKEN}`)
      assert.match(seen[0]?.path ?? '', /^\/v1\/desk\/repair\?tag=BHEL_STRANGLE&mode=paper$/)
    },
  )
})

test('an unreachable bridge is exit 1 with the reason on stderr', async () => {
  const port = await deadPort()
  await assert.rejects(
    cli(`http://127.0.0.1:${port}`, ['BHEL_STRANGLE']),
    (err: NodeJS.ErrnoException & { code?: number | string; stderr?: string }) => {
      assert.equal(err.code, 1)
      assert.match(String(err.stderr), /desk-payoff/)
      return true
    },
  )
})

test('warnings come from BOTH channels and a warning in both prints once', async () => {
  /**
   * TWO CHANNELS, ONE LIST. `payoffOf` in `routes/payoff.ts` does NOT fold
   * `view.warnings` into the envelope's `warnings` (`repairOf` does), so a
   * reader of `res.warnings` alone silently drops every degraded-pricing
   * warning the view raised — the leg re-dated into the book's expiry, the
   * contract that never solved an IV. Reading `view.warnings` alone drops the
   * envelope's. And because the route can legitimately raise the SAME sentence
   * on both, the merge has to dedupe or the operator reads it twice and starts
   * looking for the second cause.
   *
   * The three assertions below fail on each of those three mistakes in turn.
   */
  const RES_ONLY = 'the feed is not ticking: every price below is the last one seen, not a live one'
  const VIEW_ONLY = 'no IV solved for BHEL26AUG440PE — it is marked at its entry'
  const BOTH = 'BHEL26AUG700CE expires 2026-08-21, before the book — it is priced to the book expiry'

  const twoChannel: PayoffResponse = {
    ...PAYOFF,
    view: { ...PAYOFF.view!, warnings: [VIEW_ONLY, BOTH] },
    warnings: [RES_ONLY, BOTH],
  }
  await withStub(
    (req) => ((req.url ?? '').startsWith('/v1/desk/payoff') ? twoChannel : null),
    async (base) => {
      const { stdout } = await cli(base, ['BHEL_STRANGLE'])
      assert.ok(stdout.includes(RES_ONLY), 'the envelope channel was dropped')
      assert.ok(stdout.includes(VIEW_ONLY), 'the view channel was dropped')
      assert.equal(
        stdout.split(BOTH).length - 1,
        1,
        'a warning raised on both channels was printed twice',
      )
    },
  )
})

test('a connection that dies after the headers is exit 1, not a silent blank screen', async () => {
  /**
   * THE FAILURE THIS EXISTS FOR. A bridge that writes its headers and then has
   * its socket go — an `nginx` restart mid-answer, a `pm2 restart dx-api`, a
   * VPN dropping — does NOT emit on the request object. Probed: the response
   * emits `aborted`, the request emits `close`, and the response emits
   * `ECONNRESET`; `req.on('error')` never fires and `res.on('end')` never fires.
   * A `get()` listening only on the request therefore never settles, `main`
   * never returns, the event loop empties, and node exits 0 having printed
   * NOTHING. A script that greps this output for a floor and finds none, on an
   * exit code of 0, concludes the book is flat.
   */
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    // Headers, then a prefix of a body that would have parsed, then nothing.
    res.write('{"tag":"BHEL_STRANGLE","mode":"paper","view":{"summ')
    setTimeout(() => res.socket?.destroy(), 20)
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const port = (server.address() as AddressInfo).port
  try {
    await assert.rejects(
      cli(`http://127.0.0.1:${port}`, ['BHEL_STRANGLE']),
      (err: NodeJS.ErrnoException & { code?: number | string; stdout?: string; stderr?: string }) => {
        assert.equal(err.code, 1, 'a dropped connection must not exit 0')
        // Loudly: a named line on stderr, not an empty stream.
        assert.match(String(err.stderr), /^desk-payoff: \S.*$/m)
        // And nothing on stdout that could be mistaken for a book.
        assert.equal(String(err.stdout), '')
        return true
      },
    )
  } finally {
    await new Promise<void>((r) => server.close(() => r()))
  }
})

test('a book with no future mark still prints — view null is a state, not a crash', async () => {
  // The routine degraded answer: no future printing, so nothing can be priced.
  // `view` and `machine` are independently nullable and here BOTH are absent,
  // which is the shape most likely to throw on a naive `view.summary.floor`.
  const unpriced: PayoffResponse = {
    ...PAYOFF,
    future: null,
    spot: null,
    view: null,
    machine: null,
    warnings: ['no future mark for BHEL — options are marked Black-76 off the future'],
  }
  await withStub(
    (req) => ((req.url ?? '').startsWith('/v1/desk/payoff') ? unpriced : null),
    async (base) => {
      const { stdout } = await cli(base, ['BHEL_STRANGLE'])
      assert.match(stdout, /no payoff could be built/)
      assert.match(stdout, /no future mark for BHEL/)
      // A missing number is a dash, never a zero and never a stack trace.
      assert.match(stdout, /future —\s+spot —/)
    },
  )
})

test("a book the bridge does not know is exit 1, not a blank screen", async () => {
  const missing: PayoffResponse = {
    ...PAYOFF,
    view: null,
    machine: null,
    warnings: [],
    error: "'NOPE' has no book in paper — neither open legs nor a registry row",
  }
  await withStub(
    (req) => ((req.url ?? '').startsWith('/v1/desk/payoff') ? missing : null),
    async (base) => {
      await assert.rejects(
        cli(base, ['NOPE']),
        (err: NodeJS.ErrnoException & { code?: number | string; stderr?: string }) => {
          assert.equal(err.code, 1)
          assert.match(String(err.stderr), /has no book in paper/)
          return true
        },
      )
    },
  )
})

test('no tag is a usage message and exit 1', async () => {
  await withStub(payoffOnly, async (base, seen) => {
    await assert.rejects(
      cli(base, []),
      (err: NodeJS.ErrnoException & { code?: number | string; stderr?: string }) => {
        assert.equal(err.code, 1)
        assert.match(String(err.stderr), /usage: desk-payoff/)
        return true
      },
    )
    assert.equal(seen.length, 0, 'a malformed invocation must not reach the bridge')
  })
})
