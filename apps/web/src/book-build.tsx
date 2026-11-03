/**
 * BUILD A BOOK — open the structure for real, then register it.
 *
 * The Create wizard SEEDS: it declares "the book holds this" and places
 * nothing, which is right when the position already exists. This screen is the
 * other case — the position does not exist yet and has to be opened.
 *
 * GUIDED, NOT AUTOMATIC. One leg at a time, each confirmed by a person, with
 * the actual fill visible before the next goes out. The alternative — one
 * button that places everything — has to decide alone what to do when leg 3
 * fills and leg 4 does not, and the wrong answer there is a naked short
 * strangle. A human watching each fill needs no such rule.
 *
 * WINGS BEFORE SHORTS, enforced by `entrySequence`. If the shorts fill and a
 * wing does not, the position carries unlimited risk; the reverse only spends
 * premium. The sequence is not merely suggested — the Place button unlocks in
 * order.
 *
 * THE BOOK IS SEEDED FROM WHAT FILLED, never from what was requested. Every
 * P&L, target and scrap decision downstream inherits the entry price.
 *
 * SYMBOL, EXPIRY AND LOT SIZE COME FROM THE INSTRUMENT MASTER, not from an
 * operator's memory — see "THE THREE FIELDS ARE READ FROM THE MASTER" below,
 * and the fallback that keeps the screen usable when the master cannot be read.
 */

import { useEffect, useRef, useState } from 'react'

/**
 * How long to wait for a newly-registered chain to start printing.
 *
 * marketdata re-derives its subscriptions from the books every
 * `DESK_REFRESH_MS` (30s), so ~90s covers a refresh landing just after the
 * registration plus a little slack for the first ticks.
 */
const QUOTE_WAIT_MS = 3_000
const QUOTE_WAIT_TRIES = 30
import { VStack, HStack } from '@astryxdesign/core/Layout'
import { Card } from '@astryxdesign/core/Card'
import { Text, Heading } from '@astryxdesign/core/Text'
import { Badge } from '@astryxdesign/core/Badge'
import { Banner } from '@astryxdesign/core/Banner'
import { Button } from '@astryxdesign/core/Button'
import { TextInput } from '@astryxdesign/core/TextInput'
import { Selector } from '@astryxdesign/core/Selector'
import { PRESETS } from '@algomaker/desk-engine/presets'
import { api, explain, type DeskMode } from './api.ts'
import { presetDials } from './dials-plan.ts'
import { useAsync } from './shell.tsx'
import { useReauth, withReauth } from './auth.tsx'
import {
  entrySequence,
  entryState,
  seedLegsFromFills,
  sideOf,
  suggestFromQuote,
  type EntryLeg,
  type EntryState,
  type PlacedFill,
} from './entry-plan.ts'
import { VENUE, exchangeOf, isOnStep, lotsOf } from './venue.ts'
import { deltaSymbol } from './contract.ts'

/** `1070CE -3000` per line — the same shape the seed file uses. */
function parseLegs(text: string, symbol: string, expiry: string): EntryLeg[] {
  const monthCode = expiry.slice(0, 7)
  return text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '')
    .map((line) => {
      // The quantity may carry decimals: on DX it is BTC on a 0.001 grid
      // (`76600CE -0.05`). Off the venue's step it is refused, never rounded.
      const m = /^(\d+(?:\.\d+)?)\s*(CE|PE)\s+(-?\d+(?:\.\d+)?)$/i.exec(line)
      if (m === null) throw new Error(`cannot read "${line}" — expected e.g. "1070CE -3000"`)
      const strike = Number(m[1])
      const type = (m[2] ?? '').toUpperCase() as 'CE' | 'PE'
      const qty = Number(m[3])
      if (!isOnStep(qty, VENUE.qtyStep)) {
        throw new Error(`"${line}": ${m[3]} is not a multiple of the quantity step ${VENUE.qtyStep}`)
      }
      return {
        strike,
        type,
        qty,
        // Resolved properly against the master before anything is placed; this
        // is only a provisional label for the review list.
        tradingsymbol: VENUE.id === 'dx'
          ? deltaSymbol(symbol, strike, type, expiry)
          : `${symbol}${monthCode}${strike}${type}`,
        instrumentToken: 0,
      }
    })
}

/**
 * The three master-backed fields, and what each of them knows about itself.
 *
 * Handed around as ONE value rather than ten props: symbol, expiry and lot size
 * are not three independent boxes, they are one lookup — the expiry list is the
 * symbol's, and the lot size is the pair's — and splitting them at a component
 * boundary is what would let a caller pass a symbol from one render with an
 * expiry list from another.
 */
interface ChainMaster {
  readonly symbol: string
  readonly setSymbol: (v: string) => void
  readonly expiry: string
  readonly setExpiry: (v: string) => void
  readonly underlyings: readonly string[] | null
  readonly symbolsUnavailable: boolean
  readonly expiries: readonly string[] | null
  readonly expiriesUnavailable: boolean
  readonly lotSize: string
  readonly setLotSize: (v: string) => void
}

