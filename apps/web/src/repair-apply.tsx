/**
 * THE APPLY MODAL — the one screen between a repair card and real orders.
 *
 * A plan card says "Shift TCS 2440 PE → 2260". The broker sees two orders, in a
 * fixed order, at sizes nobody typed, against a book that has been moving since
 * the menu was drawn. This modal is where that gap is closed: it asks the bridge
 * what it WOULD place (`/repair/preflight`, which writes nothing and reaches no
 * rail), renders every order, the margin the book would then need and where the
 * delta lands — and only then offers a button.
 *
 * ── FOUR THINGS HOLD THE BUTTON SHUT, AND EACH OF THEM IS THE SERVER'S ──────
 *
 * `dropped` (the apply route refuses any plan carrying one — a repair is a
 * SHAPE, and executing the half the bridge understood is how a book ends up
 * naked on the other half), `holdActive` (a repair still owns this tag — one
 * running, or one that has just finished and whose book is still being handed
 * back to the supervisor), an OPEN with no quote at all (the run would halt
 * there rather than price off a guess), and the preflight not having answered
 * yet. Every one of them is rendered as the sentence that says why, because a
 * button that is merely grey teaches people to click harder.
 *
 * THE DESK-WIDE KILL SWITCH IS NOT ONE OF THEM, deliberately. It refuses a plan
 * that OPENS anything and lets a pure-close plan through, which is a judgement
 * about the plan the server makes and this dialog does not restate — the
 * preflight's own warnings say it is engaged, and a Place pressed anyway comes
 * back as a refusal that placed nothing.
 *
 * ── THE `decisionId` IS MINTED ONCE PER PLAN, AND NEVER AGAIN FOR IT ────────
 *
 * It is the idempotency the apply route claims the run under: the same id
 * executes once however many times it is asked for. A refused attempt (409, an
 * `accepted: false`, a lost answer) PLACED NOTHING, so it is safe to re-send —
 * and re-minting it after one is the single mistake that endpoint cannot
 * protect anyone from, because two ids for one intent is two repairs.
 *
 * SO IT IS KEYED ON THE PLAN, NOT ON THE DIALOG. Held across every retry of the
 * plan on screen, and re-minted the moment the plan itself changes — a new
 * open, another tag or rail, or the parent pointing this same open dialog at a
 * different card. That last one is the dangerous half: the id, the refusal and
 * the run all belong to the plan, and one carried across a swap re-claims the
 * PREVIOUS plan's run on a tag and rail the server cannot tell apart.
 *
 * ── THE FINGERPRINT THAT GOES BACK IS THE PREFLIGHT'S, NOT THE CARD'S ───────
 *
 * `legsPrint` arrives from the card and is carried INTO the preflight — that is
 * what lets the bridge refuse a menu that has outlived its book. What goes back
 * OUT with the apply is the PREFLIGHT's own value: the question was asked with
 * the card's copy, and the answer is what the preview on screen was computed
 * against. `bookPrint` is deliberately NOT sent — it hashes every live quote, so
 * a guard keyed on it would refuse the Confirm of anyone who paused to read this
 * modal. A 409 means a LEG moved, which is a preview to redraw rather than a
 * code to report.
 *
 * ── ACCEPTED IS NOT DONE ────────────────────────────────────────────────────
 *
 * The apply answers 202 and the waves take minutes. The modal then polls the
 * run's ledger and renders what actually executed — including HALTED, which is
 * not a failure to hide but the record the rest gets finished by hand from. The
 * poll stops the moment the run leaves RUNNING, and closing the dialog does not
 * stop the run (the button says so).
 *
 * It imports no page, for the reason `payoff.tsx` gives about `pages.tsx`:
 * `payoff.tsx` mounts this, so importing anything back out of it would make the
 * two circular. `Score` and the em-dash formatters below are that file's shapes
 * copied, not imported.
 */

import { useEffect, useRef, useState } from 'react'
import { VStack, HStack, Layout, LayoutContent, LayoutFooter } from '@astryxdesign/core/Layout'
import { Dialog, DialogHeader } from '@astryxdesign/core/Dialog'
import { Text } from '@astryxdesign/core/Text'
import { Badge } from '@astryxdesign/core/Badge'
import { Banner } from '@astryxdesign/core/Banner'
import { Button } from '@astryxdesign/core/Button'
import { Card } from '@astryxdesign/core/Card'
import { List, ListItem } from '@astryxdesign/core/List'
import { Selector } from '@astryxdesign/core/Selector'
import {
  ApiError, ago, api, explain, inr, money,
  type BookMargin, type DeltaFigures, type DeskMode, type FillEstimate,
  type PlannedOrderWire, type PricedOrder, type RepairApplyRequest, type RepairMove,
  type RepairPreflightResponse, type RepairRunDoc, type RepairRunOrder,
  type VerifyMarginResponse,
} from './api.ts'
import { useAsync, usePoll } from './shell.tsx'
import { withReauth, type Reauth } from './auth.tsx'
import { serverAnswered } from './manual-order-plan.ts'
import { formatContract } from './contract.ts'

