/**
 * MANUAL ORDER — place ONE option order under an existing tag, from its row.
 *
 * The escape hatch this desk did not have: when a strategy misses an exit (or
 * an operator needs to adjust a strike by hand), the only route used to be the
 * broker's own website — which the desk then knows nothing about. This dialog
 * sends the order through `/v1/desk/submit`, so it lands in the same journal,
 * the same gates and the same P&L as everything else the tag trades.
 *
 * TWO CALLERS, ONE DIALOG. A Books row knows its symbol and expiry, so the
 * pair arrives locked in the header; a Strategies row knows only its tag, so
 * the operator picks both — from the master's own lists, for the reason
 * `book-build.tsx` gives (a typo in free text fails three steps later, with an
 * error that blames the feed).
 *
 * THE CONTRACT COMES FROM THE CHAIN (`ceContract`/`peContract`), never
 * string-built — same rule as the Build page: a client guessing the exchange's
 * month code is a silent wrong-instrument bug waiting for the month the format
 * differs.
 *
 * `exactLots: true` ALWAYS. Without it the live rail replaces the asked size
 * with the strategy row's `liveLots` — and a manual 1-lot adjustment silently
 * becoming the row's 4 lots is precisely the wrong kind of help here.
 *
 * NOTHING IS PLACEABLE THAT THE SCREEN CANNOT VOUCH FOR. The chain read is
 * tagged with the pair it was fetched for and matched before a single strike is
 * offered (`chainForPair`), and a typed limit is armed for ONE contract
 * (`priceIsOperators`) — both because a control that keeps rendering the
 * previous selection's data is a wrong-instrument order waiting for someone to
 * be quick with a Selector.
 *
 * A RE-PRESS AFTER A TRANSPORT FAILURE IS A RETRY, NOT A SECOND ORDER. The
 * minted `clientOrderId` is HELD (`orderIdForPress`) until the server actually
 * answers, so the natural response to "no response from the desk" replays the
 * same order instead of placing another one.
 *
 * ALWAYS MOUNTED, OPENED BY `target !== null`, state cleared on [tag, mode] —
 * the FlattenDialog discipline: its state survives being closed, and without
 * the reset a result earned on one row would render under another row's title.
 */

import { useEffect, useRef, useState } from 'react'
import { VStack, HStack, Layout, LayoutContent, LayoutFooter } from '@astryxdesign/core/Layout'
import { Text } from '@astryxdesign/core/Text'
import { Badge } from '@astryxdesign/core/Badge'
import { Banner } from '@astryxdesign/core/Banner'
import { Button } from '@astryxdesign/core/Button'
import { TextInput } from '@astryxdesign/core/TextInput'
import { Selector } from '@astryxdesign/core/Selector'
import { Dialog, DialogHeader } from '@astryxdesign/core/Dialog'
import { api, type DeskMode, type InstrumentsResponse } from './api.ts'
import { useAsync, usePoll } from './shell.tsx'
import { withReauth, type Reauth } from './auth.tsx'
import type { Side } from './entry-plan.ts'
import {
  chainForPair,
  classifyExposure,
  contractKey,
  deskBookNote,
  executionNote,
  orderIdForPress,
  orderProblem,
  pairKey,
  prefillPrice,
  priceIsOperators,
  restingUnbooked,
  serverAnswered,
  unconfirmedText,
  type HeldLeg,
  type PressId,
  type TaggedChain,
} from './manual-order-plan.ts'

/** The chain payload, as `api.chain` types it — no local restatement to drift. */
type Chain = Awaited<ReturnType<typeof api.chain>>
type ChainRow = NonNullable<Chain['rows']>[number]

/**
 * Quotes move; the poll keeps the strike list's LTPs honest while the dialog
 * is open. Same order of cadence as the pages behind it (5s), and nothing at
 * all while it is closed.
 */
const CHAIN_POLL_MS = 4000

/**
 * The book's own legs, refreshed while the dialog is open — slower than the
 * chain because a book changes when someone trades it, not when a tick lands.
 * It is what decides whether this order is an EXIT or a new leg, so it must not
 * be a page-load snapshot: the supervisor may close the very leg the operator
 * is aiming at while the dialog sits open.
 */
const BOOK_POLL_MS = 5000