/**
 * THE THREE FIELDS ARE READ FROM THE MASTER.
 *
 * Symbol and expiry used to be free text, and a typo in either did not fail
 * where it was made. `BAJFINANC` reached the master as a lookup and came back
 * "no listed expiries for 'BAJFINANC'"; a stale expiry came back "no chain
 * for BAJFINANCE 2026-07-28". Both read like the feed is behind rather than
 * like the name is wrong, and both arrive three steps later, at Resolve. A
 * list of what actually lists cannot be mistyped.
 *
 * Lot size is loaded here for the same reason it was wrong before: it was a
 * hardcoded 750 until Resolve overwrote it from the master, so between
 * opening the screen and pressing Resolve the number on display belonged to
 * whichever book the default was copied from. It divides the leg quantity
 * into `lots` at Place time — a wrong one is a wrong ORDER SIZE, not a
 * cosmetic slip — so it is filled the moment symbol and expiry are known.
 *
 * `null` means the request has not answered yet; `[]` means it answered with
 * nothing, or failed. The two are separate because the first renders a
 * loading picker and the second renders the text box the picker replaced —
 * see the fallback note at the fields themselves.
 *
 * THE FIELDS THEMSELVES LIVE IN HERE, not above it, because the listing is what
 * CORRECTS the expiry when the symbol moves. A hook that only reported the
 * lists would have to hand that correction back to its caller, and the caller
 * would then own half of a rule whose other half it cannot see.
 */
function useChainMaster(defaults: {
  symbol: string
  expiry: string
  lotSize: string
}): ChainMaster {
  const [symbol, setSymbol] = useState(defaults.symbol)
  const [expiry, setExpiry] = useState(defaults.expiry)
  const [lotSize, setLotSize] = useState(defaults.lotSize)
  const [underlyings, setUnderlyings] = useState<readonly string[] | null>(null)
  const [symbolsUnavailable, setSymbolsUnavailable] = useState(false)
  const [expiries, setExpiries] = useState<readonly string[] | null>(null)
  const [expiriesUnavailable, setExpiriesUnavailable] = useState(false)

  useAsync(
    () => api.underlyings(),
    (list) => {
      setUnderlyings(list)
      setSymbolsUnavailable(list.length === 0)
    },
    () => {
      // Fail-soft, deliberately: the master is synced by a separate process
      // and its being unreachable is not a reason an operator cannot open a
      // position they can already see at the broker. The field falls back to
      // free text — which is exactly what this screen had before.
      setUnderlyings([])
      setSymbolsUnavailable(true)
    },
    [],
  )

  /**
   * The expiries listed FOR THIS SYMBOL, re-read whenever the symbol changes.
   *
   * Asked WITHOUT an `expiry` on purpose. When this runs after a symbol change
   * the `expiry` state still holds the previous symbol's, and a pair that does
   * not list is a 404 rather than a correction. The expiry-less form answers
   * with the first listed one, which is also the right default.
   */
  useAsync(
    symbol === ''
      ? null
      : () => {
          // Back to "loading" before the request goes out: the previous
          // symbol's dates must not stay pickable while their replacement is
          // in flight.
          setExpiries(null)
          return api.instruments(symbol)
        },
    (listing) => {
      setExpiries(listing.expiries)
      setExpiriesUnavailable(listing.expiries.length === 0)
      // An expiry the operator already chose SURVIVES a symbol change when
      // the new symbol lists it too — most stocks share the monthly date, and
      // resetting it every time would undo a deliberate choice.
      setExpiry((cur) => (listing.expiries.includes(cur) ? cur : (listing.expiries[0] ?? '')))
    },
    () => {
      setExpiries([])
      setExpiriesUnavailable(true)
    },
    [symbol],
  )

  /**
   * The lot size for the exact pair on screen.
   *
   * Runs on the symbol too, not only the expiry: two symbols very often share
   * an expiry date, so keying this on `expiry` alone would leave the PREVIOUS
   * symbol's lot size in the box after a switch — silently, and it is the
   * divisor that decides order size. The one throwaway request that costs (the
   * new symbol against the old expiry, immediately after a symbol change) 404s
   * and is discarded; the effect re-runs with the corrected pair the moment the
   * listing above lands.
   */
  useAsync(
    symbol === '' || expiry === '' ? null : () => api.instruments(symbol, expiry),
    (meta) => setLotSize(String(meta.lotSize)),
    () => {
      // Nothing to say here: the box keeps whatever it holds and stays
      // typeable, and Resolve reads the lot size from the master again before
      // anything can be placed.
    },
    [symbol, expiry],
  )

  return {
    symbol,
    setSymbol,
    expiry,
    setExpiry,
    underlyings,
    symbolsUnavailable,
    expiries,
    expiriesUnavailable,
    lotSize,
    setLotSize,
  }
}

/**
 * STEP 1 — what the structure IS, before anything can be placed.
 *
 * Everything on this card is still editable: nothing has gone to the broker
 * yet, and the tag under the button is the whole screen's identity, shown
 * while it can still be changed rather than after the first order carries it.
 */