/**
 * The ledger's cadence while a run is live. Fast, because the whole point of
 * this half of the modal is that the operator watches the waves land — and
 * cheap, because it reads one document by `_id`.
 */
const STATUS_POLL_MS = 2_000

/** A price, to the paisa like every price on this desk. */
function price(n: number | null | undefined): string {
  return typeof n === 'number' && Number.isFinite(n) ? inr(n, 2) : '—'
}

/** A percentage that ARRIVES as one (`neutral.pct` is already ×100), signed. */
function pct(n: number | null | undefined): string {
  if (typeof n !== 'number' || !Number.isFinite(n)) return '—'
  return `${n >= 0 ? '+' : ''}${n.toFixed(2)}%`
}

/** `1 lot` / `2 lots` — the unit the desk's order path counts in. */
function lotsText(lots: number): string {
  const n = typeof lots === 'number' && Number.isFinite(lots) ? lots : 0
  return `${inr(n)} lot${n === 1 ? '' : 's'}`
}

/**
 * THE SENTENCE ONE ORDER IS, and the name its row is addressed by. It is the
 * accessible name of the row and the label a screen reader (and the suite)
 * tells three near-identical rows apart with.
 */
function orderName(o: PlannedOrderWire): string {
  return `${o.side} ${lotsText(o.lots)} ${formatContract(o.instrument.tradingsymbol)}`
}

/**
 * WHAT THIS SIZE WOULD PAY, said in the three ways it can be unknown.
 *
 * `est: null` is NO QUOTE AT ALL and it is the one that stops the run; a quote
 * with no price is a book that is empty or too stale to price off, which is a
 * different and less final fact; and a partial walk is answered honestly with
 * how much was actually showing.
 */
function estText(mark: number | null, est: FillEstimate | null): string {
  if (est === null) return 'no quote — it would be placed blind'
  const head = `mark ${price(mark)}`
  if (est.price === null) {
    return `${head} · no price on this book — stale or empty, so no estimate is offered`
  }
  const walked = `${head} · est ${price(est.price)}`
  return est.exceedsDepth ? `${walked} · only ${inr(est.coveredQty)} showing` : walked
}

/** Δ0 as the price it happens at AND how far that is — a price alone sizes nothing. */
function deltaZero(f: DeltaFigures | undefined): string {
  const n = f?.neutral ?? null
  return n === null ? '—' : `${price(n.price)} (${pct(n.pct)})`
}

/**
 * The bridge's own sentence for a card that has outlived its book
 * (`routes/repair.ts:BOOK_MOVED`), matched loosely on the half that cannot move
 * without the sentence being rewritten anyway. A drop that says this is not a
 * plan to fix in this modal — it is a search to run again.
 */
function namesAChangedBook(dropped: readonly string[]): boolean {
  return dropped.some((d) => typeof d === 'string' && /the book has changed/i.test(d))
}

/** Each plan flag as the warning it is. Unknown flags are shown as they arrived. */
const FLAG_TEXT: Readonly<Record<string, string>> = {
  'degrades-floor':
    'this plan leaves the book WORSE at its floor than doing nothing does — the figures on the card ' +
    'are scored against that baseline',
  'bot-may-reshift': 'the bot may re-shift these legs once the hold lifts',
  'bot-rebalance-pending':
    'the supervisor already has a rebalance pending on this book — it may act on top of these orders',
  'no-feasible-plan':
    'the search met this goal with nothing: this is the least-bad row rather than a repair',
}

/** The dashboard's one de-duplicating sentence list (`payoff.tsx`'s `sentences`). */
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

/** A small labelled figure — `payoff.tsx`'s `Score`, copied for the same reason. */
function Score(props: { label: string; value: string }): React.ReactElement {
  return (
    <VStack gap={0}>
      <Text size="xsm" color="secondary">{props.label}</Text>
      <Text size="sm" weight="medium">{props.value}</Text>
    </VStack>
  )
}

/**
 * ONE ORDER, IN BOTH HALVES OF THIS MODAL — priced in the preview, chipped with
 * its status once the run owns it. One component, because the operator is
 * matching the rows they read against the rows that executed, and two renderers
 * is how the second one quietly stops saying which expiry a leg is in.
 */
