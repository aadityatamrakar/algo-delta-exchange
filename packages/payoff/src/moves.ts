/**
 * A BOOK, PLUS THE MOVES SOMEBODY IS THINKING ABOUT.
 *
 * The repairer proposes; this applies. Everything downstream — the what-if
 * curve, the margin estimate, the score a plan is ranked by — is computed on the
 * book this function returns, so it is the one place where a proposal turns into
 * numbers a human then trades on. Three rules follow from that, and they are the
 * whole design:
 *
 * 1. IT NEVER FABRICATES A FILL. A move whose price the chain does not carry is
 *    DROPPED and named in `warnings` — not marked at the entry, not at the last
 *    known, not at zero. A repair priced off an invented fill looks free and
 *    isn't, and the operator finds that out at the broker.
 *
 * 2. A CLOSE IS REALISED, NOT ERASED. Removing a leg books `qty · (mark −
 *    entry)` into `realisedDelta`. A shift that carries a short from 700 to 720
 *    is a close and an open, so it pays what it costs to get out of the 700 and
 *    collects what the 720 fetches — never a free re-strike.
 *
 * 3. A SHIFT IS ATOMIC. If either half has no price, NEITHER half happens. The
 *    failure it prevents is a panel drawing a book one leg lighter than the real
 *    one, which is the naked-book state the desk's own playbook guards against
 *    when the chain has no mark (playbooks.py:3867-3871).
 *
 * MONEY, IN TWO SEPARATE BUCKETS, because they answer different questions:
 *
 *   `creditDelta`   premium received − premium paid, cash across the moves. An
 *                   open contributes `−qty · entry` (a sell has `qty < 0`, so it
 *                   is a credit) and a close contributes `qty · mark` (buying a
 *                   short back is money out). Same sign convention as
 *                   `Surface.netCredit`, so the two can be added.
 *   `realisedDelta` P&L banked by the closes, to be added to whatever the book
 *                   had already realised before the view shifts its curves.
 *
 * `qty` IS SIGNED SHARES, everywhere, as in `legs.ts` — the `op` name is a label
 * for provenance and for the generated leg id, and it is `qty` that decides buy
 * or sell. `{op:'add', qty:-1000}` sells 1000 shares' worth; the arithmetic here
 * reads the sign and never the word. New legs are named `<op>:<strike><type>` —
 * `add:600PE`, `hedge:730CE`, `shift:720CE` — suffixed `#2`, `#3` … if the book
 * already holds that id, so a plan's legs stay addressable by a later `close`.
 *
 * A FUTURE IS NOT ON THE CHAIN, so it gets its own mark. `priceOf` speaks for
 * options only — it is keyed by `(strike, type)` and a future has neither — and
 * for a long time that meant a futures leg could be generated as a `close` and
 * then silently refused, which makes "flatten this book" unproposable on exactly
 * the books that most need flattening. The optional `futureMark` closes that:
 * pass the traded future price and a futures close marks at it, linearly. Omit
 * it and the old refusal stands, because marking a future at a guess is the same
 * lie as marking an option at one.
 *
 * TWO THINGS ABOUT THE MONEY ON THAT CLOSE, both of them the futures contract
 * and not a modelling choice. Its P&L is `qty · (F − entry)` — linear, no model.
 * And it contributes NOTHING to `creditDelta`: a future carries no premium, it
 * settles through variation margin, so no premium changes hands when one is
 * closed. Booking the notional there would report a ₹786,000 "cost" to flatten a
 * 1,000-share short, which is not a number anybody pays and which would wreck
 * every credit-denominated score downstream.
 *
 * ONE EXPIRY. `priceOf`/`ivOf` are keyed by `(strike, type)` alone, so they can
 * only speak for ONE chain: the book's own expiry. A book holding two months
 * would have its far-month legs marked off the near-month chain, silently. Every
 * live desk book is single-expiry (mixed expiry is deferred by the spec), and
 * closing that hole means widening the two callbacks, not patching it here.
 *
 * A FUTURE CAN BE OPENED TOO (`{op:'future', qty}`), because the cheapest,
 * exactest way to take delta off a book is the future and not an option: it adds
 * no gamma, no vega and no decay, and a delta search that could only reach for
 * options would always answer the simple question with a complicated trade. It
 * follows the futures-close rules above to the letter — it fills at `futureMark`
 * or not at all (no mark, no move, a warning), and it moves NO premium, so it
 * contributes nothing to `creditDelta`. The new leg is `future:FUT` in the book's
 * month, entered at the mark — so its P&L is zero AT THAT MARK, and a caller who
 * values the book at a different future price sees the gap as the fill's cost.
 *
 * THE SIDE A TRADE CROSSES. `priceOf` is ONE price per contract — the mark — and
 * a plan that buys at the mark and sells at the mark pays no spread, which on a
 * wide stock-option book is the difference between a repair that pays and one
 * that does not. The optional `fillOf(strike, type, qty)` is asked instead when
 * given, with the SIGNED shares of THAT trade (`qty > 0` is a buy), so the caller
 * can answer "the ask" for a buy and "the bid" for a sell. It is asked for every
 * fill this file makes: an open's entry, a close's exit (buying a short back is a
 * buy), and both halves of a shift. Omitted, every fill is `priceOf`, exactly as
 * before. Its refusals are `priceOf`'s: null, a non-positive price or a throw
 * drops the move with the same warning.
 */