function StructureCard(props: {
  master: ChainMaster
  preset: string
  setPreset: (v: string) => void
  suffix: string
  setSuffix: (v: string) => void
  targetPnl: string
  setTargetPnl: (v: string) => void
  marginCap: string
  setMarginCap: (v: string) => void
  legText: string
  setLegText: (v: string) => void
  tag: string
  busy: string | null
  onResolve: () => void
}): React.ReactElement {
  const {
    symbol,
    setSymbol,
    expiry,
    setExpiry,
    lotSize,
    setLotSize,
    underlyings,
    symbolsUnavailable,
    expiries,
    expiriesUnavailable,
  } = props.master
  return (
    <Card>
      <VStack gap={1}>
        <Heading level={3}>1 · The structure</Heading>
        {/*
          THE FALLBACK IS A TEXT BOX, NOT A BLOCKED SCREEN.

          When the master cannot be listed each picker degrades to the free
          text field it replaced, rather than leaving the operator with an
          empty dropdown and no way past it. The master is synced by a
          separate process; it being behind must not stop someone recording a
          structure they are about to open at the broker regardless.
        */}
        <HStack gap={1}>
          {symbolsUnavailable ? (
            <TextInput
              label="Symbol"
              value={symbol}
              onChange={(v) => setSymbol(v.toUpperCase())}
              description="The instrument master could not be listed — type the underlying exactly as it lists."
            />
          ) : (
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
          )}
          {expiriesUnavailable ? (
            <TextInput
              label="Expiry"
              value={expiry}
              onChange={setExpiry}
              description={`No listed expiries came back for ${symbol} — type one as YYYY-MM-DD.`}
            />
          ) : (
            <Selector
              label="Expiry"
              isLoading={expiries === null}
              options={[...(expiries ?? [])]}
              value={expiry}
              placeholder="Choose an expiry…"
              onChange={setExpiry}
            />
          )}
          {/*
            THE PRESET COMES FROM CODE, not from a published catalogue.

            It used to be read from `GET /v1/desk/variants` — the Python
            supervisor's own `list_variants()` — which meant this field could
            fail to load, could offer a variant the deployed supervisor did not
            implement, and degraded to a text box nobody could check.
            `packages/desk-engine` ships the twelve dial-sets now (spec §5), so
            the list is always right, always available, and its values are the
            ones the book is actually created with.
          */}
          <Selector
            label="Preset"
            options={PRESETS.map((p) => ({ value: p.key, label: `${p.key} (${p.label})` }))}
            value={props.preset}
            placeholder="Choose a preset…"
            onChange={props.setPreset}
          />
          <TextInput
            label="Tag suffix (optional)"
            value={props.suffix}
            onChange={props.setSuffix}
            placeholder="2"
          />
        </HStack>
        <HStack gap={1}>
          {/*
            Still typeable: the master answering is what fills this, and if it
            does not the operator has to be able to state the lot size rather
            than place at whatever number happened to be here.
          */}
          <TextInput
            label="Lot size"
            value={lotSize}
            onChange={setLotSize}
            description="From the instrument master for this symbol and expiry."
          />
          {/* Both are real dials: typed here they OVERRIDE the preset's own,
              and land on the row with the rest of its dial-set. */}
          <TextInput
            label="target_pnl" value={props.targetPnl} onChange={props.setTargetPnl}
            description="Overrides the preset's."
          />
          <TextInput
            label="margin_cap" value={props.marginCap} onChange={props.setMarginCap}
            description="Overrides the preset's."
          />
        </HStack>
        <Text size="sm" color="secondary">
          One leg per line, as `1070CE -3000` — negative is short, quantity in contracts.
        </Text>
        <textarea
          value={props.legText}
          onChange={(e) => props.setLegText(e.target.value)}
          rows={5}
          style={{ width: '100%', fontFamily: 'monospace', fontSize: 13, padding: 8 }}
        />
        <HStack gap={1}>
          <Button
            label={props.busy === 'prepare' ? 'Resolving…' : 'Resolve legs'}
            onClick={props.onResolve}
            isDisabled={props.busy !== null}
          />
          <Text size="sm" color="secondary">{`tag: ${props.tag}`}</Text>
        </HStack>
      </VStack>
    </Card>
  )
}

/**
 * STEP 2 — the registry row and its switch, both BEFORE any order.
 *
 * The two buttons are deliberately separate: registering creates the tag, and
 * switching it on is what makes it able to trade. Collapsing them into one
 * would make creating a book a trading permission, which is the exact thing
 * `addStrategyMode` writes `{enabled: false}` to prevent.
 *
 * ONE EXCEPTION, on the server side: a registry create whose PAPER mode did
 * not exist before lands it switched ON (`routes/books.ts`, spec E3 — a fresh
 * daily paper book born off decides all day and fills nothing). So a paper
 * book this screen registers arrives on — whether the row is brand new or
 * already traded live — and the switch button below is then a no-op for it; a
 * live mode is still added OFF behind its password, and a paper mode that was
 * already on the row keeps whatever the operator set. The `enabled` state
 * below starts false regardless — cosmetic.
 */
