/**
 * THE PAYOFF COCKPIT ON THE BOOK PAGE — three curves, the floor, the bot's own
 * mind, and what a human could do instead, under the position they describe.
 *
 * It reads four endpoints and draws five things: the dense ±10% scan valued on
 * three dates, the summary an operator sizes against, the `recenter-relief`
 * playbook's two triggers as the strategy itself evaluates them, a what-if
 * overlay for legs nobody has placed, and the repair menu with the broker's own
 * margin beside each row.
 *
 * ── IT SHIPS FOLDED, AND A FOLDED PANEL COSTS NOTHING ───────────────────────
 *
 * The whole cockpit lives behind one disclosure row and the row is CLOSED by
 * default. That is a load decision as much as a layout one: the payoff GET
 * scans the realised fill journal, solves the chain and files a snapshot every
 * minute, and it used to do that on every book page whether or not anybody was
 * reading the curve. The body is UNMOUNTED while the row is folded — not merely
 * hidden — so the poll's interval is cleared with it and the chart's
 * ResizeObserver goes with it too. `PayoffPanel` below is the row; `PayoffBody`
 * is everything else, and it is the only half that reads the network.
 *
 * WHAT SURVIVES A FOLD IS THE TEASER AND NOTHING ELSE. The last summary the
 * body saw is lifted into the row so a folded panel can still print the floor
 * and the breakeven band — the two figures somebody would open it FOR. The
 * repair menu, the proposal and any open apply modal are earned against a
 * moment and are dropped, the same as when the book tab changes.
 *
 * ── IT PLACES ORDERS NOW, THROUGH FOUR GATES, NONE OF THEM HERE ─────────────
 *
 * `GET /v1/desk/payoff` and `GET /v1/desk/repair` change nothing and the
 * what-if POST is a pure calculation over a hypothetical. The one path out of
 * this file that ends in a broker order is Apply, and it does not end there
 * FROM HERE: the card opens `RepairApplyDialog`, and everything consequential
 * happens inside it — a PREFLIGHT against the book as it stands (`POST
 * /repair/preflight`, which writes nothing and reaches no rail), every order it
 * would send rendered with its estimate, the CONFIRM modal that button lives
 * in, the OPERATOR'S PASSWORD on a live book, and finally `POST /repair/apply`,
 * which places them through `SubmitService` — the same instance the Manual
 * Order dialog and every hosted strategy submit through, with this desk's own
 * gates and journal behind it. Closes go before opens, at the desk, never here.
 *
 * WHAT THIS FILE OWNS IS THE FOUR REFUSALS NO PREFLIGHT COULD RESCUE, and they
 * sit on the CARD because they are properties of the PLAN rather than of the
 * book: a baseline row places nothing, an unknown lot size means the sizes
 * printed are not orders anybody could send, `no-feasible-plan` is the
 * least-bad row rather than a repair, and one modal at a time — the run is
 * claimed per tag and the decision id is minted per open. Every other refusal
 * (a dropped move, a hold already on the tag, an open with no quote) belongs to
 * the SERVER, and the modal says each one in the server's own words.
 *
 * ── ONE PRESS, ONE SEARCH ───────────────────────────────────────────────────
 *
 * The repair GET is not polled and may not be double-sent: each one runs a beam
 * search that prices hundreds of candidate books through the same surface
 * engine the chart draws. It is single-flighted through a REF rather than
 * through the busy flag beside it — a second click inside the same React batch
 * sees the old state, and the ref is the only thing already true.
 *
 * ── SIXTY SECONDS, NOT FIVE ─────────────────────────────────────────────────
 *
 * The page above polls positions at 5s. This must NOT: every successful GET
 * solves the whole chain's implied vols, prices 121 points on three dates,
 * scans the realised fill journal and files a ~30KB snapshot. At the positions
 * cadence that is twelve times the work for a curve whose shape moves with the
 * future — and the box's Mongo is pinned to a kernel and its disk filling stops
 * the desk. The chart's usefulness is not a function of its refresh rate.
 *
 * ── BOTH WARNING CHANNELS, MERGED ───────────────────────────────────────────
 *
 * `payoffOf` in `routes/payoff.ts` does NOT fold `view.warnings` into the
 * envelope's — they are separate lists that fail for separate reasons, and the
 * view's are the per-leg ones ("no IV; it marks flat until expiry") that say a
 * curve is understating the book's risk. A panel reading only the envelope's
 * drops exactly the sentences that qualify the figures beside them. Both are
 * read, in order, deduped — the same merge `bin/desk-payoff.mjs` does.
 *
 * ── WHAT THE FIGURES ARE, AND ARE NOT ───────────────────────────────────────
 *
 *   FLOOR / MAX LOSS are read off the ±10% SCAN's edge. A short strangle's real
 *   downside is unbounded and `maxLossAt` landing on the scan's own edge is the
 *   normal case for short premium, so the caveat is in the section heading
 *   rather than in a footnote nobody reads (`view.ts:93-100`).
 *
 *   POP IS THE OPEN LEGS', not the run's: `view.ts` computes it on the
 *   unshifted expiry column, so a book carrying a large realised profit has a
 *   POP that ignores it. The chip says so in its label, beside breakevens that
 *   ARE run-level. An unlabelled "POP" next to `booked` reads as the run's.
 *
 *   THE BREAKEVENS HERE ARE NOT THE HEADER TILES'. Those come from
 *   `bookBreakevens` — client-side arithmetic over strikes and entry prices
 *   plus the bridge's realised figure. These are the payoff engine's exact
 *   kinks with ITS OWN realised, scanned from the fill journal, folded in —
 *   same question, two bookkeepers, so on a book whose two realised figures
 *   disagree the levels can differ slightly. Both labels carry `incl. booked`.
 *
 *   NO GREEKS. `view.greeks` are Black-76 per point of FUTURE; the tiles above
 *   this panel are the bridge's own, per point of spot, and one of them can be
 *   the strategy's shorts-only steering pair. Three deltas on one screen is the
 *   defect this desk keeps re-finding, so this panel prints none and the header
 *   stays the one place a book's greeks are read.
 *
 * ── A NULL IS AN UNKNOWN, EVERYWHERE ────────────────────────────────────────
 *
 * Every figure that can be absent renders as an em dash. That matters most on
 * the machine card, whose whole point is the difference between "the margin
 * gate is shut" and "I could not read the margin" — the first is the bot
 * holding, the second is the operator deciding without it.
 *
 * ── IT IS A LEAF MODULE ─────────────────────────────────────────────────────
 *
 * It imports no page. `Stat`/`StatCell` live in `pages.tsx`, which is the
 * module that MOUNTS this panel, so importing them back would make the two
 * circular; `chart.tsx`, `pnl.tsx` and `orderlog.tsx` are all leaves for the
 * same reason. `Figure` below is the divided-cell shape those tiles use, over
 * the same `.stat-grid` rules in comfort.css, and `Pick` is `manual-order.tsx`'s
 * two-button toggle for the same reason — a copy, not an import.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import {
  CartesianGrid, Legend, Line, LineChart, ReferenceLine, ResponsiveContainer,
  Tooltip, XAxis, YAxis,
} from 'recharts'
import { useTheme } from '@astryxdesign/core/theme'
import { VStack, HStack, Layout, LayoutContent, LayoutFooter } from '@astryxdesign/core/Layout'
import { Dialog, DialogHeader } from '@astryxdesign/core/Dialog'
import { Text, Heading } from '@astryxdesign/core/Text'
import { Badge } from '@astryxdesign/core/Badge'
import { Button } from '@astryxdesign/core/Button'
import { Card } from '@astryxdesign/core/Card'
import { Banner } from '@astryxdesign/core/Banner'
import { Collapsible } from '@astryxdesign/core/Collapsible'
import { List, ListItem } from '@astryxdesign/core/List'
import { NumberInput } from '@astryxdesign/core/NumberInput'
import {
  api, explain, inr, inrCompact, money, sign,
  type DeskMode, type PayoffPoint, type PayoffResponse, type PayoffSummary,
  type PayoffView, type ProposedLeg, type ReliefTriggers, type RepairMove, type RepairPlan,
  type RepairResponse, type WhatIfResponse,
} from './api.ts'
import { PayoffCurves, price } from './payoff-curves.tsx'
import { asOf, usePoll } from './shell.tsx'
import { Selector } from '@astryxdesign/core/Selector'
import {
  chainForPair, contractKey, pairKey, priceIsOperators, type HeldLeg,
} from './manual-order-plan.ts'
import { MARK_STALE_MS } from './entry-plan.ts'
import { formatContract } from './contract.ts'
import { VENUE, lotsOf, roundToStep } from './venue.ts'
import { useReauth } from './auth.tsx'
import { RepairApplyDialog } from './repair-apply.tsx'

/** See the header: this endpoint is expensive and its answer is not twitchy. */
const POLL_MS = 60_000

/**
 * WHETHER THE COCKPIT IS UNFOLDED, remembered across reloads.
 *
 * ONE KEY FOR EVERY BOOK, not one per tag, and that is the decision worth
 * writing down. "Do I want a full-screen chart under my tiles" is a preference
 * about the SCREEN, set once and expected to hold: a per-tag key would open the
 * panel on the book you last used it on and close it on the next tab along,
 * which reads as a toggle that does not stick rather than as a memory. It also
 * grows one localStorage entry per book forever, on a desk that opens a new tag
 * every expiry.
 *
 * It sits in the `desk.` namespace with the theme (`shell.tsx`) and the
 * paper/live switch (`mode.tsx`), which are the other two things this dashboard
 * remembers about how you like to look at it.
 *
 * DEFAULT CLOSED. Anything unreadable is closed too — a stray value must not
 * mount a polling chart nobody asked for.
 */
const OPEN_KEY = 'desk.payoff.open'

/** The persisted fold state, and the one place it is written. */
function usePanelOpen(): [boolean, (open: boolean) => void] {
  const [open, setOpen] = useState<boolean>(
    () => window.localStorage.getItem(OPEN_KEY) === '1',
  )
  const set = useCallback((next: boolean) => {
    window.localStorage.setItem(OPEN_KEY, next ? '1' : '0')
    setOpen(next)
  }, [])
  return [open, set]
}

/**
 * Plans rendered per goal. The engine's own `topN` is 3 and it is the server
 * that decides; this is the same defensive cap the CLI applies, so a bridge
 * that loosened the dial cannot turn one screen into forty cards.
 */
const PLANS_SHOWN = 3

/** The do-nothing row's one line. Its `moves` are empty by construction. */
const BASELINE_LINE = 'do nothing — the baseline every plan is scored against'

// ------------------------------------------------------------------ figures

/** A 0–1 fraction as a percentage, or an em dash. `0.6412` → `64.12%`. */
function pct(n: number | null | undefined, digits = 2): string {
  return typeof n === 'number' && Number.isFinite(n) ? `${(n * 100).toFixed(digits)}%` : '—'
}

/**
 * A figure that IS ALREADY A PERCENTAGE — `profitableWidthPct` is served 0–100,
 * not 0–1. Passing it through `pct` above would print `6,250.00%` for a plan
 * that finishes green over 62.5% of the scan, which is why the two live side by
 * side with names that say which is which.
 */
function alreadyPct(n: number | null | undefined, digits = 1): string {
  return typeof n === 'number' && Number.isFinite(n) ? `${n.toFixed(digits)}%` : '—'
}

/**
 * A PLAN's breakevens — where carrying it to expiry finishes flat.
 *
 * THE PRICES A PLAN IS ACTUALLY DEFENDED BETWEEN, and the spec's decision table
 * asks for them beside the credit and the floor for that reason: two plans with
 * the same floor and the same credit are not the same trade if one of them
 * breaks even ₹20 closer to the money.
 *
 * `PlanScore.breakevens` arrives ASCENDING with the absent sides ALREADY
 * DROPPED (`goals.ts`'s `runBreakevens` filters the nulls out of the
 * `{down, up}` pair), so the length is the whole story a card can honestly
 * tell: two is the pair, none is a run that never crosses zero — unbounded
 * safety, not missing data. ONE IS PRINTED WITHOUT A SIDE, deliberately: the
 * repair wire carries no future price to compare it against, and labelling a
 * lone crossing "down" when it is the upside one would name a level the desk
 * would defend from the wrong direction.
 */