import type { OptionType } from '@algomaker/greeks'
import type { PayoffLeg } from './legs.ts'

/**
 * One proposed change. `add`/`hedge` open a NEW contract at the chain's price;
 * `shift` re-strikes an existing leg at the same size; `close` takes one off;
 * `future` opens the book month's future at `futureMark` — `qty` SIGNED SHARES,
 * a whole number of lots by the generator's construction (this file has no lot).
 */
export type Move =
  | { readonly op: 'add'; readonly strike: number; readonly type: OptionType; readonly qty: number }
  | { readonly op: 'hedge'; readonly strike: number; readonly type: OptionType; readonly qty: number }
  | { readonly op: 'shift'; readonly legId: string; readonly toStrike: number }
  | { readonly op: 'close'; readonly legId: string }
  | { readonly op: 'future'; readonly qty: number }

/** The price a trade of `qty` SIGNED shares fills at — `qty > 0` is a buy. See the header. */
export type FillOf = (strike: number, type: OptionType, qty: number) => number | null

/** The book as it would stand, and what getting there costs and banks. */
export interface AppliedBook {
  readonly legs: readonly PayoffLeg[]
  /** Premium received − premium paid, in rupees. Positive is cash in. */
  readonly creditDelta: number
  /** P&L booked by the closes, in rupees. */
  readonly realisedDelta: number
  /** One sentence per move that did not happen, naming it. */
  readonly warnings: readonly string[]
}

/** A price we are willing to trade on: finite and above zero. */
function usable(v: number | null | undefined): number | null {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null
}