function RegisterCard(props: {
  mode: DeskMode
  busy: string | null
  registered: boolean
  enabled: boolean
  onRegister: () => void
  onEnable: () => void
}): React.ReactElement {
  return (
    <Card>
      <VStack gap={1}>
        <Heading level={3}>2 · Register the book</Heading>
        <Text size="sm" color="secondary">
          Creates the registry row and its strategy row — `desired: stopped`, LIVE off. Nothing
          trades. An order for an unregistered tag is refused outright, so this comes first.
        </Text>
        <HStack gap={1} align="center">
          <Button
            label={
              props.busy === 'register'
                ? 'Registering…'
                : props.registered
                  ? 'Registered'
                  : 'Register'
            }
            isDisabled={props.busy !== null || props.registered}
            onClick={props.onRegister}
          />
          {props.registered ? <Badge variant="success" label="registered" /> : null}
        </HStack>

        {props.registered ? (
          <>
            <Text size="sm" color="secondary">
              Registering adds the rail but leaves it SWITCHED OFF — creating a book is never
              itself a trading permission. Switch it on to place.
            </Text>
            {props.mode === 'live' ? (
              <Banner
                status="info"
                title="Switch it on for LIVE on the Strategies page"
                description="Enabling the live rail is password-gated and deliberately not offered here."
              />
            ) : (
              <HStack gap={1} align="center">
                <Button
                  label={
                    props.busy === 'enable'
                      ? 'Switching on…'
                      : props.enabled
                        ? 'Switched on'
                        : 'Switch on for paper'
                  }
                  isDisabled={props.busy !== null || props.enabled}
                  onClick={props.onEnable}
                />
                {props.enabled ? <Badge variant="success" label="ready to place" /> : null}
              </HStack>
            )}
          </>
        ) : null}
      </VStack>
    </Card>
  )
}

/**
 * STEP 3 — one leg, one confirmation, in the order `entrySequence` fixed.
 *
 * THE ONLY PLACE ON THIS SCREEN THAT SENDS AN ORDER. Every guard the sequence
 * depends on is on the one button — it is next, the tag is registered, and the
 * rail is switched on — so there is no second path to a Place that skipped a
 * wing.
 */
function PlaceCard(props: {
  mode: DeskMode
  legs: readonly EntryLeg[]
  fills: readonly PlacedFill[]
  state: EntryState
  limits: Record<string, string>
  onLimit: (tradingsymbol: string, value: string) => void
  noQuote: Record<string, string>
  busy: string | null
  quoteWait: number
  registered: boolean
  enabled: boolean
  onPlace: (leg: EntryLeg) => void
}): React.ReactElement {
  const done = new Set(props.fills.map((f) => f.tradingsymbol))
  const nextToPlace = props.legs.find((l) => !done.has(l.tradingsymbol))
  return (
    <Card>
      <VStack gap={1}>
        <HStack gap={1} align="center">
          <Heading level={3}>3 · Place, wings first</Heading>
          <Badge label={`${props.fills.length}/${props.legs.length} filled`} />
          {props.quoteWait > 0 ? <Badge variant="warning" label="fetching prices…" /> : null}
        </HStack>

        {/*
          WHY THE BOXES ARE EMPTY, said out loud.

          A first registration is what subscribes this chain, and the feed
          only re-reads the books every 30s — so every leg legitimately
          reads "no quote yet" for up to a minute afterwards. Without this
          line that is indistinguishable from a broken screen, which is
          exactly how it was reported.
        */}
        {props.quoteWait > 0 ? (
          <Banner
            status="info"
            title="Waiting for the feed to pick up this chain"
            description={
              `Registering is what subscribes it, so the first prices take up to a minute ` +
              `to arrive (checking, attempt ${props.quoteWait}). You can type a limit yourself at ` +
              `any time — check the depth first.`
            }
          />
        ) : null}

        {props.state.nakedShorts.length > 0 ? (
          <Banner
            status="error"
            title="A short is filled with no wing behind it"
            description={`${props.state.nakedShorts
              .map((l) => `${l.strike}${l.type}`)
              .join(', ')} — unlimited risk. Place the wing or unwind at the broker.`}
          />
        ) : null}

        {props.legs.map((l) => {
          const filled = done.has(l.tradingsymbol)
          const isNext = nextToPlace?.tradingsymbol === l.tradingsymbol
          const fill = props.fills.find((f) => f.tradingsymbol === l.tradingsymbol)
          return (
            <HStack key={l.tradingsymbol} gap={1} align="center">
              <Badge
                variant={filled ? 'success' : sideOf(l) === 'Buy' ? 'neutral' : 'warning'}
                label={sideOf(l)}
              />
              <Text size="sm">{`${l.strike}${l.type}  ${l.qty}`}</Text>
              {filled ? (
                <Text size="sm" color="secondary">{`filled @ ${fill?.price}`}</Text>
              ) : (
                <>
                  <TextInput
                    label="Limit"
                    value={props.limits[l.tradingsymbol] ?? ''}
                    onChange={(v) => props.onLimit(l.tradingsymbol, v)}
                  />
                  {props.noQuote[l.tradingsymbol] === undefined ? null : (
                    <Text size="sm" color="secondary">{props.noQuote[l.tradingsymbol]}</Text>
                  )}
                  <Button
                    label={props.busy === l.tradingsymbol ? 'Placing…' : 'Place'}
                    variant={isNext ? 'primary' : 'ghost'}
                    // Strictly in sequence: a wing cannot be skipped to get
                    // to a short.
                    isDisabled={
                      props.busy !== null ||
                      !isNext ||
                      !props.registered ||
                      (props.mode === 'paper' && !props.enabled)
                    }
                    onClick={() => props.onPlace(l)}
                  />
                </>
              )}
            </HStack>
          )
        })}
      </VStack>
    </Card>
  )
}