function OrderRow(props: {
  planned: PlannedOrderWire
  bookExpiry: string
  /** The preview's numbers. Null once the run is what is being rendered. */
  quote: { readonly mark: number | null; readonly est: FillEstimate | null } | null
  status?: RepairRunOrder['status']
  detail?: string
}): React.ReactElement {
  const o = props.planned
  /**
   * THE EXPIRY IS SAID ONLY WHEN IT IS NOT THE BOOK'S. A September wing on an
   * August book is identical in every other column, and it is the one thing an
   * operator cannot recover from reading the strike.
   */
  const offBook = typeof o.expiry === 'string' && o.expiry !== '' && o.expiry !== props.bookExpiry
  return (
    <HStack gap={2} align="center" wrap="wrap" role="group" aria-label={orderName(o)}>
      <Badge variant={o.side === 'Buy' ? 'info' : 'warning'} label={o.side} />
      <Text size="sm" weight="medium">{formatContract(o.instrument.tradingsymbol)}</Text>
      <Text size="sm">{lotsText(o.lots)}</Text>
      {offBook ? <Badge variant="warning" label={o.expiry} /> : null}
      {props.quote === null ? null : (
        <Text size="xsm" color="secondary">{estText(props.quote.mark, props.quote.est)}</Text>
      )}
      {props.status === undefined ? null : (
        <Badge
          variant={
            props.status === 'FILLED' ? 'success' : props.status === 'FAILED' ? 'error' : 'neutral'
          }
          label={props.status}
        />
      )}
      {props.detail === undefined || props.detail === '' ? null : (
        <Text size="xsm" color="secondary">{props.detail}</Text>
      )}
    </HStack>
  )
}

/** One of the four delta cells. Named for the pair it describes, so it is addressable. */
function DeltaCell(props: { who: string; when: string; figures: DeltaFigures | undefined }): React.ReactElement {
  return (
    <VStack gap={0} role="group" aria-label={`${props.who} ${props.when}`}>
      <Text size="xsm" color="secondary">{`${props.who} · ${props.when}`}</Text>
      <Text size="sm" weight="medium">{deltaZero(props.figures)}</Text>
      <Text size="xsm" color="secondary">{`net Δ ${money(props.figures?.netDelta)}`}</Text>
    </VStack>
  )
}

/**
 * WHAT THE BOOK WOULD COST TO HOLD AFTER THIS REPAIR, and what it costs now.
 *
 * The preflight's `margin` describes the book the plan would LEAVE — there is no
 * "before" on that wire — so the other half of the comparison is the Books
 * tile's own document (`/v1/desk/margin`), which is a cached Mongo read and
 * spends nothing at the broker. Both figures come out of `brokerFigures`, which
 * is what makes subtracting one from the other honest; the difference is not
 * shown at all when the tile has no figure, rather than computed against the
 * desk's own estimator, which is a different definition of margin.
 *
 * A NULL BROKER IS "NOT VERIFIED", NEVER A ZERO — `payoff.tsx`'s rule, kept:
 * the estimate stands alone and the bridge's sentences say what went wrong.
 *
 * ── AND NEITHER FIGURE IS PRINTED WITHOUT ITS QUALIFIERS ────────────────────
 *
 * `brokerFigures` WITH NO USABLE BROKER SNAPSHOT IS THE IDENTITY — Zerodha's
 * own rates, in this account's shape — and the number looks identical either
 * way, so the sentence is switched on `calibrated` rather than written as a
 * standing claim (`payoff.tsx`'s `VerifyPanel`, verbatim rule). The derivation
 * is printed with it, because "span + exposure + premium paid" is what makes
 * this the same figure the Books tile shows and not a second definition of
 * margin.
 *
 * TWO FIGURES AT DIFFERENT RATES ARE NOT SUBTRACTABLE. A calibrated "after"
 * against an uncalibrated "now" differs by the multiplier alone, so a
 * difference computed across them is a change that never happened. When the two
 * disagree, BOTH are shown and the headline difference is withheld with the
 * reason. The current figure's AGE goes with it on the same rule the margin
 * tile applies (`pages.tsx`): a stale document and a failed refresh are the same
 * fact to a reader, and both say so.
 */