function breakevensText(be: readonly number[] | null | undefined): string {
  const xs = (be ?? []).filter((n) => typeof n === 'number' && Number.isFinite(n))
  return xs.length === 0 ? '—' : xs.map((n) => price(n)).join(' / ')
}

/** A tri-state flag. `null` is UNKNOWN and must never read as `no`. */
function yesNo(v: boolean | null | undefined): string {
  return v === null || v === undefined ? '—' : v ? 'yes' : 'no'
}

/**
 * A STRIKE IS AN IDENTIFIER, NOT A SUM OF MONEY, so it carries no digit
 * grouping: `24750CE` is a contract anybody can look up and `24,750CE` is a
 * string that reads as a price with a suffix. Everything else on this desk goes
 * through `inr`; this deliberately does not.
 */
function strikeText(k: number): string {
  return typeof k === 'number' && Number.isFinite(k) ? String(Number(k.toFixed(2))) : '?'
}

/**
 * SIGNED SHARES AS LOTS, or as shares when they cannot honestly be lots.
 *
 * `lotSize` is 0 when the instrument master does not know the contract — the
 * repairer's own refusal to guess — and a size that is not a whole number of
 * lots is printed in shares rather than rounded into a lie: "0.4 lots" is not
 * an order anybody can place.
 */
function lotsText(qty: number, lotSize: number): string {
  const shares = Math.abs(typeof qty === 'number' && Number.isFinite(qty) ? qty : 0)
  if (!(lotSize > 0)) return `${inr(shares)} shares`
  const lots = lotsOf(shares, lotSize)
  if (!Number.isInteger(lots)) return `${inr(shares)} shares`
  return `${inr(lots)} lot${lots === 1 ? '' : 's'}`
}

/**
 * THE LEG A MOVE ADDRESSES, split into the contract and the machine's counter.
 *
 * `applyMoves` names a generated leg `shift:720CE` and suffixes it `#2`, `#3` …
 * when the book already holds that id (`moves.ts`), so a plan that re-strikes
 * twice onto one strike produces `TCS26AUG2380CE#2` — a uniqueness counter
 * welded onto a contract, in the middle of a row an operator reads down the
 * phone. The `#2` is not noise (it is WHICH of two identical legs), so it is
 * never deleted; it is separated, so the contract half can be named.
 *
 * AND THE CONTRACT HALF IS NAMED, not printed as the exchange packs it — the
 * `formatContract` rule every other cell on this desk obeys, applied at the
 * last moment. `BHEL26AUG445CE` glues the strike, the one number being scanned
 * for, between a year and an option type. Anything the formatter does not
 * recognise comes back verbatim, which is what makes this safe over an id the
 * repairer invented rather than an exchange symbol.
 *
 * `null` for a move that addresses no leg — an `add`, a `hedge`, or a move this
 * dashboard cannot read at all.
 */
function legParts(move: RepairMove): { name: string; note: string | null } | null {
  if (move === null || typeof move !== 'object') return null
  if (move.op !== 'shift' && move.op !== 'close') return null
  const id = typeof move.legId === 'string' ? move.legId : ''
  const cut = /#\d+$/.exec(id)
  return cut === null
    ? { name: formatContract(id), note: null }
    : { name: formatContract(id.slice(0, cut.index)), note: cut[0] }
}

/**
 * ONE MOVE AS A SENTENCE, given the leg id already rendered the way the caller
 * wants it — the shared half of `moveText` and `moveLine` below, which differ
 * only in whether the `#2` rides inside the line or beside it.
 *
 * THE SIGN IS THE SIDE, ALWAYS. `add` and `hedge` are the operator's two words
 * for the same operation and `applyMoves` reads only `qty`; taking the op as
 * the side is what turns a long wing into a short one on the screen.
 *
 * AND NO PRICE IS PRINTED. `RepairMove` carries none — the CLI recovers one
 * arithmetically for single-move plans, and a price on this screen is a number
 * an operator would take to the broker as a limit. A fill nobody quoted is not
 * that number.
 */
function moveSentence(move: RepairMove, lotSize: number, leg: string): string {
  if (move === null || typeof move !== 'object') return 'an unreadable move'
  if (move.op === 'add' || move.op === 'hedge') {
    // Through the formatter for the same reason the leg ids are: a strike and a
    // type is what an exchange packing REDUCES to, so a bare `720CE` comes back
    // as itself and a fuller symbol would come back named.
    return `${move.qty < 0 ? 'Sell' : 'Buy'} ${lotsText(move.qty, lotSize)} ` +
      `${formatContract(`${strikeText(move.strike)}${move.type}`)}`
  }
  if (move.op === 'shift') return `Shift ${leg} → ${formatContract(strikeText(move.toStrike))}`
  if (move.op === 'close') return `Close ${leg}`
  return 'an unrecognised move'
}

/**
 * ONE MOVE AS A SENTENCE an operator could read down the phone, WHOLE — the
 * disambiguator welded back on, immediately after the contract it disambiguates.
 *
 * This is what the aria-labels and the dropped-move sentences use: a control an
 * assistive reader addresses, or a warning naming a leg to go and find, must
 * not be ambiguous about which of two identical legs it means. `planKey` does
 * NOT use it — see `moveKey`: identity must not move when display does.
 */
function moveText(move: RepairMove, lotSize: number): string {
  const leg = legParts(move)
  return moveSentence(move, lotSize, leg === null ? '' : `${leg.name}${leg.note ?? ''}`)
}

/**
 * ONE MOVE AS THE LINE A CARD PRINTS — the sentence, and the disambiguator
 * pulled out of it, so the `#2` can be rendered muted beside the line rather
 * than inside the contract.
 */
function moveLine(move: RepairMove, lotSize: number): { text: string; note: string | null } {
  const leg = legParts(move)
  return { text: moveSentence(move, lotSize, leg?.name ?? ''), note: leg?.note ?? null }
}

/**
 * ONE MOVE AS AN IDENTITY, not a sentence — the id half of `planKey`.
 *
 * Deliberately not `moveText`: that one is rendered, so it is allowed to change
 * its wording, and it collapses shares into lots (two sizes that round to the
 * same lot count would key identically). This is exact and it is not read.
 */
function moveKey(move: RepairMove): string {
  if (move === null || typeof move !== 'object') return '?'
  if (move.op === 'add' || move.op === 'hedge') return `${move.op}:${move.strike}${move.type}:${move.qty}`
  if (move.op === 'shift') return `shift:${move.legId}>${move.toStrike}`
  if (move.op === 'close') return `close:${move.legId}`
  return '?'
}

/**
 * WHAT A PLAN IS, NOT WHERE IT SAT — the key everything per-plan hangs off.
 *
 * It was `goal#index`, which is a POSITION. Press "Search again" on a book that
 * has moved and the engine's first REDUCE-LOSS plan is a different trade — and
 * the previous plan's verified BROKER MARGIN, plus its "loaded into the
 * overlay" claim, stayed under it. A margin figure attached to the wrong moves
 * is the one number on this panel somebody would size a real order against.
 *
 * The goal stays in the key because the same moves genuinely appear under two
 * goals and each card is verified on its own.
 */
function planKey(goal: string, plan: RepairPlan): string {
  const moves = plan.moves ?? []
  // The baseline's move list is empty by construction, so it needs a name of
  // its own rather than an empty string every goal would share.
  return `${goal}#${moves.length === 0 ? 'baseline' : moves.map(moveKey).join(',')}`
}

/** A proposed leg as the same sentence, plus its fill assumption if it has one. */
function legText(leg: ProposedLeg, lotSize: number): string {
  const head = `${leg.qty < 0 ? 'Sell' : 'Buy'} ${lotsText(leg.qty, lotSize)} ${strikeText(leg.strike)}${leg.type}`
  return leg.price === undefined ? head : `${head} at ${price(leg.price)}`
}

/** One row of the proposal list: the summed leg, and every index it came from. */
interface LegRow {
  readonly key: string
  /** The same contract, at the TOTAL size of the presses that made it. */
  readonly leg: ProposedLeg
  readonly at: readonly number[]
}

/**
 * THE PROPOSAL, AS ROWS RATHER THAN AS PRESSES.
 *
 * Four presses of "Add leg" on one contract is one proposal at four lots, and
 * the wire is sent all four — this only changes what is DRAWN, never what is
 * posted. Summing is safe because the sum is exactly what the server does with
 * them (`applyMoves` folds each into the same book).
 *
 * THE SIDE IS PART OF THE KEY, and it is not redundant with the size: a buy and
 * a sell of the same contract are two rows that would net to a smaller position
 * — or to nothing — and a row reading `Buy 0 lots` for a proposal that holds two
 * real legs is worse than two honest rows. The FILL is part of it too: "sell one
 * at 0.60" and "sell one at the chain" are two different questions, and merging
 * them would print one of the two prices over both.
 */
function aggregate(legs: readonly ProposedLeg[]): LegRow[] {
  const rows = new Map<string, { leg: ProposedLeg; at: number[] }>()
  for (const [i, leg] of legs.entries()) {
    const key = `${leg.strike}|${leg.type}|${leg.qty < 0 ? 'S' : 'B'}|${leg.price ?? ''}`
    const hit = rows.get(key)
    if (hit === undefined) rows.set(key, { leg, at: [i] })
    else {
      hit.leg = { ...hit.leg, qty: hit.leg.qty + leg.qty }
      hit.at.push(i)
    }
  }
  return [...rows.entries()].map(([key, r]) => ({ key, leg: r.leg, at: r.at }))
}

/**
 * ONE CELL of a divided card — label, optional qualifier on the label line, and
 * one figure. Deliberately the same shape as `StatCell` on the page above, so
 * the panel reads as part of that page rather than as a widget bolted onto it;
 * it is a copy rather than an import because this module is a leaf (see the
 * file header).
 */
function Figure(props: {
  label: string
  labelNote?: string | undefined
  value: string
  tone?: number | null
  /** The full sentence behind a short label or a dash, on hover. */
  title?: string | undefined
}): React.ReactElement {
  return (
    <VStack gap={0}>
      <HStack gap={2} align="center" wrap="wrap">
        <Text size="sm" color="secondary">{props.label}</Text>
        {props.labelNote === undefined ? null : (
          /* A raw span for the tooltip: astryx omits `title` from its props on
             purpose, so the attribute goes on an element of our own. */
          <span {...(props.title === undefined ? {} : { title: props.title })}>
            <Text size="xsm" color="secondary">{props.labelNote}</Text>
          </span>
        )}
      </HStack>
      <Text
        size="lg"
        weight="bold"
        style={props.tone === undefined || props.tone === null ? undefined : sign(props.tone)}
      >
        {props.value}
      </Text>
    </VStack>
  )
}

// ------------------------------------------------------------- machine mind

/**
 * WHAT THE BOT IS ABOUT TO DO ABOUT THIS BOOK, in its own words.
 *
 * The notes are rendered VERBATIM: `packages/payoff/src/machine.ts` writes them
 * to be read as they are, each one naming the numbers it was computed from and
 * the caveat it cannot see past (the under-one-lot floor, the no-fresh-sells
 * gate). Re-wording them here would be this dashboard second-guessing the
 * playbook it is reporting.
 */