export function BookBuildPage(props: { mode: DeskMode }): React.ReactElement {
  const master = useChainMaster(VENUE.id === 'dx'
    ? { symbol: 'BTC', expiry: '', lotSize: String(VENUE.qtyStep) }
    : { symbol: 'BAJFINANCE', expiry: '2026-08-25', lotSize: '750' })
  // The fields themselves are the card's business; what the page still needs is
  // the pair every request is keyed on, and the divisor Place sizes from.
  const { symbol, expiry, lotSize, setLotSize } = master

  /**
   * THE PRESET IS PICKED FROM CODE, and it is a PREFILL, not a pointer.
   *
   * This was a poll of `GET /v1/desk/variants` — the Python supervisor's own
   * `list_variants()` — and it carried three problems the preset list does
   * not: the field could fail to load (and degraded to a text box nobody could
   * check), it could offer a key the deployed supervisor did not implement,
   * and the row it created named a playbook that lived somewhere else
   * entirely. `packages/desk-engine` ships the twelve historical dial-sets, so
   * the picker is always available and always right.
   *
   * WHAT THE ROW GETS IS THE NUMBERS. The preset's dials are copied onto the
   * book at creation and `variant` records the preset's key as a LABEL (spec
   * §11 — the field is read-compatible, so every existing row and every reader
   * of it still works). Nothing looks the preset up again afterwards: what the
   * engine reads is the book's own dials, which is what makes the Dials panel
   * able to say which of them somebody has since changed.
   */
  const [preset, setPreset] = useState('recenter-r')
  /**
   * An optional suffix on the tag, for REBUILDING A STRUCTURE THE SAME DAY.
   *
   * Trades, decisions and P&L are keyed by TAG, not by book, so they survive a
   * book being deleted and the next book on the same tag inherits them —
   * rebuild BHEL after a losing round trip and the new book's P&L starts at
   * that loss. Since the tag is `symbol-expiry-variant`, rebuilding the same
   * structure on the same day necessarily reuses it, and there was no way to
   * ask for a clean one short of inventing a variant that does not exist.
   *
   * Empty by default: the plain tag is the right one the first time, and a
   * suffix nobody asked for would make every book's name harder to read.
   */
  const [suffix, setSuffix] = useState('')
  const [legText, setLegText] = useState('1150CE 3000\n960PE 3000\n1070CE -3000\n1030PE -3000')
  const [targetPnl, setTargetPnl] = useState('60000')
  const [marginCap, setMarginCap] = useState('5000000')

  const [legs, setLegs] = useState<readonly EntryLeg[] | null>(null)
  const [fills, setFills] = useState<readonly PlacedFill[]>([])
  const [limits, setLimits] = useState<Record<string, string>>({})
  /** Why a leg has no suggested price. Shown in place of one. */
  const [noQuote, setNoQuote] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [registered, setRegistered] = useState(false)
  /** Poll attempt number while waiting for the feed to pick up the chain; 0 = not waiting. */
  const [quoteWait, setQuoteWait] = useState(0)
  /**
   * Set on unmount so a poll in flight stops touching state.
   *
   * The one thing on this screen `useAsync` cannot cover: `waitForQuotes` is a
   * loop STARTED BY A BUTTON, not a read keyed on deps, so there is no effect
   * whose cleanup could carry the flag. Every other read here goes through the
   * hook and has no flag of its own.
   */
  const cancelled = useRef(false)
  useEffect(() => {
    cancelled.current = false
    return () => {
      cancelled.current = true
    }
  }, [])
  const [enabled, setEnabled] = useState(false)
  const [built, setBuilt] = useState<string | null>(null)
  // The password prompt, for the one call on this screen the server
  // re-authenticates: recording a LIVE book's legs. Rendered once at the
  // bottom, the same shape the Books and Strategies pages use.
  const reauth = useReauth()

  /**
   * Trimmed, and joined with the same `-` the rest of the tag uses. A stray
   * space would be rejected by `validateBookCreate`'s tag rule — which exists
   * because the tag is the order-bus namespace — several steps later, with an
   * error naming the whole tag rather than the box that caused it.
   */
  const tag = [symbol, expiry, preset, suffix.trim()].filter((p) => p !== '').join('-')
  const state = legs === null ? null : entryState(legs, fills)

  /** Resolve every leg against the master, and pre-fill marketable limits. */
  const prepare = async (): Promise<void> => {
    setError(null)
    setBusy('prepare')
    try {
      const parsed = parseLegs(legText, symbol, expiry)
      const meta = await api.instruments(symbol, expiry)
      const chain = await api.chain(symbol, expiry)

      // THE CONTRACT COMES FROM THE MASTER, never from string-building here.
      // A client guessing at the exchange's month code is a silent
      // wrong-instrument bug waiting for the one month the format differs.
      const resolved = parsed.map((l) => {
        const row = (chain.rows ?? []).find((r) => r.strike === l.strike)
        const contract = l.type === 'CE' ? row?.ceContract : row?.peContract
        if (contract === undefined) {
          throw new Error(
            `${l.strike}${l.type} is not listed for ${symbol} ${expiry} — check the strike`,
          )
        }
        return {
          ...l,
          tradingsymbol: contract.tradingsymbol,
          instrumentToken: contract.instrumentToken,
        }
      })
      const ordered = entrySequence(resolved)
      setLegs(ordered)
      setLotSize(String(meta.lotSize))

      /**
       * Suggest a marketable limit ONLY from a fresh quote.
       *
       * The suggestion crosses relative to the LAST TRADED price — the chain
       * carries no bid/ask — so on a wide spread it may not cross at all. And
       * a price derived from a stale print is worse than an empty box: the box
       * sends an operator to look at the depth, the number invites a click.
       * Where there is no usable quote the reason is shown instead.
       */
      applyQuotes(ordered, chain, meta.tickSize)
    } catch (e) {
      setError(explain(e))
    } finally {
      setBusy(null)
    }
  }

  /**
   * Re-derive every leg's suggested limit from a chain snapshot. Returns how
   * many legs still have NO usable quote, which is what the poll below waits on.
   *
   * A leg the operator has already typed a price into is left ALONE. A later
   * tick overwriting a number someone chose by reading the depth would be the
   * worst kind of helpful.
   */
  const applyQuotes = (
    ordered: readonly EntryLeg[],
    chain: Awaited<ReturnType<typeof api.chain>>,
    tickSize: number,
  ): number => {
    const next: Record<string, string> = {}
    const why: Record<string, string> = {}
    let missing = 0
    for (const l of ordered) {
      const row = (chain.rows ?? []).find((r) => r.strike === l.strike)
      const q = l.type === 'CE' ? row?.CE : row?.PE
      const s = suggestFromQuote(sideOf(l), q, { tickSize })
      if (s.price !== null) next[l.tradingsymbol] = String(s.price)
      else {
        why[l.tradingsymbol] = s.reason
        missing++
      }
    }
    setLimits((prev) => {
      const merged = { ...next }
      for (const [k, v] of Object.entries(prev)) if (v !== '') merged[k] = v
      return merged
    })
    setNoQuote(why)
    return missing
  }

  /**
   * WAIT FOR THE FEED TO PICK UP THIS CHAIN, visibly.
   *
   * A brand-new book's chain is not subscribed until it is registered: the
   * feed derives its token set from the books, and marketdata re-reads them on
   * `DESK_REFRESH_MS` (30s by default), after which ticks have to actually
   * arrive. So on a FIRST registration every leg reads "no quote yet" for up to
   * a minute, through no fault of the operator's — and a screen that just sits
   * there showing that is indistinguishable from one that is broken. This says
   * which it is.
   *
   * Stops on the first pass where every leg has a price, and gives up after
   * `QUOTE_WAIT_TRIES` rather than polling forever — an illiquid strike that
   * has genuinely not traded will never print, and at that point the empty box
   * and its reason ARE the right answer.
   */
  const waitForQuotes = async (ordered: readonly EntryLeg[]): Promise<void> => {
    const meta = await api.instruments(symbol, expiry)
    for (let attempt = 1; attempt <= QUOTE_WAIT_TRIES; attempt++) {
      if (cancelled.current) return
      setQuoteWait(attempt)
      try {
        const chain = await api.chain(symbol, expiry)
        if (cancelled.current) return
        if (applyQuotes(ordered, chain, meta.tickSize) === 0) break
      } catch {
        // Fail-soft: a single failed poll must not kill the wait, and the
        // operator can always type a price by hand regardless.
      }
      await new Promise((r) => setTimeout(r, QUOTE_WAIT_MS))
    }
    if (!cancelled.current) setQuoteWait(0)
  }

  /**
   * REGISTER BEFORE PLACING — an order for an unregistered tag is refused with
   * "add it to desk-strategies before it can trade", because the registry POST
   * is what CREATES that strategy row. Registering first also means the tag has
   * a switch in the portal from the moment anything can trade under it, which
   * is the reason `UnknownStrategy` is a hard 403 rather than a skip.
   *
   * Registering trades nothing: the row is created `desired: stopped` with LIVE
   * switched off, whatever is asked for.
   */
  const register = async (): Promise<void> => {
    setError(null)
    setBusy('register')
    try {
      await api.bookRegistry.create({
        tag,
        symbol,
        expiry,
        mode: props.mode,
        // The preset's key, as the row's label. `variant` is the field's
        // historical name and stays it — every reader of a registry row, the
        // Books page included, keys on it (spec §11, read-compatible).
        variant: preset,
        /*
          THE PRESET'S WHOLE DIAL-SET GOES ON THE ROW, not just the three boxes
          on screen. A row carrying only `target_pnl` would resolve every other
          dial against the ENGINE DEFAULT — which is the relief-r live set — so
          a book created as `recenter-r` would silently run relief's
          margin-gated shift. Copying the preset in is what makes the row a
          complete statement of what the book does.

          `lot_size` IS NOT WRITTEN, as of the D9 cutover. It was never an
          engine dial; it was here because the Python supervisor read it, and
          that supervisor is gone. What it left behind was a permanent F-29
          warning on every book this screen created — "Stored on this book, and
          not read by the engine: lot_size" — which is precisely the banner that
          has to stay meaningful, because the next thing it says will be a real
          retired dial or a real typo. A banner that is always on is a banner
          nobody reads.

          Nothing needed it: the lot size comes off the CHAIN (`useChainMaster`
          reads it from the instrument master with the expiry), which is where
          the leg sizing below already takes it from.

          The two boxes are folded in LAST so what the operator typed wins over
          the preset's own figures.
        */
        dials: {
          ...(presetDials(preset) ?? {}),
          target_pnl: Number(targetPnl),
          margin_cap: Number(marginCap),
        },
      })
      setRegistered(true)
      /**
       * Registering is what SUBSCRIBES this chain, so it is also the moment
       * the quotes start coming. Kick the wait off here rather than making the
       * operator press Resolve again and guess at how long to leave it.
       */
      if (legs !== null) void waitForQuotes(legs)
    } catch (e) {
      /**
       * A 409 is NOT "already there, which is exactly the state we want" — that
       * assumption is what made this step lie.
       *
       * Registering writes TWO records, the registry row and the strategy row,
       * and the server used to refuse on the first without ever reaching the
       * second. Swallowing that as success reported "registered" over a tag
       * that had no switch, and step 3 then refused with "is not added to
       * paper". The server now converges an identical re-register and returns
       * 200, so reaching this branch at all means a REAL conflict — a different
       * book already holds the tag — and the operator has to see it.
       */
      setError(explain(e))
    } finally {
      setBusy(null)
    }
  }

  /**
   * SWITCH THE TAG ON FOR THIS RAIL.
   *
   * Registering ADDS the mode — `addStrategyMode` writes `{enabled: false}`
   * deliberately, so adding a mode is never itself a trading permission —
   * and a registry create then turns a NEW paper row on (see `RegisterCard`).
   * For a row that already existed, or a live one, the switch stays as it
   * was, and without this step the first order is refused with "switched off
   * for <mode>".
   *
   * Paper can be switched on from here: `routes/desk.ts` gates only
   * `modes.live` behind a password, because turning paper on "cannot move
   * money". LIVE is deliberately NOT offered here — it needs the password and
   * belongs on the Strategies page, where that prompt lives.
   */
  const enableForMode = async (): Promise<void> => {
    setError(null)
    setBusy('enable')
    try {
      await api.patchStrategy(tag, { modes: { [props.mode]: { enabled: true } } })
      setEnabled(true)
    } catch (e) {
      setError(explain(e))
    } finally {
      setBusy(null)
    }
  }

  const place = async (leg: EntryLeg): Promise<void> => {
    setError(null)
    setBusy(leg.tradingsymbol)
    try {
      const limit = Number(limits[leg.tradingsymbol])
      if (!Number.isFinite(limit) || limit <= 0) throw new Error('enter a limit price first')
      // Snapped: 0.57 BTC / 0.001 is 569.999… in floats, and that is 570 contracts.
      const lots = lotsOf(Math.abs(leg.qty), Number(lotSize))
      const res = await api.submitOrder({
        tag,
        mode: props.mode,
        clientOrderId: `entry-${tag}-${leg.tradingsymbol}`,
        instrument: {
          tradingsymbol: leg.tradingsymbol,
          instrumentToken: leg.instrumentToken,
          lotSize: Number(lotSize),
          tickSize: VENUE.defaultTick,
          exchange: exchangeOf(VENUE),
        },
        side: sideOf(leg),
        lots,
        orderType: 'LIMIT',
        limitPrice: limit,
        // Spec §7.4: a positional book sizes from its seed, never from
        // liveLots — a condor may carry 2-lot wings against 4-lot shorts.
        exactLots: true,
        /**
         * A BUILD ENTRY IS THE OPERATOR'S PRICE BY DEFINITION — THE CHASER
         * MUST STAND DOWN.
         *
         * The box above is suggested from the last print and then read against
         * the depth by hand (this screen says so in its own subtitle): a wing
         * bid deliberately under the touch is the whole technique of opening a
         * structure without paying the spread four times. The gateway's order
         * chaser exists for the opposite case — a marketable limit that missed
         * the touch — and it cannot tell them apart, so left unmarked it walks
         * this bid through the market in escalating steps (3% x 3 attempts,
         * order-chaser.ts) and the operator's chosen entry becomes ~9% worse.
         *
         * `resting: true` is the flag that says "this price was chosen, not
         * computed" (contract.ts `Fill.resting`), and it also stops the desk
         * booking the leg optimistically at route time — correct here, since a
         * bid that may sit for an hour is not a fill, and Record below writes
         * the book from what ACTUALLY filled anyway.
         */
        resting: true,
      })
      if (!res.accepted) throw new Error(res.reason ?? `refused (${res.status})`)
      if ((res.routedLots ?? 0) < lots) {
        // ROUTED, not intended: a partial route is invisible in `intendedLots`,
        // and seeding as though it were whole would misstate the book.
        throw new Error(
          `only ${res.routedLots} of ${lots} lots routed — resolve at the broker before continuing`,
        )
      }
      setFills((f) => [...f, { tradingsymbol: leg.tradingsymbol, price: limit, qty: leg.qty }])
    } catch (e) {
      setError(explain(e))
    } finally {
      setBusy(null)
    }
  }

  const build = async (): Promise<void> => {
    if (legs === null) return
    setError(null)
    setBusy('build')
    try {
      // The row already exists (registered before placing); this only records
      // WHAT IT HOLDS, at the prices that actually filled.
      const seedLegs = seedLegsFromFills(legs, fills)
      /**
       * RECORDING A LIVE BOOK'S LEGS COSTS THE PASSWORD (F-30).
       *
       * This step routes nothing — it writes what the desk believes the account
       * holds, which every exit, delta and live P&L is then computed from — and
       * the server re-authenticates it on the live rail. Asking HERE matters
       * more than anywhere else on this screen: by this point the entry orders
       * have already gone to the broker, so a refusal the operator cannot
       * satisfy would leave a real position with no book behind it.
       *
       * `promptFirst` mirrors the server's condition exactly; a paper build is
       * asked for nothing, as it always was.
       */
      await withReauth({
        statement:
          `Record ${tag}'s legs on the LIVE book. This is what the desk will believe the live ` +
          `account holds — every exit, delta and P&L on the live rail is computed from it.`,
        promptFirst: props.mode === 'live',
        run: (password) => api.seed({
          tag, symbol, expiry, mode: props.mode, replace: false, legs: seedLegs,
          ...(password === undefined ? {} : { password }),
        }),
        reauth,
        onDone: () => setBuilt(tag),
        onError: (message) => setError(message),
      })
    } catch (e) {
      setError(explain(e))
    } finally {
      setBusy(null)
    }
  }

  return (
    <VStack gap={2}>
      <Heading level={2}>Build a book</Heading>
      <Text size="sm" color="secondary">
        Opens the structure for real, then registers the book from what actually filled. Wings are
        placed before shorts, one leg at a time — the Create wizard only declares a position that
        already exists. Suggested limits cross relative to the LAST TRADED price (the feed carries
        no bid/ask), so check them against the depth before placing.
      </Text>

      {props.mode === 'live' ? (
        <Banner
          status="warning"
          title="This places REAL orders on the live account"
          description="Each Place button sends an order to the broker. Nothing is reversible from this screen."
        />
      ) : null}

      {error !== null ? <Banner status="error" title="Stopped" description={error} /> : null}

      {built !== null ? (
        <Banner
          status="success"
          title={`Book ${built} created`}
          description="It starts STOPPED. Switch the tag on for LIVE on the Strategies page, then start it from Books."
        />
      ) : null}

      <StructureCard
        master={master}
        preset={preset}
        setPreset={setPreset}
        suffix={suffix}
        setSuffix={setSuffix}
        targetPnl={targetPnl}
        setTargetPnl={setTargetPnl}
        marginCap={marginCap}
        setMarginCap={setMarginCap}
        legText={legText}
        setLegText={setLegText}
        tag={tag}
        busy={busy}
        onResolve={() => void prepare()}
      />

      {legs === null ? null : (
        <RegisterCard
          mode={props.mode}
          busy={busy}
          registered={registered}
          enabled={enabled}
          onRegister={() => void register()}
          onEnable={() => void enableForMode()}
        />
      )}

      {legs === null || state === null ? null : (
        <PlaceCard
          mode={props.mode}
          legs={legs}
          fills={fills}
          state={state}
          limits={limits}
          onLimit={(tradingsymbol, value) => setLimits((m) => ({ ...m, [tradingsymbol]: value }))}
          noQuote={noQuote}
          busy={busy}
          quoteWait={quoteWait}
          registered={registered}
          enabled={enabled}
          onPlace={(l) => void place(l)}
        />
      )}

      {state === null ? null : (
        <Card>
          <VStack gap={1}>
            <Heading level={3}>4 · Record what it holds</Heading>
            {state.canBuild ? (
              <Text size="sm" color="secondary">
                All legs filled. The book will be seeded at the prices that actually filled.
              </Text>
            ) : (
              <Text size="sm" color="secondary">
                {`${state.outstanding.length} leg(s) still outstanding — a book is only created from a complete structure.`}
              </Text>
            )}
            <Button
              label={busy === 'build' ? 'Recording…' : 'Record the book'}
              isDisabled={!state.canBuild || busy !== null || built !== null}
              onClick={() => void build()}
            />
          </VStack>
        </Card>
      )}

      {reauth.dialog}
    </VStack>
  )
}