function MarginBlock(props: { margin: VerifyMarginResponse; now: BookMargin | null }): React.ReactElement {
  const b = props.margin.broker ?? null
  const now =
    props.now?.available === true && typeof props.now.brokerTotal === 'number'
      ? props.now.brokerTotal
      : null
  /** A failed refresh is as much a reason to distrust the figure as an old one. */
  const nowStale = props.now?.stale === true || props.now?.ok === false
  const nowAge = ago(props.now?.ageMs ?? null)
  /** Both at broker rates, or both at Zerodha's. Anything else is not a difference. */
  const sameRates = b !== null && now !== null && (b.calibrated === true) === (props.now?.calibrated === true)
  const notes = sentences(props.margin.warnings)
  return (
    <Card padding={2} role="group" aria-label="Margin after this repair">
      <VStack gap={1}>
        <HStack gap={4} wrap="wrap">
          {b === null ? null : <Score label="broker margin after" value={inr(b.total)} />}
          <Score label="this desk’s estimate (SPAN-lite)" value={inr(props.margin.estimated)} />
          {/* Shown as its own figure exactly when it cannot be subtracted. */}
          {b !== null && now !== null && !sameRates ? (
            <Score label="broker holds now" value={inr(now)} />
          ) : null}
        </HStack>
        {b === null ? (
          <Text size="sm" color="secondary">
            The broker’s own figure is not verified for this plan — the estimate above is this desk’s,
            and the sentences below say what went wrong.
          </Text>
        ) : (
          <Text size="xsm" color="secondary">
            {`The broker figure is the same margin the Books tile shows: span ${inr(b.span)} + exposure ` +
              `${inr(b.exposure)} + premium paid ${inr(b.premiumPaid)}, ` +
              (b.calibrated === true
                ? 'at this account’s calibrated rates rather than the calculator’s headline.'
                : 'at Zerodha’s own rates (no calibration available) rather than the calculator’s headline.')}
          </Text>
        )}
        {b === null ? null : now === null ? (
          <Text size="xsm" color="secondary">
            The book’s current broker figure has not been priced yet, so there is no difference to show
            — read the figure above as what the repaired book would need in total.
          </Text>
        ) : sameRates ? (
          <Text size="sm">
            {`${money(b.total - now)} against the ${inr(now)} the broker holds for this book now — ` +
              `priced ${nowAge}` +
              (nowStale ? ', and that refresh is stale or failed' : '')}
          </Text>
        ) : (
          <Text size="sm">
            {'No difference is shown: the two figures are at different rates — ' +
              `the repaired book above at ${b.calibrated === true ? 'this account’s calibrated' : 'Zerodha’s own'} ` +
              `rates, the book’s current figure at ${props.now?.calibrated === true ? 'this account’s calibrated' : 'Zerodha’s own'} ` +
              `rates (priced ${nowAge}${nowStale ? ', stale or failed' : ''}). Subtracting one from the other ` +
              'would invent a change that is only the multiplier.'}
          </Text>
        )}
        {notes.length === 0 ? null : (
          <List density="compact">
            {notes.map((w) => (
              <ListItem key={w} label={<Text size="xsm" color="secondary">{w}</Text>} />
            ))}
          </List>
        )}
      </VStack>
    </Card>
  )
}

export interface RepairApplyDialogProps {
  open: boolean
  tag: string
  mode: DeskMode
  /** The book's own expiry — a row only prints its expiry when it differs. */
  bookExpiry: string
  /** The goal this plan was searched under. Header, and the re-auth statement. */
  planLabel: string
  /** The card's flags, restated here as sentences rather than as chips. */
  planFlags: readonly string[]
  moves: readonly RepairMove[]
  /**
   * The CARD's fingerprint of the legs its moves address (`RepairResponse.
   * legsPrint`), carried into the preflight so a menu that has outlived its book
   * is refused instead of aimed at whatever now sits under its leg ids. What
   * goes back out with the apply is the PREFLIGHT's, never this.
   */
  legsPrint: string
  /** The page's own prompt, rendered once at the page bottom, as everywhere. */
  reauth: Reauth
  onClose: () => void
}