function MachineMind(props: { machine: ReliefTriggers | null | undefined }): React.ReactElement {
  const m = props.machine
  /*
    ABSENT AND NULL ARE THE SAME ANSWER HERE, and the `undefined` half is not
    theoretical: the types describe the CURRENT bridge, a running process can be
    a deploy behind, and `undefined.deltaImbalance` throws during render — which
    unmounts the whole book page for a card that had nothing to say. The same
    rule `api.ts` states about reading `legs` off an older response.
  */
  if (m === null || m === undefined) {
    return (
      <Text color="secondary" size="sm">
        The machine card could not be read for this book — its dials are unknown, so nothing here
        can say what the strategy would do with it.
      </Text>
    )
  }
  /*
    `?? null` FOLDS "OLDER BRIDGE, FIELD ABSENT" ONTO "COULD NOT BE READ" — the
    same degrade `pages.tsx` applies to a missing realised figure. Both are
    unknowns and both must render as a dash; what must never happen is an
    absent field reading as a `no` or a `0`.
  */
  const notes = sentences(m.notes)
  const imbalance = m.deltaImbalance ?? null
  const marginFrac = m.marginFrac ?? null
  const shiftEnabled = m.shiftEnabled ?? null
  const targetPnl = m.targetPnl ?? null
  const side =
    imbalance === null || imbalance === 0
      ? undefined
      : imbalance > 0 ? 'would shed by selling CE' : 'would shed by selling PE'
  return (
    <VStack gap={3}>
      <Card padding={0}>
        <div className="stat-grid">
          <Figure
            label="Delta tolerance"
            labelNote="of MOVE, not of delta"
            title={
              'delta_tol_pct is the distance the book\'s zero-delta point may sit from spot, as a ' +
              'fraction of spot — the rule holds while the peak of the P&L curve is inside it.'
            }
            value={pct(m.deltaTolPct)}
          />
          <Figure label="Delta imbalance" labelNote={side} value={pct(imbalance)} />
          <Figure label="Would rebalance" value={yesNo(m.wouldRebalance)} />
          <Figure
            label="Margin gate"
            value={shiftEnabled === null ? '—' : shiftEnabled ? 'open' : 'shut'}
            title={
              'Phase 1 shifts a deep-ITM short out beyond ATM. The gate is a fraction of the ' +
              'book\'s margin cap; an unknown margin is an unknown gate, never a shut one.'
            }
          />
          {/*
            A CELL OF ITS OWN, NOT A NOTE THAT VANISHES.

            `marginFrac` rode on the gate's label line and simply disappeared
            when it was null — so "the gate is open and I could not read the
            fraction" and "the gate is open" rendered identically, and the
            second reads as a figure nobody thought worth printing. An unknown
            is an em dash, in a labelled place where its absence is visible:
            the same rule the gate above it already obeys.
          */}
          <Figure label="Margin used" labelNote="of the cap" value={pct(marginFrac, 1)} />
          <Figure
            label="Flatten target"
            value={targetPnl === null ? 'none set' : money(targetPnl)}
            {...(targetPnl === null ? {} : { tone: targetPnl })}
          />
        </div>
      </Card>
      {notes.length === 0 ? null : (
        <List density="compact">
          {notes.map((n) => (
            /* A ReactNode label rather than a string: astryx truncates a plain
               string to one line, and these are whole sentences. */
            <ListItem key={n} label={<Text size="sm">{n}</Text>} />
          ))}
        </List>
      )}
    </VStack>
  )
}

/**
 * THE MACHINE CARD, BEHIND ITS OWN DISCLOSURE — closed until asked for.
 *
 * It is a peek at one book's DIALS: the tolerance, the imbalance, whether the
 * margin gate is open. That is a question somebody asks a few times a session,
 * usually right after the bot has done something surprising — and it was
 * sitting open at the bottom of the panel as six tiles and a paragraph of notes
 * for every book, every time, which is most of a screen spent on an answer
 * nobody had asked for.
 *
 * ITS BODY IS UNMOUNTED WHEN CLOSED, like the panel's own. Nothing in here
 * polls, so that costs nothing to keep — but a `display: none` card is still in
 * the document, still found by "search this page", and still read out by a
 * screen reader walking the DOM. Closed should mean closed.
 *
 * NOT PERSISTED, and that is the difference between this and the panel's fold.
 * The panel's row is a standing preference about how much screen the cockpit
 * gets; this is a question you ask of one book, on one occasion, and answering
 * it does not mean you want it answered on every book you open afterwards.
 */
function MachineSection(props: { machine: ReliefTriggers | null | undefined }): React.ReactElement {
  const [open, setOpen] = useState(false)
  return (
    <Collapsible
      isOpen={open}
      onOpenChange={setOpen}
      trigger={<Text size="lg" weight="medium">Machine mind</Text>}
    >
      {open ? <MachineMind machine={props.machine} /> : null}
    </Collapsible>
  )
}

// ----------------------------------------------------------- the what-if

/**
 * A two-value toggle drawn as two buttons — the picked one is solid.
 *
 * A COPY OF `manual-order.tsx`'s `Toggle`, deliberately, for the reason the
 * file header gives about `Figure`: this module is a leaf, and importing a
 * control out of the order dialog would make a panel that places nothing
 * depend on the module that does. Two buttons rather than a Selector because
 * both options are always visible — CE or PE, buy or sell, is a choice a
 * reader must be able to see the state of without opening anything.
 */
function Pick<T extends string>(props: {
  label: string
  options: readonly T[]
  value: T
  onChange: (v: T) => void
}): React.ReactElement {
  return (
    <VStack gap={1}>
      <Text size="sm" color="secondary">{props.label}</Text>
      <HStack gap={1}>
        {props.options.map((o) => (
          <Button
            key={o}
            size="sm"
            variant={props.value === o ? 'primary' : 'secondary'}
            label={o}
            onClick={() => props.onChange(o)}
          />
        ))}
      </HStack>
    </VStack>
  )
}

/**
 * THE LEG EDITOR — one contract at a time, appended to a proposal the panel
 * then prices as a whole.
 *
 * THE ONLY ARITHMETIC HERE IS `lots × lotSize`, AND IT IS THE DANGEROUS KIND.
 * The wire wants SIGNED SHARES: a 1-lot sell of a 1,000-share contract is
 * `-1000`, and the same intent sent as `1` is a long, as `-1` is a single
 * share. So the side is a toggle that only ever decides the SIGN, and the size
 * is multiplied by the chain's own lot size — never by a number typed here.
 *
 * AND WHEN THE LOT SIZE IS UNKNOWN THE FIELD CHANGES ITS NAME. `lotSize` is 0
 * until a repair search has answered (that is the response that carries it),
 * and 0 is the instrument master's refusal to guess, not a small number. A box
 * labelled "Lots" over an unknown lot size would send whatever was typed as
 * shares while the operator read it as lots; labelled "Shares", the same
 * arithmetic is the truth.
 */
function WhatIfEditor(props: {
  lotSize: number
  /** The book, for the leg dialog's chain and positions reads. */
  tag: string
  mode: DeskMode
  symbol: string
  expiry: string
  proposed: readonly ProposedLeg[]
  busy: boolean
  onAdd: (leg: ProposedLeg) => void
  /** Every index of one aggregated row. See `aggregate`. */
  onRemove: (indices: readonly number[]) => void
  onClear: () => void
}): React.ReactElement {
  /*
    THE FORM LIVES IN A DIALOG NOW, the same shape as the manual-order one: the
    inline five-field row earned its keep while a proposal was being typed and
    sat as dead chrome the rest of the session — which on this panel is nearly
    always. The row here is what a proposal IS (the chips and their curve); how
    one is ADDED opens on demand. The dialog also brings the manual-order
    dialog's one genuinely better idea with it: the chain is read while it is
    open, so the fill price arrives pre-filled from the live quote instead of
    as an empty box and a caveat.
  */
  const [adding, setAdding] = useState(false)

  /*
    THE CHAIN IS READ HERE, not in the dialog, for one reason: the LOT SIZE.
    The dials only know it after a repair search, but the instrument master has
    always known it and the chain endpoint serves it — so the first time the
    dialog opens, the editor learns it and KEEPS it (`knownLot`, reset when the
    book changes), and the proposal chips can say "1 lot" instead of "1,125
    shares" without anyone having pressed "Suggest repairs". The poll itself
    still runs only while the dialog is open — the manual-order gate.
  */
  const pair = pairKey(props.symbol, props.expiry)
  const { data: chainRead } = usePoll(
    () =>
      adding && props.symbol !== '' && props.expiry !== ''
        ? api.chain(props.symbol, props.expiry).then((c) => ({ pair, chain: c }))
        : Promise.resolve(null),
    LEG_CHAIN_POLL_MS,
    [adding, pair],
  )
  const chain = chainForPair(chainRead, pair)
  const [knownLot, setKnownLot] = useState(0)
  useEffect(() => { setKnownLot(0) }, [pair])
  useEffect(() => {
    const fromChain = chain?.lotSize ?? 0
    if (fromChain > 0) setKnownLot(fromChain)
  }, [chain])
  /** The dials' answer wins (it is the book's own), the master's fills in. */
  const lotSize = props.lotSize > 0 ? props.lotSize : knownLot

  return (
    <VStack gap={2}>
      <Heading level={4}>What if</Heading>
      <Text size="sm" color="secondary">
        Legs nobody has placed, priced against this same chain and folded into the curves above.
        Nothing here is an order.
      </Text>
      <HStack gap={2} wrap="wrap" align="center">
        <Button
          size="sm"
          variant="primary"
          label="Add leg"
          isLoading={props.busy}
          isDisabled={props.busy}
          onClick={() => setAdding(true)}
        />
        <Button
          size="sm"
          variant="secondary"
          label="Clear"
          isDisabled={props.proposed.length === 0}
          onClick={props.onClear}
        />
      </HStack>
      <WhatIfLegDialog
        open={adding}
        tag={props.tag}
        mode={props.mode}
        chain={chain}
        chainLoading={adding && props.symbol !== '' && chain === null}
        lotSize={lotSize}
        proposed={props.proposed}
        busy={props.busy}
        onAdd={props.onAdd}
        onClose={() => setAdding(false)}
      />
      {/*
        THE PROPOSAL, ACROSS THE ROW AND SUMMED — not a tall left-hugging list
        of near-identical sentences.

        Pressing "Add leg" four times is how an operator sizes a proposal up,
        and it produced four rows reading `Sell 1 lot 2500CE at 0.60` down the
        left of an otherwise empty half-screen. What is actually being proposed
        is one contract at four lots, and that is the number the curve beside it
        was drawn from — so the rows are aggregated and print the TOTAL, with a
        `×4` saying how many presses it took. The wire is untouched: the panel
        still posts every leg it was given, which is what keeps a summed row
        honest about a proposal made of two different fill assumptions (they key
        apart, and stay two rows).
      */}
      {props.proposed.length === 0 ? null : (
        <HStack gap={4} wrap="wrap" align="center">
          {aggregate(props.proposed).map((row) => {
            const said = legText(row.leg, lotSize)
            return (
              <HStack key={row.key} gap={1} align="center">
                <Text size="sm">{said}</Text>
                {row.at.length === 1 ? null : (
                  <Badge variant="neutral" label={`×${row.at.length}`} />
                )}
                <Button
                  size="sm"
                  variant="ghost"
                  label="Remove"
                  /*
                    THE WHOLE ROW GOES, and the accessible name says the summed
                    size so it cannot be read as "remove one of these". Popping
                    a single increment off a row that only ever shows its total
                    is the more surprising of the two: the figure on screen
                    would change to a number nobody typed.
                  */
                  aria-label={`Remove ${said}`}
                  isDisabled={props.busy}
                  onClick={() => props.onRemove(row.at)}
                />
              </HStack>
            )
          })}
        </HStack>
      )}
    </VStack>
  )
}

/** The manual-order dialog's cadence, for the same chain on the same screen. */
const LEG_CHAIN_POLL_MS = 4000
/** The manual-order dialog's own book cadence, for the net line. */
const LEG_BOOK_POLL_MS = 5000

/**
 * The add-a-leg dialog — the manual-order dialog's shape, without the order.
 *
 * WHAT IT BORROWS is the price: while it is open it polls the book's own chain
 * (`api.chain`, the read the place-order dialog makes) and pre-fills the fill
 * price from the picked contract's quote via the SAME `prefillPrice` — sell
 * suggests what a seller would ask, a stale or missing quote leaves the box
 * empty and says why, and a price the operator has typed FOR THIS CONTRACT is
 * never overwritten (`contractKey` discipline, verbatim from manual-order).
 *
 * WHAT IT REFUSES TO BORROW is the strike picker. The strike stays a free
 * number ON PURPOSE: a repair plan can name an off-chain strike and a picker
 * built from the chain's rows could not express one. The chain answers next to
 * it instead — the row's CE/PE marks when the strike is on the chain, and an
 * honest "not on this chain" when it is not (such a leg prices at mark, or is
 * dropped and named by the bridge).
 *
 * State survives a close, the FlattenDialog discipline the manual-order dialog
 * cites: reopening to add the second half of a spread starts from the first
 * half's fields, not from zero.
 */