function finite(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

/** `-0` is a real stored value in JSON and in `deepStrictEqual`. Fold it. */
function zeroFold(v: number): number {
  return v === 0 ? 0 : v
}

/**
 * Apply `moves` to `legs`, in order.
 *
 * `priceOf` is the chain's LTP for a contract and `ivOf` its solved vol; both
 * return `null` for a contract the chain cannot price, and both are allowed to
 * throw — a lookup that blows up is treated as "no price", never as a crash.
 *
 * `futureMark` is the traded future price, and it exists so a FUTURES leg can be
 * closed, and a `future` move opened (see the header). Omitted, both are refused.
 *
 * `fillOf` prices each trade at the side it crosses (see the header); omitted,
 * every fill is `priceOf`.
 *
 * The input `legs` are not mutated: the returned book is a new array of the same
 * (frozen-by-convention) leg objects, plus new ones for the opens.
 */
export function applyMoves(
  legs: readonly PayoffLeg[],
  moves: readonly Move[],
  priceOf: (strike: number, type: OptionType) => number | null,
  ivOf: (strike: number, type: OptionType) => number | null,
  futureMark?: number,
  fillOf?: FillOf,
): AppliedBook {
  const start: PayoffLeg[] = Array.isArray(legs) ? legs.filter((l) => l !== null && typeof l === 'object') : []
  const warnings: string[] = []

  const ask = (fn: (k: number, t: OptionType) => number | null, k: number, t: OptionType): number | null => {
    try {
      return fn(k, t)
    } catch {
      return null
    }
  }
  /** What a trade of `qty` signed shares fills at: `fillOf`'s side when given, else the mark. */
  const fill = (k: number, t: OptionType, qty: number): number | null => {
    if (typeof fillOf !== 'function') return ask(priceOf, k, t)
    try {
      return fillOf(k, t, qty)
    } catch {
      return null
    }
  }

  try {
    const book: PayoffLeg[] = [...start]
    let credit = 0
    let realised = 0

    /** A leg id nothing in the book is using yet, from `<op>:<contract>`. */
    const idFor = (base: string): string => {
      if (!book.some((l) => l.id === base)) return base
      for (let n = 2; ; n += 1) {
        const candidate = `${base}#${n}`
        if (!book.some((l) => l.id === candidate)) return candidate
      }
    }

    /** The month the book trades. Adds join the book they are repairing. */
    const bookExpiry = (): string | null => {
      const found = book.find((l) => typeof l.expiry === 'string' && l.expiry !== '')
      return found === undefined ? null : found.expiry
    }

    for (const move of Array.isArray(moves) ? moves : []) {
      if (move === null || typeof move !== 'object') {
        warnings.push('a move was not an object and was ignored')
        continue
      }

      // ---- open a new contract -----------------------------------------
      if (move.op === 'add' || move.op === 'hedge') {
        const strike = finite(move.strike)
        const qty = finite(move.qty)
        const type = move.type === 'CE' || move.type === 'PE' ? move.type : null
        if (strike === null || type === null || qty === null || qty === 0) {
          warnings.push(`${move.op} ${String(move.strike)}${String(move.type)} x ${String(move.qty)}: not a tradeable leg — dropped`)
          continue
        }
        const entry = usable(fill(strike, type, qty))
        if (entry === null) {
          warnings.push(`${move.op} ${strike}${type}: no price on the chain — dropped rather than filled at a guess`)
          continue
        }
        const expiry = bookExpiry()
        if (expiry === null) {
          warnings.push(`${move.op} ${strike}${type}: the book has no expiry to copy — dropped`)
          continue
        }
        book.push({
          id: idFor(`${move.op}:${strike}${type}`),
          instrument: 'option',
          qty,
          strike,
          type,
          expiry,
          entry,
          iv: usable(ask(ivOf, strike, type)),
        })
        credit += -qty * entry
        continue
      }

      // ---- open the book month's future --------------------------------
      if (move.op === 'future') {
        const qty = finite(move.qty)
        if (qty === null || qty === 0) {
          warnings.push(`future ${String(move.qty)}: not a tradeable leg — dropped`)
          continue
        }
        const entry = usable(futureMark)
        if (entry === null) {
          const why =
            futureMark === undefined
              ? 'no future price was supplied to fill it at'
              : `the future price ${String(futureMark)} is not a usable mark`
          warnings.push(`future ${qty}: ${why} — dropped rather than filled at a guess`)
          continue
        }
        const expiry = bookExpiry()
        if (expiry === null) {
          warnings.push(`future ${qty}: the book has no expiry to copy — dropped`)
          continue
        }
        book.push({ id: idFor('future:FUT'), instrument: 'future', qty, strike: null, type: null, expiry, entry, iv: null })
        // NO PREMIUM ON A FUTURE — see the header. Nothing is added to `credit`.
        continue
      }

      // ---- take one off ------------------------------------------------
      if (move.op === 'close') {
        const idx = book.findIndex((l) => l.id === move.legId)
        if (idx < 0) {
          warnings.push(`close "${String(move.legId)}": no such leg in the book — dropped`)
          continue
        }
        const leg = book[idx]!
        // The close is the opposite trade: buying a short back is a buy.
        const exitQty = -(finite(leg.qty) ?? 0)
        const priced = markOf(leg, (k, t) => fill(k, t, exitQty), futureMark)
        if (priced === null) {
          warnings.push(`close "${leg.id}": ${whyUnpriceable(leg, futureMark)} — dropped rather than closed at a guess`)
          continue
        }
        book.splice(idx, 1)
        realised += (finite(leg.qty) ?? 0) * (priced - (finite(leg.entry) ?? 0))
        // NO PREMIUM ON A FUTURE — see the header. Its P&L is booked above and
        // settles through variation margin; nothing is paid for the contract.
        if (leg.instrument !== 'future') credit += (finite(leg.qty) ?? 0) * priced
        continue
      }

      // ---- re-strike, same size ----------------------------------------
      if (move.op === 'shift') {
        const idx = book.findIndex((l) => l.id === move.legId)
        if (idx < 0) {
          warnings.push(`shift "${String(move.legId)}": no such leg in the book — dropped`)
          continue
        }
        const leg = book[idx]!
        const toStrike = finite(move.toStrike)
        const type = leg.type
        if (leg.instrument !== 'option' || type === null || toStrike === null) {
          warnings.push(`shift "${leg.id}" to ${String(move.toStrike)}: only a priced option leg can be re-struck — dropped`)
          continue
        }
        if (toStrike === leg.strike) {
          // The playbook skips this case outright (playbooks.py:3939) — a shift
          // onto the strike the leg already holds is two fills and no change.
          warnings.push(`shift "${leg.id}" to ${toStrike}: it is already there — dropped`)
          continue
        }
        // ATOMIC: both marks or neither. A shift that half-lands leaves the
        // panel drawing a book that is one leg naked. The exit is the opposite
        // trade of the leg, the re-open the same side as it.
        const legQty = finite(leg.qty) ?? 0
        const out = markOf(leg, (k, t) => fill(k, t, -legQty))
        const back = usable(fill(toStrike, type, legQty))
        if (out === null || back === null) {
          const missing = out === null ? `${String(leg.strike)}${type}` : `${toStrike}${type}`
          warnings.push(
            `shift "${leg.id}" to ${toStrike}${type}: no price for ${missing} — the whole shift is dropped, ` +
              'never half-applied',
          )
          continue
        }
        const expiry = typeof leg.expiry === 'string' && leg.expiry !== '' ? leg.expiry : null
        if (expiry === null) {
          warnings.push(`shift "${leg.id}" to ${toStrike}${type}: the leg carries no expiry — dropped`)
          continue
        }
        const qty = legQty
        book.splice(idx, 1)
        realised += qty * (out - (finite(leg.entry) ?? 0))
        credit += qty * out
        book.push({
          id: idFor(`shift:${toStrike}${type}`),
          instrument: 'option',
          qty,
          strike: toStrike,
          type,
          expiry,
          entry: back,
          iv: usable(ask(ivOf, toStrike, type)),
        })
        credit += -qty * back
        continue
      }

      warnings.push(`unknown move "${String((move as { op?: unknown }).op)}" — ignored`)
    }

    return { legs: book, creditDelta: zeroFold(credit), realisedDelta: zeroFold(realised), warnings }
  } catch (err) {
    // Same promise the rest of the package makes: a repair search walks hundreds
    // of candidate plans, and one malformed move must cost that walk a warning
    // rather than the whole response.
    return {
      legs: start,
      creditDelta: 0,
      realisedDelta: 0,
      warnings: [...warnings, `moves could not be applied: ${err instanceof Error ? err.message : String(err)}`],
    }
  }
}

/**
 * The exit price for an existing leg: `price` (the chain, at the side the exit
 * crosses) for an option, `futureMark` for a future.
 */
function markOf(
  leg: PayoffLeg,
  price: (strike: number, type: OptionType) => number | null,
  futureMark?: number,
): number | null {
  if (leg.instrument === 'future') return usable(futureMark)
  if (leg.instrument !== 'option') return null
  const strike = finite(leg.strike)
  if (strike === null || leg.type === null) return null
  return usable(price(strike, leg.type))
}

/** Why `markOf` said no — so the warning names the actual reason. */
function whyUnpriceable(leg: PayoffLeg, futureMark?: number): string {
  if (leg.instrument === 'future') {
    return futureMark === undefined
      ? 'no future price was supplied to mark it against'
      : `the future price ${String(futureMark)} is not a usable mark`
  }
  if (leg.instrument !== 'option') return 'it is not an option, and this chain prices options only'
  if (finite(leg.strike) === null || leg.type === null) return 'it has no strike or type to price'
  return `no price for ${leg.strike}${leg.type} on the chain`
}