export function RepairApplyDialog(props: RepairApplyDialogProps): React.ReactElement {
  const [style, setStyle] = useState<'fast' | 'limit'>('fast')
  const [pre, setPre] = useState<RepairPreflightResponse | null>(null)
  const [preError, setPreError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  /** Bumped to ask the preflight again — the 409 path, and only that. */
  const [round, setRound] = useState(0)
  /** The book moved under an attempt: nothing was placed and the preview is new. */
  const [moved, setMoved] = useState(false)
  const [nowMargin, setNowMargin] = useState<BookMargin | null>(null)
  const [busy, setBusy] = useState(false)
  /**
   * A plan the bridge refused, or a transport failure — the preview stands
   * either way. `unconfirmed` is the ABSENCE of an answer, and it has to be
   * sayable out loud: "not placed" over a run that may be executing is the
   * sentence that produces a second one.
   */
  const [refusal, setRefusal] = useState<{ kind: 'refused' | 'unconfirmed'; text: string } | null>(null)
  const [applyId, setApplyId] = useState<string | null>(null)
  const [run, setRun] = useState<RepairRunDoc | null>(null)
  /**
   * MINTED ONCE PER OPEN — see the header. Never in render, where every repaint
   * would remint it, and never on retry, where a fresh one is a second repair.
   */
  const [decisionId, setDecisionId] = useState('')
  /**
   * The last stamp minted here, so a re-mint is STRICTLY LATER than the one
   * before it. `Date.now()` has millisecond resolution and two plans swapped
   * inside one millisecond would mint the SAME id on the same tag and rail —
   * which is the exact collision this re-mint exists to prevent, and one the
   * server cannot see. The shape is unchanged; only its uniqueness is now ours.
   */
  const minted = useRef(0)

  /**
   * The plan's identity, keyed by CONTENT: the parent hands a fresh array on
   * every render, so a dependency on its identity would re-arm on every repaint.
   */
  const movesKey = JSON.stringify(props.moves)

  /**
   * EVERYTHING BELONGS TO THE PLAN IT WAS EARNED UNDER. State survives a close
   * (the FlattenDialog discipline the manual-order dialog cites) and is cleared
   * on the way IN — and on any change of PLAN, which is the case that matters:
   *
   * A DIFFERENT PLAN IN THE SAME OPEN DIALOG MUST RE-MINT THE `decisionId`.
   * Keyed on [open, tag, mode] alone, a parent that swapped `moves` while this
   * stayed open kept the previous plan's id — and with an unconfirmed attempt
   * behind it, plan B's Place re-claims plan A's RUN. The server answers 202
   * with A's `applyId` (same tag, same mode: its owner check cannot see the
   * difference), and this modal then reports B as placed while watching A
   * execute. The id, the refusal, the run and the preview all belong to the
   * plan, so all of them are cleared together.
   */
  useEffect(() => {
    if (!props.open) return
    const at = Math.max(Date.now(), minted.current + 1)
    minted.current = at
    setDecisionId(`repair:${props.tag}:${props.mode}:${at}`)
    setStyle('fast')
    setPre(null)
    setPreError(null)
    setMoved(false)
    setRefusal(null)
    setApplyId(null)
    setRun(null)
    setBusy(false)
    /*
      `nowMargin` IS NOT RESET HERE, AND THAT IS THE POINT OF THE SPLIT. It
      describes the BOOK, not the plan — the same document for every card on
      one tag — and its read keys on the tag. Clearing it on a plan swap left
      it null with nothing to refill it, so the difference sentence read "not
      priced yet" for the rest of the session. Its own scope is below.
    */
  }, [props.open, props.tag, props.mode, movesKey, props.legsPrint])

  /**
   * WHAT WOULD BE PLACED. Nothing is written and no rail is reached, which is
   * what makes it safe to ask again after a 409.
   */
  useAsync(
    props.open
      ? () => {
          setLoading(true)
          // An EMPTY print is not a print. The server reads a present-but-wrong
          // one as "this card is stale" and drops every leg-addressed move, so
          // a bridge one deploy behind (which serves none) must omit the key
          // rather than send a lie about it.
          return props.legsPrint === ''
            ? api.repairPreflight(props.tag, props.mode, props.moves)
            : api.repairPreflight(props.tag, props.mode, props.moves, props.legsPrint)
        }
      : null,
    (r) => {
      setPre(r)
      setPreError(null)
      setLoading(false)
    },
    (err) => {
      setPreError(explain(err))
      setLoading(false)
    },
    [props.open, round, props.tag, props.mode, movesKey, props.legsPrint],
  )

  /**
   * THE BOOK'S CURRENT BROKER MARGIN — the Books tile's own document, read once
   * per open. A cached Mongo read: it spends nothing at the broker, and a
   * failure simply leaves the comparison unmade.
   *
   * TAG-SCOPED, NOT PLAN-SCOPED, and it is cleared HERE — inside the read that
   * refills it — rather than in any reset above. That is not tidiness: a clear
   * living in an effect keyed on something this read does NOT re-run for
   * (a plan swap on one tag) leaves the figure null forever, and the difference
   * sentence then reads "not priced yet" for the rest of the session. Clearing
   * where the refill is makes the two impossible to separate; the stale figure
   * this guards against is the PREVIOUS BOOK'S, which only a tag change can
   * produce.
   */
  useAsync(
    props.open
      ? () => {
          setNowMargin(null)
          return api.bookMargin(props.tag)
        }
      : null,
    (m) => setNowMargin(m),
    () => setNowMargin(null),
    [props.open, props.tag, props.mode],
  )

  /**
   * THE RUN'S LEDGER, WHILE IT IS A RUN. It stops the moment the state leaves
   * RUNNING — a finished run must not be re-read every two seconds because a
   * modal was left open on it — and the last document read is KEPT, so the
   * halted record stays on screen after the poll has stood down.
   */
  const settled = run !== null && run.state !== 'RUNNING'
  const { data: fresh, error: runError } = usePoll<RepairRunDoc | null>(
    () =>
      props.open && applyId !== null && !settled
        ? api.repairApplyStatus(applyId)
        : Promise.resolve(null),
    STATUS_POLL_MS,
    [props.open, applyId, settled],
  )
  useEffect(() => {
    if (fresh !== null) setRun(fresh)
  }, [fresh])

  const orders: readonly PricedOrder[] = pre?.orders ?? []
  const closes = orders.filter((o) => o.wave === 'close')
  const opens = orders.filter((o) => o.wave === 'open')
  const dropped = pre?.dropped ?? []
  /** Opens with NO quote at all — the run would halt on them, so this stops first. */
  const blind = opens.filter((o) => o.est === null)

  /**
   * WHY THE BUTTON IS OFF, rather than a button that is merely grey. Each of
   * these is a refusal the SERVER would make; the modal is saying it a request
   * earlier, in the words the operator can act on.
   */
  const blocked: string | null =
    // Nothing about a run in flight: the moment there is an `applyId` the
    // button is GONE (the footer swaps to Close), so a sentence about why it
    // is disabled would be describing a control nobody can see.
    preError !== null
      ? // A FAILED RE-READ BLOCKS EVEN WITH A PREVIEW ON SCREEN. The rows below
        // are then the PREVIOUS answer, and the whole point of asking again was
        // that it may no longer be true.
        `the book could not be read: ${preError}`
      : loading || pre === null
        ? 'Reading the book…'
        : dropped.length > 0
          ? 'part of this plan cannot be placed, and a half-placed repair is a book that is naked ' +
            'on the other half — nothing here can go out'
          : pre.holdActive
            ? // BOTH HALVES OF THE SERVER'S HOLD. It covers the run that is
              // executing AND the minute and a half after one ends, while the
              // book is being handed back to its supervisor — saying only the
              // first would read as a lie on a tag whose repair just finished.
              'another repair still owns this tag — one is running, or one has just finished and ' +
              'the book is still being handed back to its supervisor'
            : orders.length === 0
              ? 'this plan places nothing — there is no repair here to run'
              : blind.length > 0
                ? `there is no quote for ${blind
                    .map((o) => o.instrument.tradingsymbol)
                    .join(', ')} — the run would halt there rather than open blind`
                : null

  const marginLine =
    pre === null
      ? ''
      : pre.margin.broker !== null
        ? `the book it leaves needs ${inr(pre.margin.broker.total)} at the broker`
        : `this desk estimates the book it leaves at ${inr(pre.margin.estimated)} (the broker check failed)`

  /**
   * THE STATEMENT NAMES WHAT BECOMES POSSIBLE, never "confirm this action" —
   * `useReauth`'s own rule. The three facts an operator can be wrong about here
   * are the BOOK, HOW MANY real orders, and what holding the result costs.
   */
  const statement =
    `Place ${orders.length} repair order${orders.length === 1 ? '' : 's'} on the LIVE account ` +
    `under ${props.tag} — ${props.planLabel}: ${closes.length} close${closes.length === 1 ? '' : 's'} ` +
    `first, then ${opens.length} open${opens.length === 1 ? '' : 's'}. These are real orders at the ` +
    `broker, and ${marginLine}.`

  const place = async (): Promise<void> => {
    if (pre === null || blocked !== null || busy) return
    const body: RepairApplyRequest = {
      tag: props.tag,
      mode: props.mode,
      moves: props.moves,
      // OFF THE ANSWER, never off the card — see the header. And `bookPrint` is
      // not sent at all: it moves with every tick.
      legsPrint: pre.legsPrint,
      decisionId,
      style,
    }
    /**
     * The failure, READ WHERE THE ERROR OBJECT STILL EXISTS — `withReauth`
     * flattens it to a message, and the three cases are three different things
     * to do: legs that moved is a preview to redraw, a definitive refusal is a
     * sentence to show, and a transport failure is an outcome NOBODY KNOWS.
     */
    let legsChanged = false
    let answered = false
    setBusy(true)
    setRefusal(null)
    setMoved(false)
    await withReauth({
      statement,
      // The same condition the SERVER re-authenticates on. Paper is asked
      // nothing: it cannot move money.
      promptFirst: props.mode === 'live',
      run: async (password) => {
        try {
          return await api.repairApply(password === undefined ? body : { ...body, password })
        } catch (err) {
          if (err instanceof ApiError && err.status === 409) legsChanged = true
          answered = serverAnswered(err)
          throw err
        }
      },
      reauth: props.reauth,
      onDone: (res) => {
        if (!res.accepted) {
          setRefusal({ kind: 'refused', text: res.reason })
          return
        }
        setApplyId(res.applyId)
      },
      onError: (message) => {
        if (legsChanged) {
          /**
           * A 409 PLACED NOTHING — a leg was opened, closed or resized under the
           * plan, so the sentences on screen no longer address what the operator
           * thinks they do. The honest response is a fresh reading under the
           * SAME `decisionId`, not an error code.
           */
          setMoved(true)
          setRound((r) => r + 1)
          return
        }
        /**
         * "NOT PLACED" IS A CLAIM ONLY AN ANSWER CAN SUPPORT. Over a timeout or
         * a dropped connection the run may already be executing, and saying it
         * failed is what talks somebody into placing the repair a second time.
         * The `decisionId` is deliberately kept, so the obvious response —
         * press Place again — re-claims the SAME run instead of starting one.
         */
        setRefusal({ kind: answered ? 'refused' : 'unconfirmed', text: message })
      },
    })
    setBusy(false)
  }

  const filled = (run?.orders ?? []).filter((o) => o.status === 'FILLED').length
  const total = run?.orders.length ?? 0
  const watching = applyId !== null
  const running = watching && (run === null || run.state === 'RUNNING')

  return (
    <Dialog isOpen={props.open} onOpenChange={props.onClose} purpose="form" width={560}>
      <Layout
        header={
          <DialogHeader
            title={`Apply repair · ${props.tag}`}
            subtitle={`${props.planLabel} · ${props.mode}`}
            onOpenChange={props.onClose}
          />
        }
        content={
          <LayoutContent>
            <VStack gap={4}>
              {watching ? (
                <>
                  {run === null ? (
                    <Banner
                      status="info"
                      title="Accepted — waiting for the run’s first report"
                      description={
                        'The orders are queued at the desk. This dialog reads the run’s own ledger; ' +
                        'closing it does not stop the run.'
                      }
                    />
                  ) : run.state === 'RUNNING' ? (
                    <Banner
                      status="info"
                      title="Running"
                      description={`${filled} of ${total} orders filled so far. Closes go before opens.`}
                    />
                  ) : run.state === 'DONE' ? (
                    <Banner
                      status="success"
                      title="All filled"
                      description={`${total} order${total === 1 ? '' : 's'} traded. The book is repaired.`}
                    />
                  ) : (
                    <Banner
                      status="error"
                      title="Halted — finish the rest by hand"
                      description={run.haltReason ?? 'the run stopped without saying why'}
                    />
                  )}
                  {/*
                    HOW MUCH OF THE PLAN IS ACTUALLY IN THE BOOK — the figure a
                    halted run is finished by hand from. The DONE banner already
                    says it in words, so this is the halted case only.
                  */}
                  {run?.state === 'HALTED' ? (
                    <Text size="sm">{`${filled} of ${total} orders filled.`}</Text>
                  ) : null}
                  <VStack gap={1}>
                    {(run?.orders ?? []).map((o) => (
                      <OrderRow
                        key={o.clientOrderId}
                        planned={o.planned}
                        bookExpiry={props.bookExpiry}
                        quote={null}
                        status={o.status}
                        {...(o.detail === undefined ? {} : { detail: o.detail })}
                      />
                    ))}
                  </VStack>
                  {runError === null ? null : (
                    <Text size="sm" color="secondary">
                      {`The ledger could not be read just now: ${runError}. The run is unaffected.`}
                    </Text>
                  )}
                  {/*
                    WHAT CLOSING COSTS, said before it is pressed. The run
                    continues either way — but nothing reopens THIS view on it:
                    the modal is entered from a plan card, and the card cannot
                    find a run it did not start. Rather than build a re-attach
                    for v1, the affordance carries its own consequence and names
                    the screen that does keep the record.
                  */}
                  {running ? (
                    <Text size="sm" color="secondary">
                      Closing is final for this view: it cannot be reopened for this run. The run itself
                      carries on at the desk, and its fills land in this book’s own order log on the page
                      behind this dialog.
                    </Text>
                  ) : null}
                </>
              ) : (
                <>
                  {moved ? (
                    <Banner
                      status="warning"
                      title="A leg moved — nothing was placed"
                      description={
                        'A leg was opened, closed or resized under this plan, so the desk refused it and ' +
                        'the preview below was re-read against the book as it stands. Read it again ' +
                        'before placing — the sizes below may not be the ones you confirmed.'
                      }
                    />
                  ) : null}
                  {/*
                    THE SENTENCES SIT BESIDE THE BANNER, NOT INSIDE IT. A
                    `Banner`'s children are its COLLAPSED content — a reader has
                    to press a chevron to see them — and the moves that could not
                    be placed are the whole reason this banner is on screen.
                  */}
                  {dropped.length > 0 ? (
                    <VStack gap={1}>
                      <Banner
                        status="error"
                        title="Part of this plan cannot be placed"
                        description={
                          namesAChangedBook(dropped)
                            ? 'Close this and run the repair search again — these sentences name legs that ' +
                              'have moved since the menu was drawn, so nothing here can be aimed at them.'
                            : 'A repair is a shape: the desk refuses the whole plan rather than placing the ' +
                              'half it understood. Finish the rest by hand, or search again.'
                        }
                      />
                      <List density="compact">
                        {sentences(dropped).map((d) => (
                          <ListItem key={d} label={<Text size="sm">{d}</Text>} />
                        ))}
                      </List>
                    </VStack>
                  ) : null}
                  {refusal === null ? null : (
                    <Banner
                      status={refusal.kind === 'refused' ? 'error' : 'warning'}
                      title={refusal.kind === 'refused' ? 'Not placed' : 'Not confirmed'}
                      description={
                        refusal.kind === 'refused'
                          ? refusal.text
                          : `${refusal.text} — the run may already be executing. Pressing Place again ` +
                            're-claims the SAME run rather than starting a second one.'
                      }
                    />
                  )}

                  {/*
                    THE TWO WAVES ARE SECTIONS, not a heading followed by rows —
                    each is a named group, so "which wave is this order in" is a
                    question the DOM answers rather than one the reading order
                    implies. The order of execution is the whole reason the
                    grouping exists: closes free the margin the opens need.
                  */}
                  {closes.length === 0 ? null : (
                    <VStack gap={1} role="group" aria-label="Closes first">
                      <Text size="sm" weight="medium">
                        {`Closes first — ${closes.length} order${closes.length === 1 ? '' : 's'}`}
                      </Text>
                      {closes.map((o) => (
                        <OrderRow
                          key={`c${o.moveIndex}${o.instrument.tradingsymbol}`}
                          planned={o}
                          bookExpiry={props.bookExpiry}
                          quote={{ mark: o.mark, est: o.est }}
                        />
                      ))}
                    </VStack>
                  )}
                  {opens.length === 0 ? null : (
                    <VStack gap={1} role="group" aria-label="Then opens">
                      <Text size="sm" weight="medium">
                        {`Then opens — ${opens.length} order${opens.length === 1 ? '' : 's'}`}
                      </Text>
                      {opens.map((o) => (
                        <OrderRow
                          key={`o${o.moveIndex}${o.instrument.tradingsymbol}`}
                          planned={o}
                          bookExpiry={props.bookExpiry}
                          quote={{ mark: o.mark, est: o.est }}
                        />
                      ))}
                    </VStack>
                  )}

                  {pre === null ? null : <MarginBlock margin={pre.margin} now={nowMargin} />}

                  {pre === null ? null : (
                    <Card padding={2}>
                      <VStack gap={1}>
                        <Text size="sm" weight="medium">Where the delta lands</Text>
                        <HStack gap={4} wrap="wrap">
                          <DeltaCell who="all legs" when="now" figures={pre.delta.current.all} />
                          <DeltaCell who="all legs" when="after" figures={pre.delta.after.all} />
                          <DeltaCell who="shorts only" when="now" figures={pre.delta.current.shortsOnly} />
                          <DeltaCell who="shorts only" when="after" figures={pre.delta.after.shortsOnly} />
                        </HStack>
                        <Text size="xsm" color="secondary">
                          Δ0 is the underlying price this book would be flat at. These are the Positions
                          engine’s figures, not the cockpit’s — the same ones the tiles print.
                        </Text>
                      </VStack>
                    </Card>
                  )}

                  <Selector
                    label="Order style"
                    options={[
                      { value: 'fast', label: 'Fast — step through the touch' },
                      { value: 'limit', label: 'Limit — rest at the mid, the chaser walks it in' },
                    ]}
                    value={style}
                    isDisabled={busy}
                    onChange={(v) => setStyle(v === 'limit' ? 'limit' : 'fast')}
                  />

                  {sentences(
                    props.planFlags.map((f) => FLAG_TEXT[f] ?? f),
                    pre?.warnings,
                  ).map((w) => (
                    <Text key={w} size="sm" color="secondary">{w}</Text>
                  ))}
                </>
              )}
            </VStack>
          </LayoutContent>
        }
        footer={
          <LayoutFooter hasDivider>
            <VStack gap={1}>
              {/* WHY Place is off, in the words the operator can act on. */}
              {watching || blocked === null ? null : (
                <Text size="sm" color="secondary">{blocked}</Text>
              )}
              <HStack gap={2} justify="end" wrap="wrap">
                <Button
                  variant="secondary"
                  label={running ? 'Close — the run continues at the desk' : 'Close'}
                  onClick={props.onClose}
                />
                {watching ? null : (
                  <Button
                    variant={props.mode === 'live' ? 'destructive' : 'primary'}
                    label={
                      busy
                        ? 'Placing…'
                        : `Place ${orders.length} order${orders.length === 1 ? '' : 's'}`
                    }
                    isDisabled={busy || blocked !== null}
                    onClick={() => void place()}
                  />
                )}
              </HStack>
            </VStack>
          </LayoutFooter>
        }
      />
    </Dialog>
  )
}