function WhatIfLegDialog(props: {
  open: boolean
  tag: string
  mode: DeskMode
  /** The chain the editor reads while this is open — rows, marks, lot size. */
  chain: Awaited<ReturnType<typeof api.chain>> | null
  chainLoading: boolean
  lotSize: number
  proposed: readonly ProposedLeg[]
  busy: boolean
  onAdd: (leg: ProposedLeg) => void
  onClose: () => void
}): React.ReactElement {
  const [strike, setStrike] = useState(0)
  const [type, setType] = useState<'CE' | 'PE'>('CE')
  const [side, setSide] = useState<'Buy' | 'Sell'>('Buy')
  const [size, setSize] = useState(1)
  const [fill, setFill] = useState<number | null>(null)
  /** The contract the operator typed a price for — see manual-order-plan. */
  const [typedFor, setTypedFor] = useState<string | null>(null)
  /** Why the price box is empty (stale/no quote), said beside it. */
  const [priceNote, setPriceNote] = useState('')

  const rows = [...(props.chain?.rows ?? [])].sort((a, b) => a.strike - b.strike)
  const row = strike > 0 ? rows.find((r) => r.strike === strike) : undefined
  const quote = row === undefined ? undefined : type === 'CE' ? row.CE : row.PE

  /*
    WHAT THE BOOK HOLDS, for the net line — the manual-order dialog's own read,
    tagged and matched the same way (`usePoll` keeps its last payload across a
    deps change, and the previous book's legs under this book's title would
    answer "what am I net?" about a position that is not on screen).
  */
  const bookKey = `${props.tag}|${props.mode}`
  const { data: bookRead } = usePoll(
    () =>
      props.open && props.tag !== ''
        ? api
            .positions(props.tag, props.mode)
            // A reply with no legs list is "unread", never "holds nothing".
            .then((res) => ({
              pair: bookKey,
              chain: Array.isArray(res.legs) ? (res.legs as readonly HeldLeg[]) : null,
            }))
        : Promise.resolve(null),
    LEG_BOOK_POLL_MS,
    [props.open, bookKey],
  )
  const heldLegs = chainForPair(bookRead, bookKey)

  /*
    THE MARK, NOT A MARKETABLE LIMIT. `prefillPrice` pads the quote by a 2%
    buffer because its box is about to be sent to an exchange; this box is
    asking "what if I get filled at X", and the honest suggestion for X is the
    chain's own mark — the exact number a BLANK box would price at, made
    visible and editable. Same discipline otherwise: re-fill on strike / type
    and on the first quote arriving, never on the 4s poll itself, and never
    once the operator has typed FOR THIS CONTRACT; a stale quote (60s, the
    manual-order rule) leaves the box empty and says why.
  */
  const priceDirty = priceIsOperators(typedFor, String(strike), type)
  const hasQuote = quote !== undefined && quote !== null
  useEffect(() => {
    if (priceDirty) return
    if (quote === null || quote === undefined) {
      setFill(null)
      setPriceNote('')
      return
    }
    /*
      A TWO-SIDED BOOK BEATS A STALE PRINT. On an illiquid wing the last trade
      is a memory (409s old on TCS 1820PE, the report that built this) while
      the bid/ask is the market — so when the tick carried both sides, the box
      fills with their MID and the note prints the pair it came from, aged
      honestly when the tick itself is old. Only an LTP-only quote keeps the
      60s refusal: a lone stale print really is too little to price from.
    */
    const bid = quote.bid ?? null
    const ask = quote.ask ?? null
    const age = `${Math.round(quote.ageMs / 1000)}s`
    if (bid !== null && ask !== null) {
      setFill(Math.round(((bid + ask) / 2) * 100) / 100)
      setPriceNote(
        `mid of ${bid.toFixed(2)} / ${ask.toFixed(2)}` +
        (quote.ageMs > MARK_STALE_MS ? ` — book ${age} old` : ''),
      )
      return
    }
    if (quote.ageMs > MARK_STALE_MS) {
      setFill(null)
      setPriceNote(`last trade ${age} ago — too stale to pre-fill`)
      return
    }
    setFill(Math.round(quote.price * 100) / 100)
    setPriceNote('the chain\u2019s mark — edit to assume your fill')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [strike, type, hasQuote])

  const sized = props.lotSize > 0
  // `lots × lotSize` snapped onto the lot grid: 3 × 0.05 is 0.15000000000000002.
  const qty = (sized ? roundToStep(size * props.lotSize, props.lotSize) : size) * (side === 'Sell' ? -1 : 1)
  // WHY the button is off, rather than a button that is merely grey.
  const problem =
    !(strike > 0)
      ? 'Pick a strike first.'
      : !(size > 0)
        ? `The ${sized ? 'lots' : 'shares'} must be more than none.`
        : null

  const net = netByType(heldLegs, props.proposed, props.lotSize)

  return (
    <Dialog isOpen={props.open} onOpenChange={props.onClose} purpose="form" width={560}>
      <Layout
        header={<DialogHeader title="What-if leg" onOpenChange={props.onClose} />}
        content={
          <LayoutContent>
            <VStack gap={4}>
              <Text size="sm" color="secondary">
                Priced against the book&apos;s own chain and folded into the curves. Nothing here
                is an order.
              </Text>
              {/*
                PICKED, NOT TYPED, when the chain answers — the manual-order
                dialog's own field, marks in the row. The free number box comes
                back only when the chain itself could not be read: a repair plan
                can still name an off-chain wing, but it arrives via "Load into
                overlay", not by typing it here.
              */}
              {props.chain !== null && rows.length === 0 ? (
                <NumberInput
                  label="Strike"
                  value={strike}
                  onChange={setStrike}
                  min={0}
                  width={160}
                  description="the chain gave no strikes — type one; it prices at mark or is dropped and named"
                />
              ) : (
                <Selector
                  label="Strike"
                  hasSearch
                  searchPlaceholder="Filter strikes…"
                  isLoading={props.chainLoading}
                  options={rows.map((r) => ({
                    value: String(r.strike),
                    label: `${r.strike} · CE ${markOf(r.CE)} · PE ${markOf(r.PE)}`,
                  }))}
                  value={strike > 0 ? String(strike) : ''}
                  placeholder="Choose a strike…"
                  onChange={(v) => setStrike(Number(v))}
                />
              )}
              <HStack gap={4} wrap="wrap">
                <Pick label="Type" options={['CE', 'PE'] as const} value={type} onChange={setType} />
                <Pick label="Side" options={['Buy', 'Sell'] as const} value={side} onChange={setSide} />
              </HStack>
              <HStack gap={3} wrap="wrap" align="start">
                <NumberInput
                  label={sized ? 'Lots' : 'Shares'}
                  value={size}
                  onChange={setSize}
                  min={0}
                  // Lots are whole contracts on every venue; a raw quantity is
                  // whole only on NSE — on DX it is BTC on a 0.001 grid.
                  isIntegerOnly={sized || VENUE.qtyStep >= 1}
                  {...(sized || VENUE.qtyStep >= 1 ? {} : { step: VENUE.qtyStep })}
                  width={150}
                  description={
                    sized
                      ? `1 lot = ${inr(props.lotSize)} shares`
                      : 'shares — lot size unknown until a repair search'
                  }
                />
                <NumberInput
                  label="Fill price"
                  value={fill}
                  onChange={(v) => {
                    setFill(v)
                    setTypedFor(contractKey(String(strike), type))
                  }}
                  hasClear
                  min={0}
                  step={VENUE.defaultTick}
                  width={170}
                  description={priceNote !== '' ? priceNote : 'blank = mark at the chain'}
                />
              </HStack>
              {/*
                WHAT THE WHOLE POSITION NETS TO — book plus the proposal already
                on the list (not the leg being typed: it has not been added).
                The number an operator is actually steering with a wing is this
                one, and it was previously only derivable by leaving the dialog.
              */}
              {net === null ? null : (
                <Text size="sm" color="secondary">
                  {`Net with proposal — CE ${net.ce} · PE ${net.pe}`}
                </Text>
              )}
            </VStack>
          </LayoutContent>
        }
        footer={
          <LayoutFooter hasDivider>
            <HStack gap={2} justify="end" align="center" wrap="wrap">
              {problem === null ? null : <Text size="sm" color="secondary">{problem}</Text>}
              {/* "Done", not "Close": the header's X is already named Close. */}
              <Button variant="secondary" label="Done" onClick={props.onClose} />
              <Button
                variant="primary"
                label="Add to proposal"
                isLoading={props.busy}
                isDisabled={props.busy || problem !== null}
                onClick={() => {
                  props.onAdd({
                    strike,
                    type,
                    qty,
                    ...(fill !== null && fill > 0 ? { price: fill } : {}),
                  })
                }}
              />
            </HStack>
          </LayoutFooter>
        }
      />
    </Dialog>
  )
}

/** `78.55`, or a dash — the mark beside a strike in the picker's own rows. */
function markOf(q: { price: number } | null | undefined): string {
  return q === null || q === undefined ? '—' : q.price.toFixed(2)
}

/**
 * The whole position's net per option type — held book plus the proposal on
 * the list — in LOTS when the lot size is known, shares otherwise. `null`
 * until the book has actually been read: a net line computed from the proposal
 * alone would print "CE flat" over a book that is short four lots of them.
 */
function netByType(
  held: readonly HeldLeg[] | null,
  proposed: readonly ProposedLeg[],
  lotSize: number,
): { ce: string; pe: string } | null {
  if (held === null) return null
  const shares = { CE: 0, PE: 0 }
  for (const leg of held) {
    const symbol = leg.instrument?.tradingsymbol ?? ''
    const t = symbol.endsWith('CE') ? 'CE' : symbol.endsWith('PE') ? 'PE' : null
    if (t === null || !Number.isFinite(leg.qty)) continue
    shares[t] += leg.qty
  }
  for (const leg of proposed) {
    if (!Number.isFinite(leg.qty)) continue
    shares[leg.type] += leg.qty
  }
  const say = (n: number): string => {
    if (n === 0) return 'flat'
    const word = n < 0 ? 'sell' : 'buy'
    if (lotSize > 0) {
      const lots = lotsOf(Math.abs(n), lotSize)
      const whole = Number.isInteger(lots) ? String(lots) : lots.toFixed(2)
      return `${word} ${whole} ${lots === 1 ? 'lot' : 'lots'}`
    }
    return `${word} ${inr(Math.abs(n))} shares`
  }
  return { ce: say(shares.CE), pe: say(shares.PE) }
}

/**
 * THE BOOK, AND THE BOOK WITH THE PROPOSAL IN IT — the two figures a proposal
 * is actually judged on, side by side.
 *
 * `current` IS NULLABLE and null means the book as it stands could not be
 * priced at all. Rendered as ₹0 that reads "this book cannot lose money", next
 * to an "if placed" figure that is real — which would make the whole comparison
 * argue for placing something. It is a dash, and the reason is said in words.
 *
 * ── AND THE PROPOSAL'S OWN SENTENCES LIVE HERE, NOT ONLY AT THE BOTTOM ──────
 *
 * `applyMoves` DROPS a leg the chain cannot price — an off-chain strike, a wing
 * with no print — and says so. The proposal row above still lists that leg, so
 * the pair reads as "this trade changes nothing" when the truth is "this trade
 * is not in these numbers". The panel's own "What to distrust" list carries the
 * sentence, several screens down, under a heading about the payoff; the
 * contradiction is HERE, so the sentence is here too.
 *
 * ONLY THE PROPOSAL'S OWN. The combined envelope repeats every book-level
 * warning the payoff already carries (`assemble` runs again for the POST), and
 * echoing those here would bury the one sentence this block exists to show. The
 * baseline is subtracted, which is exactly the set the what-if itself added.
 */
function BeforeAfter(props: {
  whatif: WhatIfResponse
}): React.ReactElement {
  const now: PayoffSummary | null = props.whatif.current ?? null
  const after = props.whatif.combined?.view?.summary
  /*
    THE BRIDGE'S OWN LIST, never a set-difference: subtracting the last poll's
    warnings misattributed any book-level sentence that appeared since — a feed
    dying between the poll and this POST — to the proposal beside these figures.
  */
  const own = sentences(props.whatif.dropped)
  return (
    <VStack gap={2} role="group" aria-label="The proposal, before and after">
      <Card padding={0}>
        <div className="stat-grid">
          <Figure
            label="Floor now"
            value={now === null ? '—' : money(now.floor)}
            tone={now?.floor ?? null}
          />
          <Figure
            label="Floor if placed"
            value={money(after?.floor)}
            tone={after?.floor ?? null}
          />
          <Figure
            label="Max loss now"
            {...(now === null ? {} : { labelNote: `at ${price(now.maxLossAt)}` })}
            value={now === null ? '—' : money(now.maxLoss)}
            tone={now?.maxLoss ?? null}
          />
          <Figure
            label="Max loss if placed"
            {...(after === undefined ? {} : { labelNote: `at ${price(after.maxLossAt)}` })}
            value={money(after?.maxLoss)}
            tone={after?.maxLoss ?? null}
          />
        </div>
      </Card>
      {now !== null ? null : (
        <Text size="sm" color="secondary">
          This book could not be priced as it stands, so there is nothing to compare the proposal
          against — only the &ldquo;if placed&rdquo; figures below mean anything.
        </Text>
      )}
      {own.length === 0 ? null : (
        <VStack gap={1}>
          <Text size="sm" weight="medium">What the bridge said about this proposal</Text>
          <List density="compact">
            {own.map((w) => (
              <ListItem key={w} label={<Text size="sm" color="secondary">{w}</Text>} />
            ))}
          </List>
        </VStack>
      )}
      {/*
        BOTH COLUMNS COME FROM ONE ANSWER, and that answer is a MOMENT, while
        the three curves above it keep refreshing on their own cadence. The
        fourth line is resampled onto the fresh grid so it stays registered, but
        the numbers in it are the chain as it was when the proposal was priced —
        said out loud rather than left for a reader to assume otherwise.
      */}
      <Text size="xsm" color="secondary">
        Both columns are one answer, priced when the proposal was submitted. The curves above keep
        refreshing; add or remove a leg to price it against the chain as it is now.
      </Text>
    </VStack>
  )
}

// ------------------------------------------------------------- the repairs

/**
 * `degrades-floor` IS THE ONE FLAG THAT CONTRADICTS THE FIGURES BESIDE IT — it
 * says the plan leaves the book worse off at the bottom than doing nothing
 * does, which is the opposite of what a repair menu is read for. The rest name
 * a state (`baseline`, `no-feasible-plan`) or a conflict with the bot's own
 * next move, and those are facts rather than warnings.
 */
function flagVariant(flag: string): 'warning' | 'neutral' {
  return flag === 'degrades-floor' ? 'warning' : 'neutral'
}

/**
 * WHY THIS PLAN'S APPLY IS OFF — or null when it is on.
 *
 * THE FOUR REFUSALS THIS SCREEN OWNS, and it owns exactly these because they
 * are properties of the PLAN and of the page, not of the book: no preflight
 * could tell an operator anything they do not already know about them, so
 * spending a round trip to arrive at "there was nothing to place" would be a
 * modal that opens in order to apologise. Everything else that can refuse — a
 * dropped move, a hold already on the tag, an open with no quote — is the
 * server's, is discovered by asking, and is said inside the modal in the
 * server's own words.
 *
 * `holdActive` IS DELIBERATELY NOT PRE-CHECKED HERE. It is a fact about the
 * desk that changes without this page hearing about it, and the modal's own
 * preflight is the only reading of it that is current.
 *
 * THE MODAL-ALREADY-OPEN CASE IS LAST, so a row that could never be applied
 * keeps saying its own reason rather than borrowing the transient one.
 */
function applyOffReason(plan: RepairPlan, lotSize: number, modalOpen: boolean): string | null {
  const moves = plan.moves ?? []
  if (moves.length === 0) {
    return 'this row places nothing — it is the do-nothing baseline every other plan is scored against'
  }
  /*
    A SIZE THAT IS NOT A WHOLE NUMBER OF LOTS IS NOT AN ORDER. `lotSize` is 0
    when the instrument master does not know the contract — the repairer's own
    refusal to guess — and the card is then printing SHARES, which is not the
    unit anything downstream of this button counts in.
  */
  if (!(lotSize > 0)) {
    return 'the lot size for this contract is unknown, so the sizes on this card are shares rather ' +
      'than orders — nothing here can be sent'
  }
  if ((plan.flags ?? []).includes('no-feasible-plan')) {
    return 'the search met this goal with nothing: this is the least-bad row rather than a repair, ' +
      'and it is here to be read'
  }
  if (modalOpen) {
    return 'an apply is already open — one plan at a time, because the desk claims one repair run ' +
      'per book'
  }
  return null
}

/**
 * ONE PLAN, its arithmetic, and the two things a human can do with it.
 *
 * A CARD PER PLAN rather than a table row, against this repo's "dense data is
 * rows" rule and knowingly: these are not twelve records of one kind, they are
 * twelve PROPOSALS, each carrying a multi-line move list, its own badges and
 * its own two buttons. A table of that is a table with a paragraph in every
 * cell.
 *
 * IT IS A `group` NAMED BY ITS LEAD MOVE, so a screen reader (and the suite)
 * can tell "the 720CE plan" from the eleven cards around it. The name is the
 * plan's own first sentence, which is also what the buttons' accessible names
 * carry — "Apply" twelve times over is a control nobody can address.
 */
function PlanCard(props: {
  plan: RepairPlan
  lotSize: number
  /** False when there is no curve to overlay — see the panel. */
  canOverlay: boolean
  /**
   * A proposal is being priced. `preview` refuses a call made over one still in
   * flight (half-applying it would list a leg the curve does not include), so
   * the button goes off for that moment rather than reading as a dead one.
   */
  overlayBusy: boolean
  /**
   * Whether THIS plan is the one currently in the overlay, and how much of it
   * got there. The chart is a long way up the page on a book with twelve cards,
   * so a press whose only visible effect is off-screen reads as a dead button.
   */
  loaded: 'full' | 'partial' | 'none' | null
  /**
   * WHY APPLY IS OFF, or null when it is on — one nullable REASON rather than a
   * `canApply` flag beside a separate title, because the two would be free to
   * disagree and the disagreement would be invisible. It rides on the button as
   * its tooltip: a control that is merely grey teaches people to click harder,
   * which is the same rule the apply modal states about its own Place button.
   */
  applyOff: string | null
  onLoad: () => void
  onApply: () => void
}): React.ReactElement {
  const moves = props.plan.moves ?? []
  const lines = moves.length === 0
    ? [{ text: BASELINE_LINE, note: null }]
    : moves.map((m) => moveLine(m, props.lotSize))
  const lead = moves.length === 0 ? BASELINE_LINE : moveText(moves[0] as RepairMove, props.lotSize)
  // Only the first letter is lowered: "sell 1 lot 720ce" would rename the
  // contract, and the contract is the part of this sentence that is an id.
  const named = `${lead.charAt(0).toLowerCase()}${lead.slice(1)}`
  const s = props.plan.score
  const flags = (props.plan.flags ?? []).filter((f) => typeof f === 'string' && f !== '')
  return (
    <Card padding={2} role="group" aria-label={`Plan: ${lead}`}>
      <VStack gap={2}>
        {/*
          THE MOVES ARE THE CONTEXT AND THE FIGURES ARE THE HEADLINE, so the
          moves are a tight stack of one-line sentences rather than the
          `List`/`ListItem` rows they were: those carry a row's worth of padding
          and a divider apiece, which on a two-move roll was taller than the
          numbers underneath it. Beside each, muted, the `#2` that says WHICH of
          two identical legs — see `moveLine`.
        */}
        <VStack gap={0}>
          {lines.map((l, i) => (
            <HStack key={`${i}|${l.text}`} gap={1} align="center" wrap="wrap">
              <Text size="sm" {...(i === 0 ? { weight: 'medium' as const } : {})}>{l.text}</Text>
              {l.note === null ? null : (
                <Text size="xsm" color="secondary">{l.note}</Text>
              )}
            </HStack>
          ))}
        </VStack>
        {/*
          THE FLAGS SIT WITH THE TITLE, not below the numbers: `degrades-floor`
          contradicts the floor figure two lines down, and a reader who has
          already read the figure has finished with the card.
        */}
        {flags.length === 0 ? null : (
          <HStack gap={1} wrap="wrap">
            {flags.map((f) => <Badge key={f} variant={flagVariant(f)} label={f} />)}
          </HStack>
        )}
        {/*
          THE SCORE, IN THE HEADER TILES' OWN TREATMENT — small muted label,
          large tinted figure — over the same divided-cell rules, two columns
          wide (`.plan-stat-grid`). These six numbers ARE the card: they were an
          11px inline row that read as a footnote to the move list above them,
          which is exactly backwards for a menu whose whole job is "which of
          these three".
        */}
        <Card padding={0}>
          <div className="plan-stat-grid">
            <Figure label="credit" value={money(s?.credit)} tone={s?.credit ?? null} />
            {/*
              WHERE THE FLOOR IS is half of what the floor means, and the panel
              above already prints it beside its own max-loss figures. A −₹61,000
              at 400.50 on a book marked at 445 is a shock away; the same number at
              443 is the next tick. Omitted rather than dashed when the score is
              unreadable — a bare "at —" is noise on a card that is already saying
              nothing.
            */}
            <Figure
              label="floor"
              {...(typeof s?.maxLossAt === 'number' && Number.isFinite(s.maxLossAt)
                ? { labelNote: `at ${price(s.maxLossAt)}` }
                : {})}
              value={money(s?.maxLoss)}
              tone={s?.maxLoss ?? null}
            />
            <Figure
              label="worst shock"
              {...(typeof s?.worstShockAt === 'number' && Number.isFinite(s.worstShockAt)
                ? { labelNote: `at ${price(s.worstShockAt)}` }
                : {})}
              value={money(s?.worstShock)}
              tone={s?.worstShock ?? null}
            />
            {/*
              THE TINT IS INVERTED HERE, ALONE ON THIS SCREEN, and it is the
              honest reading: every other figure in this row is money and more of
              it is better, while margin is capital the plan CONSUMES. A `+34,000`
              in the desk's profit-green would say a plan that locks up another
              ₹34k is doing you a favour.
            */}
            <Figure
              label="margin Δ"
              value={money(s?.marginDelta)}
              tone={s?.marginDelta === undefined ? null : -s.marginDelta}
            />
            {/*
              WIDTH IS THE RANKING NUMBER FOR PROFITABLE-BY-EXPIRY AND NOTHING
              ELSE (`goals.ts` ranks that goal on `[profitableWidthPct, pop]`), so
              without it that whole section reads as mis-sorted: its first plan
              routinely shows a worse credit, floor, shock AND margin than its
              second. Printed for all four goals, because a score row that changes
              its columns per section is harder to read than one wide one.
            */}
            <Figure label="width" value={alreadyPct(s?.profitableWidthPct)} />
            {/*
              A CELL, BUT A QUIET ONE. These are PRICES on the underlying in a
              block of rupee P&Ls, so they take the same slot as the rest — the
              grid stays 2x3 and nothing hangs off the bottom — at the smaller
              type the secondary line always had. The width above says how MUCH
              of the ladder finishes green; this says BETWEEN WHAT.
            */}
            <VStack gap={0}>
              <Text size="sm" color="secondary">breakevens</Text>
              <Text size="sm" weight="medium">{breakevensText(s?.breakevens)}</Text>
            </VStack>
          </div>
        </Card>
        <HStack gap={1} wrap="wrap">
          <Button
            size="sm"
            variant="secondary"
            label="Load into overlay"
            aria-label={`Load into overlay: ${named}`}
            isDisabled={!props.canOverlay || props.overlayBusy}
            onClick={props.onLoad}
          />
          {/*
            THE ONE BUTTON ON THIS PANEL THAT ENDS IN REAL ORDERS — and it ends
            in a MODAL, which is where the preview, the drops, the margin the
            book would then need and the operator's password all live. Primary
            on both rails: `mode` is the page's, the modal restates it in its
            header and its own Place button is the destructive-tinted one.
          */}
          <Button
            size="sm"
            variant="primary"
            label="Apply"
            aria-label={`Apply: ${named}`}
            isDisabled={props.applyOff !== null}
            {...(props.applyOff === null ? {} : { tooltip: props.applyOff })}
            onClick={props.onApply}
          />
        </HStack>
        {props.loaded === null ? null : (
          <Text size="sm" color="secondary">
            {props.loaded === 'full'
              ? 'Loaded into the what-if overlay above.'
              : props.loaded === 'partial'
                ? 'Partly loaded — the note under the chart names the moves the bridge could not apply.'
                : 'Nothing here could be loaded into the overlay — the note under the chart says why.'}
          </Text>
        )}
      </VStack>
    </Card>
  )
}

/**
 * THE MENU — four goals, ranked plans, and the do-nothing row they are scored
 * against. It appears on a press and never on a timer (see the file header).
 *
 * A GOAL THE SEARCH SERVED NOTHING FOR IS RENDERED EMPTY, not omitted: the
 * route appends every missing goal on purpose, because a section that is simply
 * absent reads as one that was never searched, and "nothing helps here" is the
 * answer an operator most needs to be able to see.
 */
function Repairs(props: {
  res: RepairResponse | null
  error: string | null
  busy: boolean
  canOverlay: boolean
  /** A proposal is being priced; every Load waits on it. See `PlanCard`. */
  overlayBusy: boolean
  /** An apply modal is up. Every card's Apply waits — see `applyOffReason`. */
  applyOpen: boolean
  /** Which plan is in the overlay, by key — null when none is. */
  loaded: string | null
  /**
   * How much of it got there, read off the bridge's own answer. Null while the
   * pricing is still in flight: nothing is claimed about a curve not yet drawn.
   */
  loadedKind: 'full' | 'partial' | 'none' | null
  onSearch: () => void
  onLoad: (key: string, plan: RepairPlan) => void
  /** The goal rides along: it is the modal's title and its re-auth statement. */
  onApply: (key: string, plan: RepairPlan, goal: string) => void
}): React.ReactElement {
  const res = props.res
  const lotSize = res?.dials?.lotSize ?? 0
  const universe = res?.universe
  return (
    <VStack gap={3}>
      <HStack justify="between" align="center" wrap="wrap" gap={2}>
        <Heading level={4}>Repairs</Heading>
        <Button
          size="sm"
          variant="secondary"
          /* THE LABEL IS THE ACTION, NOT THE STATE: `isLoading` already draws
             the spinner and sets `aria-busy`, and a control that renames itself
             mid-press is one a reader has to re-find. It DOES change once an
             answer is in — asking again is a different sentence from asking. */
          label={res === null ? 'Suggest repairs' : 'Search again'}
          isLoading={props.busy}
          onClick={props.onSearch}
        />
      </HStack>
      {/*
        THE PLACEMENT SENTENCE. It used to say "Nothing here places an order",
        which was true until Apply existed and is the worst kind of stale copy:
        a standing denial beside a button that does place them, on the line an
        operator reads to decide how carefully to read the rest of the screen.
        What replaced it names the RAIL (the Manual Order dialog's — the same
        `SubmitService`) and the ORDER OF THE GATES, because that is what a
        reader actually needs before pressing anything on this panel.

        One string rather than JSX prose, so the spacing is exactly what it
        reads as and cannot drift with the indentation around it.
      */}
      <Text size="sm" color="secondary">
        {'Apply places a plan’s orders through the same rail as the Manual Order dialog — a ' +
          'preview first, the operator password on a live book, closes before opens. Each search ' +
          'prices hundreds of candidate books, so it runs when you ask for it and never on a timer.'}
      </Text>

      {props.error === null ? null : (
        <Banner
          status="error"
          title="The repair menu could not be read"
          description={`${props.error}${
            res === null ? '' : ' — every plan below is the last menu that arrived.'
          }`}
        />
      )}

      {res === null ? null : res.error !== undefined && res.error !== '' ? (
        <Banner status="info" title="There is no book to repair" description={res.error} />
      ) : (
        <VStack gap={3}>
          {/*
            HOW BIG THE ALPHABET WAS, so a menu that came back thin can be told
            from one that came back thin BECAUSE the chain was — and the lot
            size, because it is what every "1 lot" below means and what the
            what-if editor sizes against.
          */}
          <Text size="sm" color="secondary">
            {`lot size ${lotSize > 0 ? inr(lotSize) : 'unknown'}  ·  ${inr(universe?.atomic ?? 0)} single ` +
              `moves over ${inr(universe?.evaluated ?? 0)} quotable contracts`}
          </Text>
          {(res.goals ?? []).map((entry) => {
            const plans = (entry.plans ?? []).slice(0, PLANS_SHOWN)
            /** Per goal group, for the duplicate-key guard below. */
            const used = new Map<string, number>()
            return (
              <VStack key={entry.goal} gap={2}>
                <Heading level={5}>{entry.goal}</Heading>
                {plans.length === 0 ? (
                  <Text size="sm" color="secondary">
                    no plan found — the chain offered nothing this goal could use
                  </Text>
                ) : (
                  /* THREE ABREAST on a desk monitor, one per plan, wrapping
                     down to two and then one. See `.plan-grid` — the count is
                     exact rather than fitted, because `PLANS_SHOWN` caps a goal
                     at three and the engine's own `topN` is three. */
                  <div className="plan-grid">
                  {plans.map((plan) => {
                    /*
                      CONTENT-ADDRESSED — see `planKey`. Two plans in one goal
                      cannot legitimately carry the same moves (`goals.ts`
                      dedupes on the resulting book), and the suffix is here so
                      that a bridge which one day serves a repeat cannot make
                      two cards share one card's load echo.
                    */
                    const base = planKey(entry.goal, plan)
                    const seen = (used.get(base) ?? 0) + 1
                    used.set(base, seen)
                    const key = seen === 1 ? base : `${base}~${seen}`
                    return (
                      <PlanCard
                        key={key}
                        plan={plan}
                        lotSize={lotSize}
                        canOverlay={props.canOverlay}
                        overlayBusy={props.overlayBusy}
                        loaded={props.loaded === key ? props.loadedKind : null}
                        applyOff={applyOffReason(plan, lotSize, props.applyOpen)}
                        onLoad={() => props.onLoad(key, plan)}
                        onApply={() => props.onApply(key, plan, entry.goal)}
                      />
                    )
                  })}
                  </div>
                )}
              </VStack>
            )
          })}
        </VStack>
      )}
    </VStack>
  )
}

// -------------------------------------------------------------------- panel

/**
 * Every non-empty sentence in these lists, in order, without repeats.
 *
 * TWO CALLERS, ONE RULE. The warnings need it because the bridge serves two
 * channels that can legitimately carry the same sentence, and the machine notes
 * need it because they are RENDERED AS KEYED LIST ITEMS: `machine.ts` composes
 * its notes from independent branches, two of which can phrase a hold
 * identically, and React collides the keys when they do — an item silently
 * disappears or re-orders. Deduping is also the right READING: the same
 * sentence said twice is not emphasis.
 */
function sentences(...lists: readonly (readonly string[] | undefined)[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const list of lists) {
    for (const w of list ?? []) {
      if (typeof w !== 'string' || w === '' || seen.has(w)) continue
      seen.add(w)
      out.push(w)
    }
  }
  return out
}

/** `BHEL 2026-08-27 · future 445.00 · as of 12s ago`, skipping what is absent. */
function subtitleOf(res: PayoffResponse | null, updatedAt: number | null): string {
  const parts: (string | undefined)[] = [
    /* TYPE-CHECKED, NOT JUST EMPTY-CHECKED: `undefined !== ''` is true, so a
       bridge that omits `symbol`/`expiry` used to head this panel with the
       literal text "undefined undefined". */
    res === null
      ? undefined
      : [res.symbol, res.expiry].filter((v): v is string => typeof v === 'string' && v !== '').join(' '),
    // `?? null` first, so an older bridge that omits the field is the same
    // "not printing" as one that sends an explicit null — never `future —`.
    (res?.future ?? null) === null ? undefined : `future ${price(res?.future)}`,
    (res?.spot ?? null) === null ? undefined : `spot ${price(res?.spot)}`,
    asOf(updatedAt),
    /*
      THE ONE SENTENCE THAT REPLACED EIGHT. Closed, the bridge prices off the
      last session and prunes the clock-noise caveats (feed silent, greeks and
      margin aged since the bell) — this label is where that honesty lives now,
      so it must not be dropped without putting the warnings back. `=== true`
      because an older bridge omits the field entirely.
    */
    res?.marketClosed === true ? 'market closed — last session’s prices' : undefined,
  ]
  return parts.filter((s): s is string => s !== undefined && s !== '').join('  ·  ')
}

/**
 * THE ROW — the whole cockpit folded into one line, and the only thing on the
 * book page when nobody has asked for the curve.
 *
 * IT OWNS NO DATA AND MAKES NO REQUEST. The body below is what polls, and it is
 * mounted only while the row is open, so folding the panel really does stop the
 * minute-by-minute chain solve rather than merely hiding its output. `usePoll`
 * has no paused mode and should not grow one for this: an unmounted subtree is
 * a stronger guarantee than a flag, and it takes the chart's `ResizeObserver`
 * and every recharts re-render with it.
 *
 * WHAT IT KEEPS IS THE TEASER. The body hands its last summary up as it
 * arrives; the row prints the floor and the breakeven band from it so a folded
 * panel still answers the two questions somebody would unfold it to ask. Before
 * the first answer there is nothing to say and it says nothing — a teaser of
 * dashes claims the panel has been read and found empty.
 *
 * The teaser is dropped when the BOOK changes, because it is a fact about one
 * book and the row would otherwise quote the last book's floor under the new
 * one's tab until the first poll lands.
 */
export function PayoffPanel(props: { tag: string; mode: DeskMode }): React.ReactElement {
  const [open, setOpen] = usePanelOpen()
  const [teaser, setTeaser] = useState<PayoffSummary | null>(null)
  const bookOf = `${props.tag}|${props.mode}`
  useEffect(() => {
    setTeaser(null)
  }, [bookOf])

  return (
    <Card padding={3}>
      <Collapsible
        isOpen={open}
        onOpenChange={setOpen}
        trigger={
          <HStack gap={3} align="center" wrap="wrap">
            <Heading level={3}>Payoff &amp; repair</Heading>
            {teaser === null ? null : (
              <Text size="sm" color="secondary">
                {`floor ${money(teaser.floor)}  ·  breakeven ${bandText(teaser.breakevens)}`}
              </Text>
            )}
          </HStack>
        }
      >
        {open ? <PayoffBody tag={props.tag} mode={props.mode} onSummary={setTeaser} /> : null}
      </Collapsible>
    </Card>
  )
}

/**
 * `421.40 – 452.75`, or the one side there is, or a dash.
 *
 * NULL IS UNBOUNDED, NOT ZERO — the book never crosses zero on that side — so a
 * one-sided band prints the side it has and says nothing about the other. The
 * full pair is what the row exists to show; the teaser is not the place to
 * explain a half of one, and the tiles inside label both sides properly.
 */
function bandText(be: PayoffSummary['breakevens'] | undefined): string {
  const down = be?.down ?? null
  const up = be?.up ?? null
  if (down === null && up === null) return '—'
  if (down === null) return `up to ${price(up)}`
  if (up === null) return `from ${price(down)}`
  return `${price(down)} – ${price(up)}`
}

function PayoffBody(props: {
  tag: string
  mode: DeskMode
  /** The last summary this body saw, for the folded row above it. */
  onSummary: (summary: PayoffSummary | null) => void
}): React.ReactElement {
  /**
   * 60s — see the header. `usePoll` keeps the last payload when a read fails
   * ("stale-but-labelled beats empty"), which is why the age rides in the
   * subtitle: a curve that stopped being confirmed at 11:04 must not look live.
   */
  const { data: res, error, updatedAt } = usePoll<PayoffResponse | null>(
    () => (props.tag === '' ? Promise.resolve(null) : api.payoff(props.tag, props.mode)),
    POLL_MS, [props.tag, props.mode],
  )

  // ---- the what-if overlay ------------------------------------------------
  const [proposed, setProposed] = useState<readonly ProposedLeg[]>([])
  const [overlay, setOverlay] = useState<WhatIfResponse | null>(null)
  const [overlayError, setOverlayError] = useState<string | null>(null)
  const [overlayBusy, setOverlayBusy] = useState(false)
  /**
   * Which plan the overlay currently holds, echoed back into its own card. The
   * key plus HOW MANY MOVES WERE SENT — never how many arrived: what got there
   * is the bridge's answer to say, and it is read off the response's `dropped`
   * below rather than guessed at press time. The count is what lets "some
   * dropped" and "ALL dropped" be told apart, and the second must not draw the
   * unchanged book under "if placed".
   */
  const [loaded, setLoaded] = useState<{ readonly key: string; readonly sent: number } | null>(null)

  // ---- the repair menu ----------------------------------------------------
  const [repair, setRepair] = useState<RepairResponse | null>(null)
  const [repairError, setRepairError] = useState<string | null>(null)
  const [repairBusy, setRepairBusy] = useState(false)
  /**
   * THE PLAN AN APPLY MODAL IS OPEN OVER, and everything the modal needs that
   * would otherwise move under it.
   *
   * `legsPrint` IS CAPTURED AT PRESS TIME rather than read live off `repair`.
   * It is the fingerprint of the legs THIS CARD's sentences address, and a
   * "Search again" behind an open modal would otherwise swap it — re-preflighting
   * an operator's open preview against a menu they never saw. The plan object
   * is captured for the same reason: the card it came from may no longer exist.
   */
  const [applying, setApplying] = useState<
    { key: string; plan: RepairPlan; goal: string; legsPrint: string } | null
  >(null)

  /**
   * THE PAGE'S OWN RE-AUTH PROMPT, the same one the Manual Order dialog above
   * this panel is given. The apply modal TAKES a `Reauth`, it does not make
   * one — the prompt has to be mounted on the page, once, beside the dialogs
   * that raise it — so this is where it is made and `reauth.dialog` at the
   * bottom of this body is where it is rendered.
   */
  const reauth = useReauth()

  /**
   * THE TWO SINGLE-FLIGHT LATCHES, HELD IN REFS AND NOT IN THE STATE BESIDE
   * THEM. A second click inside the same React batch reads the state as it was
   * when the render happened — still `false` — so a busy FLAG cannot stop it,
   * and `isDisabled` on the button cannot either: the re-render that would
   * disable it has not run yet. A ref is written synchronously inside the
   * handler and is the only thing already true.
   */
  const previewing = useRef(false)
  const searching = useRef(false)
  /**
   * WHICH PROPOSAL A PRICING ANSWER BELONGS TO. Clearing the overlay costs no
   * request, so it can happen while one is still in flight — and without this
   * that answer would land afterwards and put the fourth line back on a chart
   * for a proposal the operator has already taken off.
   */
  const previewGen = useRef(0)

  /**
   * WHICH BOOK THIS STATE BELONGS TO — the FlattenDialog discipline. Everything
   * above is earned against one (tag, mode) and none of it is re-fetched when
   * the tab changes, so it is all dropped, and a read still in flight for the
   * old book is dropped when it lands rather than painting the new one's panel
   * with the old one's numbers.
   */
  const bookKey = `${props.tag}|${props.mode}`
  const bookRef = useRef(bookKey)
  useEffect(() => {
    bookRef.current = bookKey
    previewing.current = false
    searching.current = false
    setProposed([])
    setOverlay(null)
    setOverlayError(null)
    setOverlayBusy(false)
    setLoaded(null)
    setRepair(null)
    setRepairError(null)
    setRepairBusy(false)
    /*
      THE MODAL GOES WITH THE BOOK IT WAS OPENED ON. A repair preview left
      standing over a different tag is the one thing on this panel that would
      end in orders on the wrong book — and its `decisionId` is minted per open,
      so a fresh open on the new tab is a fresh claim rather than the old one
      re-aimed. Any run it started continues at the desk regardless; the modal
      says so on its own Close button.
    */
    setApplying(null)
  }, [bookKey])

  /**
   * Price whatever the overlay is currently being asked about, whoever asked.
   *
   * ONE OVERLAY, ONE AUTHOR. `listed` is what the leg editor shows — the manual
   * proposal — and it is EMPTY for a plan load, because a plan is not a list of
   * contracts the editor could have typed (that was the whole defect: a plan of
   * closes has no contracts at all). So adding a leg after loading a plan
   * starts a fresh proposal and the plan's curve goes, rather than the two
   * quietly merging into a book neither of them describes.
   *
   * A CALL MADE OVER ONE STILL IN FLIGHT CHANGES NOTHING AT ALL — not even the
   * listed proposal. Half-applying it would leave a leg on the list that the
   * curve beside it does not include, which is the one thing this overlay must
   * never show.
   */
  const ask = (
    listed: readonly ProposedLeg[],
    request: (() => Promise<WhatIfResponse>) | null,
  ): void => {
    if (request === null) {
      previewGen.current += 1
      setProposed([])
      setOverlay(null)
      setOverlayError(null)
      return
    }
    if (previewing.current) return
    const gen = (previewGen.current += 1)
    previewing.current = true
    setProposed(listed)
    setOverlayBusy(true)
    const mine = bookRef.current
    const mineAnd = (): boolean => bookRef.current === mine && previewGen.current === gen
    void request()
      .then((answer) => {
        if (!mineAnd()) return
        setOverlay(answer)
        setOverlayError(null)
      })
      .catch((err: unknown) => {
        if (!mineAnd()) return
        setOverlay(null)
        setOverlayError(explain(err))
        /*
          A TRANSPORT FAILURE IS NOT THE PLAN'S FAULT. `loaded` left standing
          over a null overlay would print the card's "nothing here could be
          loaded" sentence — blaming the plan for a bridge that was down — while
          the error banner above already owns the true story.
        */
        setLoaded(null)
      })
      .finally(() => {
        /*
          THE LATCH IS RELEASED ONLY BY THE BOOK THAT ARMED IT. Switching tabs
          clears it in the reset effect and the new book can arm its own; an
          answer for the OLD book arriving after that would otherwise unlatch a
          request still running for the new one.
        */
        if (bookRef.current !== mine) return
        previewing.current = false
        setOverlayBusy(false)
      })
  }

  /** The leg editor's proposal. An empty one is a CLEAR, and never a POST. */
  const preview = (legs: readonly ProposedLeg[]): void => {
    ask(legs, legs.length === 0 ? null : () => api.payoffWhatif(props.tag, props.mode, legs))
  }

  const clearOverlay = (): void => {
    setLoaded(null)
    preview([])
  }

  const searchRepairs = (): void => {
    if (searching.current) return
    searching.current = true
    setRepairBusy(true)
    const mine = bookRef.current
    void api
      .repair(props.tag, props.mode)
      .then((answer) => {
        if (bookRef.current !== mine) return
        setRepair(answer)
        setRepairError(null)
      })
      .catch((err: unknown) => {
        if (bookRef.current !== mine) return
        /* THE LAST MENU IS KEPT, labelled — the same "stale-but-labelled beats
           empty" rule the poll above obeys. A blip on "Search again" must not
           take away the plans somebody is in the middle of reading. */
        setRepairError(explain(err))
      })
      .finally(() => {
        // Same rule as `preview` — only the book that armed it may release it.
        if (bookRef.current !== mine) return
        searching.current = false
        setRepairBusy(false)
      })
  }

  /**
   * OPEN THE APPLY MODAL ON ONE PLAN — this handler makes no request at all.
   *
   * No latch and no ref: it sets state, and the state it sets is what turns
   * every OTHER card's Apply off (`applyOffReason`), so a second press inside
   * the same React batch would at worst re-open the modal on the same plan.
   * Everything that costs anything — the preflight, the margin read, the
   * orders — happens inside `RepairApplyDialog`, once, per open.
   */
  const applyPlan = (key: string, plan: RepairPlan, goal: string): void => {
    setApplying({ key, plan, goal, legsPrint: repair?.legsPrint ?? '' })
  }

  /**
   * A PLAN GOES OVER AS ITSELF — `moves`, verbatim: the same list the repairer
   * scored, the same list `/repair/preflight` resolves into orders, and the
   * same list `/repair/apply` re-resolves server-side before placing any of
   * them. One representation from search to fill, so a plan cannot mean one
   * thing on the chart and another at the broker.
   *
   * It used to be translated into what the leg editor can say: the `add`s
   * became a proposal and the `close`s and `shift`s were named as things that
   * "could not be loaded". A plan of pure closes therefore proposed NOTHING and
   * the panel drew the unchanged book under the label "if placed" — a flatten
   * previewing as "this repair changes nothing" (TCS, 2026-08-20). Everything
   * else it drew was strictly RISKIER than the plan, which is the one direction
   * of error a repair menu must never make.
   *
   * SO THERE IS NOTHING LEFT FOR THIS FUNCTION TO WARN ABOUT. What a bridge
   * could not apply, the bridge says, in the response's own warnings — and the
   * banner under the chart renders exactly those. A caveat written here would be
   * a guess about the server's answer made before it arrived.
   */
  const loadPlan = (key: string, plan: RepairPlan): void => {
    // Same rule as `preview`: over a pricing already in flight this does
    // nothing, rather than claiming a curve that never changed.
    if (previewing.current) return
    const moves = plan.moves ?? []
    /*
      THE DO-NOTHING BASELINE HAS NOTHING TO LOAD, and "loading" it must not
      claim otherwise: latching its key with no POST behind it would print the
      card's "nothing here could be loaded — the note under the chart says why"
      over a chart with no note anywhere. Pressing Load on it clears the
      overlay, which is the only thing an empty plan can honestly mean.
    */
    if (moves.length === 0) {
      clearOverlay()
      return
    }
    setLoaded({ key, sent: moves.length })
    ask([], () => api.payoffPlanWhatif(props.tag, props.mode, moves))
  }

  const view = res?.view ?? null
  const summary = view?.summary
  const be = summary?.breakevens
  /**
   * EVERY CHANNEL THIS COCKPIT HAS, in one list, deduped — the payoff envelope,
   * the view's own per-leg sentences, both of the what-if's, and the repair
   * menu's. `assemble` runs for all four endpoints and legitimately produces the
   * same book-level sentence on each, which is exactly what `sentences` folds.
   */
  const baseWarnings = sentences(res?.warnings, view?.warnings, repair?.warnings)
  const warnings = sentences(baseWarnings, overlay?.combined?.warnings, overlay?.warnings)
  /**
   * A VIEW WITH NO SCAN IS NOT A PAYOFF, and this is the guard that keeps the
   * "never render an unknown as 0" rule true on this panel.
   *
   * `buildPayoffView` answers a book it could not price with `emptyView` — a
   * complete, well-formed summary in which every figure is a literal 0 (no
   * legs, an unusable valuation date, a rate it refused). Rendered as tiles
   * that would read "Floor ₹0 · POP 0.00% · max loss ₹0", which is the sentence
   * "this book cannot lose money" printed over a book nothing could be computed
   * for. The engine says so in `warnings`; the figures are what must not be
   * shown, so the empty scan is the tell and the panel refuses the whole block.
   */
  const scan = view !== null && (view.curve ?? []).length > 0 ? view : null

  /**
   * THE SENTENCES THAT ARE ABOUT THE PROPOSAL AND NOTHING ELSE — the bridge's
   * own `dropped` list, which names exactly what THIS request could not read or
   * apply. It used to be a set-difference against the last poll's warnings,
   * which misattributed both ways: a book-level warning that appeared between
   * the poll and the POST (a feed dying takes about that long) landed on the
   * plan, and a genuine drop that happened to repeat a baseline sentence
   * vanished. Deduped here for display; the COUNT below uses the raw list.
   */
  const ownNotes = sentences(overlay?.dropped)

  /**
   * HOW MUCH OF THE LOADED PLAN IS ACTUALLY ON THE CHART — read off the answer,
   * never guessed at press time. Nothing is claimed while the pricing is still
   * in flight: an echo taken from the PREVIOUS plan's response would say the
   * wrong thing about this one for as long as the request takes. `dropped` is
   * counted RAW against the moves sent (two identical closes both dropped are
   * two drops, not one sentence): none dropped is the plan in full, all dropped
   * is NO plan at all — the combined curve the bridge still returns is the
   * unchanged book, and drawing it under "if placed" is the flatten-previews-
   * as-no-change misreading this panel exists to remove.
   */
  const loadedKind: 'full' | 'partial' | 'none' | null =
    loaded === null || overlayBusy || overlay === null
      ? null
      : (overlay.dropped?.length ?? 0) === 0
        ? 'full'
        : overlay.dropped.length >= loaded.sent ? 'none' : 'partial'

  /**
   * The summary the folded row above teases, as each answer lands — but ONLY
   * when what the row prints has changed. `usePoll` hands back a fresh object
   * per successful poll even for an identical payload, and forwarding it
   * verbatim re-rendered the PARENT — and with it this whole unfolded body,
   * recharts and every plan card — a second full time per tick, for a row that
   * reads two figures. The key below is exactly those figures.
   */
  const onSummary = props.onSummary
  const teaserSent = useRef('')
  useEffect(() => {
    /*
      The book rides in the key: the parent drops its teaser when the tab
      changes, so the first summary FOR THE NEW BOOK must always send — even if
      its floor happens to equal the old book's — and a late answer still
      carrying the old book's figures must not.
    */
    const s = scan?.summary ?? null
    const key = s === null
      ? bookKey
      : `${bookKey}|${s.floor}|${s.breakevens.down ?? 'x'}|${s.breakevens.up ?? 'x'}`
    if (key === teaserSent.current) return
    teaserSent.current = key
    onSummary(s)
  }, [onSummary, scan])

  return (
    <VStack gap={3}>
        <HStack justify="between" align="center" wrap="wrap" gap={2}>
          <Text size="sm" color="secondary">{subtitleOf(res, updatedAt)}</Text>
        </HStack>

        {error !== null ? (
          <Banner
            status="error"
            title="The payoff could not be read"
            description={`${error}${res === null ? '' : ' — everything below is the last answer that arrived.'}`}
          />
        ) : null}

        {res === null ? (
          <Text color="secondary" size="sm">Reading this book&apos;s payoff…</Text>
        ) : res.error !== undefined && res.error !== '' ? (
          /* A 200 that says there is no such book. Rendered as the sentence it
             is: the tag may have been renamed or the book deleted, and neither
             is a failure of this panel. */
          <Banner status="info" title="There is no book to price" description={res.error} />
        ) : scan === null ? (
          <Text color="secondary" size="sm">
            No payoff could be built for this book
            {warnings.length === 0
              ? ', and the bridge gave no reason for it.'
              : ' — see the warnings below.'}
          </Text>
        ) : (
          <VStack gap={3}>
            <PayoffCurves
              view={scan}
              /*
                A PLAN THE BRIDGE APPLIED NONE OF DRAWS NO LINE. Its combined
                curve is the unchanged book (every move dropped — a stale menu
                whose legs are gone), and under "Expiry, if placed" it would
                read as "this plan changes nothing". The banner below names the
                drops; the card says nothing was loaded; the chart must not
                contradict them both.
              */
              overlay={loadedKind === 'none' ? null : (overlay?.combined?.view?.curve ?? null)}
              markAt={res.future ?? res.spot}
              // `?? null` like its neighbours: an older bridge omitting the
              // field must read as "not printing", never label a cash-spot line
              // `future`. Unreachable today — with no future there is no view to
              // draw — and folded so that it stays unreachable.
              markLabel={(res.future ?? null) === null ? 'spot (the future is not printing)' : 'future'}
              expiryDate={res.expiry}
            />

            {/*
              DIRECTLY UNDER THE CURVE IT QUALIFIES, and that placement is the
              whole point of it. The fourth line IS the plan now — it is priced
              from the plan's own moves by the same function that scored it — so
              the only thing left that can make it something else is a move the
              BRIDGE dropped, and this is the bridge's own sentence for it,
              verbatim. A caveat nobody finds is a caveat that is not there, and
              this one used to sit below the ladder, screens from its line.

              ONLY FOR A LOADED PLAN. A hand-typed leg the chain cannot price
              contradicts the before/after PAIR — two identical columns under a
              proposal that lists a leg — and its sentence sits there, beside the
              figures it is about. See `BeforeAfter`.
            */}
            {loaded === null || ownNotes.length === 0 ? null : (
              <Banner
                status="warning"
                title={loadedKind === 'none'
                  ? 'This plan could not be loaded — the curve above is unchanged'
                  : 'Part of this plan is not in the curve above'}
                description={ownNotes.join(' ')}
              />
            )}

            {/*
              THE CAVEAT IS PART OF THE HEADING, not a footnote under it. Floor
              and max loss are read off the scan's own edge, and an operator
              sizing against an unqualified "floor" is sizing against a number
              that does not mean what it says.
            */}
            <Text size="sm" color="secondary">
              At expiry, realised P&amp;L included. Floor and max loss are the worst point over the
              ±10% scan — how bad a 10% move is, not how bad it can get.
            </Text>
            <Card padding={0}>
              <div className="stat-grid">
                <Figure label="Floor" value={money(summary?.floor)} tone={summary?.floor ?? null} />
                <Figure
                  label="Max profit"
                  value={money(summary?.maxProfit)}
                  tone={summary?.maxProfit ?? null}
                />
                <Figure
                  label="Max loss"
                  labelNote={summary === undefined ? undefined : `at ${price(summary.maxLossAt)}`}
                  value={money(summary?.maxLoss)}
                  tone={summary?.maxLoss ?? null}
                />
                {/*
                  RUN-LEVEL, and the note says so: these are the payoff engine's
                  exact kinks with ITS realised — scanned from the fill journal
                  — folded in. The header tiles now fold in the BRIDGE's
                  realised, so the two agree whenever the two bookkeepers do and
                  drift apart only when they disagree. Null is UNBOUNDED — the
                  book never crosses zero on that side — not "0".
                */}
                <Figure
                  label="Breakeven ↓"
                  labelNote="incl. booked"
                  title="The payoff engine's exact crossing, its journal-scanned realised P&L included — so it can drift from the header tile when the bridge books a different realised."
                  value={be?.down === null || be?.down === undefined ? '—' : price(be.down)}
                />
                <Figure
                  label="Breakeven ↑"
                  labelNote="incl. booked"
                  title="The payoff engine's exact crossing, its journal-scanned realised P&L included — so it can drift from the header tile when the bridge books a different realised."
                  value={be?.up === null || be?.up === undefined ? '—' : price(be.up)}
                />
                {/*
                  NAMED, because it is not the run's probability: it is computed
                  on the OPEN legs' unshifted expiry column, so a book carrying a
                  big realised profit has a POP that ignores it. An unlabelled
                  "POP" beside `Booked` reads as the run's, and it is not.
                */}
                <Figure label="POP (open legs)" value={pct(summary?.pop)} />
                <Figure
                  label="Net credit"
                  labelNote="open legs, at entry"
                  value={money(summary?.netCredit)}
                  tone={summary?.netCredit ?? null}
                />
                <Figure
                  label="Booked"
                  value={money(summary?.booked)}
                  tone={summary?.booked ?? null}
                />
                <Figure
                  label="Worst shock"
                  labelNote={
                    typeof summary?.worstShockAt === 'number' && Number.isFinite(summary.worstShockAt)
                      ? `±5 / ±10% today · at ${price(summary.worstShockAt)}`
                      : '±5 / ±10% today'
                  }
                  value={money(summary?.worstShock)}
                  tone={summary?.worstShock ?? null}
                />
                <Figure
                  label="Target"
                  value={
                    summary?.targetPnl === null || summary?.targetPnl === undefined
                      ? 'none set'
                      : money(summary.targetPnl)
                  }
                />
              </div>
            </Card>

            {/*
              THE OVERLAY LIVES UNDER THE CHART IT DRAWS ON, and only where
              there IS one: it is a fourth line on that plot, and an editor
              offered over a book nothing could be priced for would take a
              proposal nobody could see the effect of. The repair menu below is
              rendered either way — a book with no future still gets the honest
              "no plan, and here is why" answer.
            */}
            <WhatIfEditor
              lotSize={repair?.dials?.lotSize ?? 0}
              tag={props.tag}
              mode={props.mode}
              symbol={res.symbol ?? ''}
              expiry={res.expiry ?? ''}
              proposed={proposed}
              busy={overlayBusy}
              onAdd={(leg) => {
                // Appended, not replaced: a proposal is a basket, and the
                // panel prices the whole of it every time. Hand-editing it also
                // ends its claim to be a plan — the card's "loaded" line goes.
                setLoaded(null)
                preview([...proposed, leg])
              }}
              onRemove={(indices) => {
                setLoaded(null)
                // The whole aggregated row comes off at once — see the editor.
                const gone = new Set(indices)
                preview(proposed.filter((_, at) => !gone.has(at)))
              }}
              onClear={clearOverlay}
            />

            {overlayError !== null ? (
              <Banner
                status="error"
                title="The proposal could not be priced"
                description={overlayError}
              />
            ) : overlay === null ? null : (
              <BeforeAfter whatif={overlay} />
            )}
          </VStack>
        )}

        {/*
          THE MACHINE CARD SURVIVES A DEAD CHAIN — it needs no chain at all —
          but it does NOT precede the first answer: before one arrives there is
          no book to have a mind about, and "the machine card could not be read"
          under a loading panel is a failure claimed about nothing. It is also
          held back for a tag that names no book, where the banner above has
          already said the only true thing there is to say.
        */}
        {res === null || (res.error !== undefined && res.error !== '') ? null : (
          <Repairs
            res={repair}
            error={repairError}
            busy={repairBusy}
            /* A plan can only be loaded onto a curve that exists. */
            canOverlay={scan !== null}
            overlayBusy={overlayBusy}
            loaded={loaded?.key ?? null}
            loadedKind={loadedKind}
            applyOpen={applying !== null}
            onSearch={searchRepairs}
            onLoad={loadPlan}
            onApply={applyPlan}
          />
        )}

        {res === null || (res.error !== undefined && res.error !== '') ? null : (
          <MachineSection machine={res.machine} />
        )}

        {warnings.length === 0 ? null : (
          <VStack gap={2}>
            {/*
              EVERY QUALIFICATION THE BRIDGE MADE, both channels, in one place.
              A list rather than a banner apiece: a degraded book legitimately
              carries one sentence per leg plus the feed's and the margin's, and
              six stacked banners is a wall an operator learns to scroll past.
            */}
            <Heading level={4}>What to distrust</Heading>
            <List density="compact">
              {warnings.map((w) => (
                <ListItem key={w} label={<Text size="sm" color="secondary">{w}</Text>} />
              ))}
            </List>
          </VStack>
        )}

        {/*
          THE ONE SCREEN BETWEEN A CARD AND REAL ORDERS. Mounted only while a
          plan is being applied — the `FlattenDialog` discipline, taken one step
          further because every prop it needs (the moves, the goal, the card's
          fingerprint) belongs to ONE press: an unmounted dialog cannot render a
          run watched under one plan beneath the next one's title.

          `bookExpiry` is the BOOK's, from the payoff answer, and it is what
          lets an order row print its expiry only when it differs — a September
          wing on an August book is identical in every other column.
        */}
        {applying === null ? null : (
          <RepairApplyDialog
            key={applying.key}
            open
            tag={props.tag}
            mode={props.mode}
            bookExpiry={res?.expiry ?? ''}
            planLabel={applying.goal}
            planFlags={applying.plan.flags ?? []}
            moves={applying.plan.moves ?? []}
            legsPrint={applying.legsPrint}
            reauth={reauth}
            onClose={() => setApplying(null)}
          />
        )}
        {/* Once, at the page bottom, as everywhere — see `useReauth` above. */}
        {reauth.dialog}
    </VStack>
  )
}