/** `12.35` or an em dash — the strike picker's per-side LTP. */
function ltp(q: ChainRow['CE']): string {
  // Two decimals: the tick grid is paisa-resolution, and the mid the chain
  // serves is a float whose binary dust ("78.57499999999999") is not a price.
  return q === null || q === undefined ? '—' : q.price.toFixed(2)
}

export interface ManualOrderTarget {
  readonly tag: string
  /**
   * BOTH present on a desk BOOK (Books page), where the row already knows its
   * pair — the dialog locks them. Both absent on a hosted strategy
   * (Strategies page), where the operator picks them. Presence of the pair is
   * also what keys the adoption warning below: only desk books have a Python
   * supervisor that can fail to adopt the leg.
   */
  readonly symbol?: string
  readonly expiry?: string
}

/** A two-value toggle drawn as two buttons — the picked one is solid. */
function Toggle<T extends string>(props: {
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

export function ManualOrderDialog(props: {
  target: ManualOrderTarget | null
  mode: DeskMode
  /** The page's own prompt — rendered once at the page bottom, as everywhere. */
  reauth: Reauth
  onClose: () => void
  /** Called after an order actually routed (fully or partly), so the page refreshes. */
  onDone?: () => void
}): React.ReactElement {
  const open = props.target !== null
  const tag = props.target?.tag ?? ''
  /** The pair arrived with the row — lock it. Absent means the operator picks. */
  const fixed = props.target?.symbol !== undefined && props.target?.expiry !== undefined

  const [symbol, setSymbol] = useState('')
  const [expiry, setExpiry] = useState('')
  const [underlyings, setUnderlyings] = useState<readonly string[] | null>(null)
  const [expiries, setExpiries] = useState<readonly string[] | null>(null)
  const [meta, setMeta] = useState<InstrumentsResponse | null>(null)
  const [strike, setStrike] = useState('')
  const [optType, setOptType] = useState<'CE' | 'PE'>('CE')
  const [side, setSide] = useState<Side>('Buy')
  const [lots, setLots] = useState('1')
  const [price, setPrice] = useState('')
  /**
   * The CONTRACT the operator typed a price for — no suggestion may overwrite
   * their number while that contract is the one selected.
   *
   * A key rather than a boolean, because the flag has to expire on its own when
   * the selection moves: a `dirty` bit reset by an effect is reset one render
   * LATE, and in that render the suggestion for the new strike is suppressed by
   * the old strike's flag, leaving an empty box beside a perfectly good quote.
   */
  const [typedFor, setTypedFor] = useState<string | null>(null)
  /** Why the price box is empty (stale/no quote), shown beside it. */
  const [priceNote, setPriceNote] = useState('')
  const [busy, setBusy] = useState(false)
  /**
   * 'Immediate' rides the normal path — the gateway's chaser reprices it if it
   * rests. 'Resting' stamps `resting: true` so the chaser stands down and the
   * order SITS at the operator's price until it trades or is cancelled.
   */
  const [execution, setExecution] = useState<'Immediate' | 'Resting'>('Immediate')
  /**
   * 'routed' and 'refused' are the server's answer. 'unconfirmed' is the
   * absence of one — a state the banner has to be able to say out loud, because
   * "Not placed" over an order that may be at the broker is the sentence that
   * produces the second one.
   */
  const [result, setResult] = useState<
    { kind: 'routed' | 'refused' | 'unconfirmed'; text: string } | null
  >(null)
  /**
   * The id of the last press, HELD ACROSS A FAILED ONE — see `orderIdForPress`.
   * A ref, not state: it must not be readable-but-stale inside the async press
   * below, and nothing renders from it.
   */
  const pressed = useRef<PressId | null>(null)

  /**
   * THE OUTCOME BELONGS TO THE ROW IT CAME FROM — the FlattenDialog bug, kept
   * fixed here too: mounted permanently, so everything resets when the dialog
   * is pointed at a different tag or rail.
   */
  useEffect(() => {
    setSymbol(props.target?.symbol ?? '')
    setExpiry(props.target?.expiry ?? '')
    setStrike('')
    setOptType('CE')
    setSide('Buy')
    setLots('1')
    setPrice('')
    setTypedFor(null)
    setPriceNote('')
    setExecution('Immediate')
    setResult(null)
    // The held id belongs to the tag and rail it was minted under; `identity`
    // carries both, so a press here could never reuse it — cleared anyway,
    // because a dialog pointed somewhere else holds nothing of the old row.
    pressed.current = null
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tag, props.mode])

  // A different pair is a different chain: the strike, the suggestion and the
  // master's lot size all belong to the old one. Cleared before the new reads
  // land so nothing stale is placeable in the gap.
  useEffect(() => {
    setStrike('')
    setPrice('')
    setTypedFor(null)
    setPriceNote('')
    setMeta(null)
  }, [symbol, expiry])

  /** The Strategies case only: the symbol list, read once per open. */
  useAsync(
    open && !fixed ? () => api.underlyings() : null,
    (list) => setUnderlyings(list),
    () => setUnderlyings([]),
    [open, fixed],
  )

  /**
   * The expiries listed FOR THIS SYMBOL — asked WITHOUT an expiry, exactly as
   * `book-build.tsx` does: right after a symbol change the held expiry is the
   * previous symbol's, and the expiry-less form answers with the first listed
   * one instead of 404ing on a pair that does not list.
   */
  useAsync(
    open && !fixed && symbol !== ''
      ? () => {
          setExpiries(null)
          return api.instruments(symbol)
        }
      : null,
    (listing) => {
      setExpiries(listing.expiries)
      setExpiry((cur) => (listing.expiries.includes(cur) ? cur : (listing.expiries[0] ?? '')))
    },
    () => setExpiries([]),
    [open, fixed, symbol],
  )

  /** Lot size, tick size and exchange for the EXACT pair — the master's, never hardcoded. */
  useAsync(
    open && symbol !== '' && expiry !== '' ? () => api.instruments(symbol, expiry) : null,
    (m) => setMeta(m),
    () => setMeta(null),
    [open, symbol, expiry],
  )

  /** The pair the strike list must be describing. Empty until both are picked. */
  const pair = symbol === '' || expiry === '' ? '' : pairKey(symbol, expiry)

  /**
   * Live strikes + contracts, refreshed while the dialog is open — TAGGED WITH
   * THE PAIR THEY DESCRIBE.
   *
   * `usePoll` keeps its last good payload across a deps change on purpose (a
   * failed refresh must not blank a page), which for a strike list means the
   * PREVIOUS expiry's strikes stay on screen, and selectable, until the new
   * read lands. See `chainForPair` for what that let through.
   */
  const { data: chainRead } = usePoll(
    () =>
      open && pair !== ''
        ? api.chain(symbol, expiry).then((c) => ({ pair, chain: c }))
        : Promise.resolve<{ pair: string; chain: Chain } | null>(null),
    CHAIN_POLL_MS,
    [open, pair],
  )
  const chain = chainForPair(chainRead, pair)

  const rows: readonly ChainRow[] = [...(chain?.rows ?? [])].sort((a, b) => a.strike - b.strike)
  const row = strike === '' ? undefined : rows.find((r) => r.strike === Number(strike))
  const contract = row === undefined ? undefined : optType === 'CE' ? row.ceContract : row.peContract
  const quote = row === undefined ? undefined : optType === 'CE' ? row.CE : row.PE

  /**
   * WHAT THE BOOK HOLDS, TAGGED WITH THE BOOK IT WAS READ FOR.
   *
   * Desk books only: a hosted strategy owns its positions internally and has no
   * `desk-books` document, so there is nothing to read and nothing to claim
   * about it. Tagged and matched for exactly the reason the chain read is —
   * `usePoll` keeps its last good payload across a deps change, and the
   * PREVIOUS book's legs under this book's title would answer "is this an
   * exit?" about a position that is not on screen. A failed read leaves it
   * null, which reads as "cannot say" and never as "holds nothing".
   */
  const bookKey = fixed && tag !== '' ? `${tag}|${props.mode}` : ''
  const { data: bookRead } = usePoll(
    () =>
      open && bookKey !== ''
        ? api
            .positions(tag, props.mode)
            .then((p) => ({ pair: bookKey, chain: p.legs as readonly HeldLeg[] }))
        : Promise.resolve<TaggedChain<readonly HeldLeg[]> | null>(null),
    BOOK_POLL_MS,
    [open, bookKey],
  )
  const heldLegs = chainForPair(bookRead, bookKey)
  /**
   * EXIT OR NEW LEG — decided from the book, shown before the press, and sent.
   *
   * Null on a hosted strategy and while the book is unread, which is the honest
   * answer: nothing is shown and no flag is sent, so the order is treated as an
   * open exactly as it always was.
   */
  const intent = classifyExposure({
    legs: heldLegs,
    tradingsymbol: contract?.tradingsymbol,
    side,
  })

  /**
   * Re-suggest the limit when the side, strike or type changes — and when the
   * first quote for the pick arrives — but NEVER once the operator has typed
   * FOR THIS CONTRACT (`prefillPrice` returns null then and the box is left
   * alone). Deliberately NOT keyed on the chain poll itself: a fresh suggestion
   * every 4s would make the box unreadable while someone is deciding.
   *
   * A price typed for another contract is not theirs any more, so the strike or
   * CE/PE moving both un-arms it and re-prices the box in the SAME render — the
   * dirty flag is derived from the selection rather than reset by an effect
   * that would run a render behind it.
   */
  const priceDirty = priceIsOperators(typedFor, strike, optType)
  const hasQuote = quote !== undefined && quote !== null
  useEffect(() => {
    const fill = prefillPrice({
      dirty: priceDirty,
      side,
      quote: quote ?? null,
      ...(meta === null ? {} : { tickSize: meta.tickSize }),
    })
    if (fill === null) return
    setPrice(fill.price)
    setPriceNote(fill.note)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [side, strike, optType, hasQuote])

  const problem = orderProblem({
    contract,
    meta,
    lots,
    price,
  })

  const place = async (): Promise<void> => {
    if (contract === undefined || meta === null || problem !== null) return
    const lotsN = Number(lots.trim())
    const priceN = Number(price)
    /**
     * Minted ONCE, at the press, and HELD until the server answers: a press
     * that changes what would be sent is a new order, and a press that repeats
     * one whose outcome we never learned is a RETRY of it. Never in render,
     * where every repaint would remint it.
     */
    const press = orderIdForPress(
      pressed.current,
      {
        tag,
        mode: props.mode,
        tradingsymbol: contract.tradingsymbol,
        side,
        lots,
        price,
        resting: execution === 'Resting',
      },
      Date.now(),
    )
    pressed.current = press
    /**
     * Whether the SERVER answered this attempt, stashed on the way past.
     * `withReauth` flattens a failure to a message string, and "refused" versus
     * "we never heard back" is the whole difference between an id that is spent
     * and one that must be retried under.
     */
    let answered = false
    setBusy(true)
    setResult(null)
    /**
     * The live rail goes through the re-auth prompt (`promptFirst`), so a real
     * order costs a deliberate stop that names what is about to happen — the
     * same shape as recording a live book on the Build page. Paper is asked
     * nothing: it cannot move money.
     */
    await withReauth({
      /**
       * The statement names WHICH OF THE TWO this is, because that is the half
       * of the order an operator can be wrong about without the screen ever
       * disagreeing with them — the size and the price are in front of them,
       * "this opens a new short rather than closing your long" is not.
       */
      statement:
        `Place a manual ${side} of ${lots} lot(s) of ${contract.tradingsymbol} under ${tag} ` +
        `at limit ${priceN}${execution === 'Resting' ? ' (RESTING — never repriced)' : ''} ` +
        `on the LIVE account. This is a real order at the broker.` +
        (intent === null ? '' : ` ${intent.text}`),
      promptFirst: props.mode === 'live',
      run: async () => {
        try {
          return await api.submitOrder({
            tag,
            mode: props.mode,
            clientOrderId: press.clientOrderId,
            instrument: {
              tradingsymbol: contract.tradingsymbol,
              instrumentToken: contract.instrumentToken,
              lotSize: meta.lotSize,
              tickSize: meta.tickSize,
              exchange: meta.exchange,
            },
            side,
            lots: lotsN,
            orderType: 'LIMIT',
            limitPrice: priceN,
            // A manual order sizes exactly as asked. Without this the live rail
            // REPLACES lots with the strategy row's liveLots (api.ts) — the one
            // substitution a by-hand adjustment can never want.
            exactLots: true,
            ...(execution === 'Resting' ? { resting: true } : {}),
            /**
             * THE BRIDGE DERIVES `op` FROM THIS AND NOTHING ELSE. Without it
             * every manual order was an `open`, and an open on a contract the
             * book does not hold creates a leg — so a Sell meant as an exit,
             * aimed at a strike the book turned out not to hold, became a
             * phantom SHORT the supervisor adopted and later flattened for
             * real. Sent only when the book was actually read and actually
             * holds the other side (`classifyExposure`); "probably an exit" is
             * exactly the guess that produced the phantom.
             */
            ...(intent?.kind === 'reduces' ? { reducesExposure: true } : {}),
          })
        } catch (err) {
          // Read the failure HERE, where the error object still exists — see
          // `answered` above — then let it out unchanged so `withReauth` still
          // owns the password retry.
          answered = serverAnswered(err)
          throw err
        }
      },
      reauth: props.reauth,
      // Every branch below is the server having ANSWERED, so the id is spent:
      // the next press is a new order and mints a new one.
      onDone: (res) => {
        pressed.current = null
        // A refusal is a 200 with `accepted: false` — the body names the gate.
        if (!res.accepted) {
          setResult({ kind: 'refused', text: res.reason ?? `refused (${res.status})` })
          return
        }
        if ((res.routedLots ?? 0) < lotsN) {
          // ROUTED, not intended — a partial route reported as done is how a
          // book comes to misstate what it holds (same rule as the Build page).
          setResult({
            kind: 'refused',
            text:
              `Only ${res.routedLots ?? 0} of ${lotsN} lot(s) routed — resolve the remainder ` +
              `at the broker before placing again.`,
          })
          props.onDone?.()
          return
        }
        setResult({
          kind: 'routed',
          text:
            `${side} ${res.routedLots ?? lotsN} lot(s) of ${contract.tradingsymbol} routed as ` +
            `LIMIT @ ${priceN} (${res.status}).`,
        })
        props.onDone?.()
      },
      onError: (message) => {
        if (answered) {
          // The desk read the request and rejected it — nothing routed, and the
          // id it carried is spent.
          pressed.current = null
          setResult({ kind: 'refused', text: message })
          return
        }
        // NOTHING IS KNOWN. `pressed.current` is deliberately left standing, so
        // the obvious response — press Place again — resubmits under the SAME
        // id and the server replays instead of placing a second order.
        setResult({ kind: 'unconfirmed', text: unconfirmedText(message) })
      },
    })
    setBusy(false)
  }

  return (
    <Dialog isOpen={open} onOpenChange={props.onClose} purpose="form" width={560}>
      <Layout
        header={<DialogHeader title={`Manual order · ${tag}`} onOpenChange={props.onClose} />}
        content={
          <LayoutContent>
            <VStack gap={4}>
              {fixed ? (
                <HStack gap={2} align="center" wrap="wrap">
                  <Badge label={`${symbol} · ${expiry}`} />
                  <Badge variant={props.mode === 'live' ? 'error' : 'neutral'} label={props.mode} />
                </HStack>
              ) : (
                <HStack gap={1}>
                  <Selector
                    label="Symbol"
                    hasSearch
                    searchPlaceholder="Filter underlyings…"
                    isLoading={underlyings === null}
                    options={[...(underlyings ?? [])]}
                    value={symbol}
                    placeholder="Choose an underlying…"
                    onChange={setSymbol}
                  />
                  <Selector
                    label="Expiry"
                    isLoading={symbol !== '' && expiries === null}
                    options={[...(expiries ?? [])]}
                    value={expiry}
                    placeholder="Choose an expiry…"
                    onChange={setExpiry}
                  />
                </HStack>
              )}

              {/*
                Books rows only — a hosted strategy has no supervisor. The
                promise DIFFERS BY EXECUTION MODE and the sentence is written
                where that can be tested (`deskBookNote`): an Immediate fill
                creates the book leg at the bridge and the Python driver adopts
                it, a LIVE RESTING one joins nothing at all when it eventually
                trades (a paper one fills as it routes and is booked). Rendered
                as a warning in that case, because it is the operator's last
                chance to pick the other button.
              */}
              {fixed ? (
                restingUnbooked(props.mode, execution) ? (
                  <Text size="sm" weight="medium">{deskBookNote(props.mode, execution)}</Text>
                ) : (
                  <Text size="sm" color="secondary">{deskBookNote(props.mode, execution)}</Text>
                )
              ) : null}

              <Selector
                label="Strike"
                hasSearch
                searchPlaceholder="Filter strikes…"
                isLoading={symbol !== '' && expiry !== '' && chain === null}
                options={rows.map((r) => ({
                  value: String(r.strike),
                  label: `${r.strike} · CE ${ltp(r.CE)} · PE ${ltp(r.PE)}`,
                }))}
                value={strike}
                placeholder={
                  symbol === '' || expiry === '' ? 'Pick symbol and expiry first…' : 'Choose a strike…'
                }
                onChange={setStrike}
              />

              <HStack gap={4} wrap="wrap">
                <Toggle
                  label="Type"
                  options={['CE', 'PE'] as const}
                  value={optType}
                  onChange={setOptType}
                />
                <Toggle
                  label="Side"
                  options={['Buy', 'Sell'] as const}
                  value={side}
                  onChange={setSide}
                />
                <Toggle
                  label="Execution"
                  options={['Immediate', 'Resting'] as const}
                  value={execution}
                  onChange={setExecution}
                />
              </HStack>

              {/* Resting means something different on each rail — see `executionNote`. */}
              <Text size="sm" color="secondary">{executionNote(props.mode, execution)}</Text>

              <HStack gap={1} align="start">
                <TextInput
                  label="Lots"
                  value={lots}
                  onChange={setLots}
                  description={meta === null ? 'lot size unknown yet' : `1 lot = ${meta.lotSize} units`}
                />
                <TextInput
                  label="Limit price"
                  value={price}
                  onChange={(v) => {
                    setPrice(v)
                    // ARMED FOR THIS CONTRACT ONLY. Moving the strike or the
                    // CE/PE toggle disarms it on its own, so a price chosen for
                    // one option can never sit under another.
                    setTypedFor(contractKey(strike, optType))
                    setPriceNote('')
                  }}
                  description={
                    priceNote !== ''
                      ? priceNote
                      : 'Check the depth before placing.'
                  }
                />
              </HStack>

              {contract === undefined ? null : (
                <Text size="sm" color="secondary">
                  {`Contract: ${contract.tradingsymbol}` +
                    (meta === null ? '' : ` · ${meta.exchange} · tick ${meta.tickSize}`)}
                </Text>
              )}

              {/*
                WHICH OF THE TWO THINGS THIS IS — the line the dialog was
                missing. An operator can read the size and the price off their
                own boxes; "this closes your long" versus "this opens a new
                short the supervisor will manage" is only knowable from the
                book, and it is the difference between an exit and a phantom
                leg. The ADD case is the one that surprises people, so it is
                the one in the primary ink.
              */}
              {intent === null ? null : intent.kind === 'reduces' ? (
                <Text size="sm" color="secondary">{intent.text}</Text>
              ) : (
                <Text size="sm" weight="medium">{intent.text}</Text>
              )}

              {/* Why Place is disabled, instead of a button that is merely grey. */}
              {problem !== null && result === null ? (
                <Text size="sm" color="secondary">{problem}</Text>
              ) : null}

              {/*
                THREE OUTCOMES, THREE TITLES. 'Not placed' is a claim only a
                server answer can support; over a transport failure it is the
                sentence that produces a duplicate order, so the unknown case
                says it is unknown and names the safe move.
              */}
              {result !== null ? (
                <Banner
                  status={result.kind === 'routed' ? 'success' : result.kind === 'refused' ? 'error' : 'warning'}
                  title={
                    result.kind === 'routed'
                      ? 'Order routed'
                      : result.kind === 'refused'
                        ? 'Not placed'
                        : 'Not confirmed'
                  }
                  description={result.text}
                />
              ) : null}
            </VStack>
          </LayoutContent>
        }
        footer={
          <LayoutFooter hasDivider>
            <HStack gap={2} justify="end">
              <Button variant="secondary" label="Close" onClick={props.onClose} />
              <Button
                variant={props.mode === 'live' ? 'destructive' : 'primary'}
                label={busy ? 'Placing…' : `Place ${side.toLowerCase()} order`}
                isDisabled={busy || problem !== null}
                onClick={() => void place()}
              />
            </HStack>
          </LayoutFooter>
        }
      />
    </Dialog>
  )
}
