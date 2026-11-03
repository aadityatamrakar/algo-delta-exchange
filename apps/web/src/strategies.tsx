/**
 * The strategy table for the CURRENT MODE, and the per-strategy page behind it.
 *
 * ONE TABLE, NOT THREE PAGES. Which mode it shows comes from the navbar switch;
 * there is no mode control here. It lists only the strategies ADDED to that
 * mode, because the registry will grow well past what is useful to scroll.
 *
 * MEMBERSHIP AND ENABLEMENT ARE SEPARATE STATES, and the reason is concrete:
 *
 *   not added       — invisible here. The add modal is the only way in.
 *   added, off      — in the table, not trading. This is the pause button.
 *   added, on       — trading.
 *
 * With one boolean carrying both meanings, switching a strategy off would take
 * it out of the very table its switch lives in, and pausing it for an afternoon
 * would mean deleting the row and recreating it — losing its live lots and
 * autostart on the way.
 *
 * NOTHING HERE EDITS STRATEGY PARAMETERS. Entry rules, stops and targets live in
 * the strategy files. What the portal owns is the switches, the live lot
 * allocation and the start time — the things an operator decides, not the things
 * a backtest decided. Even those live on the strategy's own page now; the table
 * keeps only what you scan.
 *
 * TURNING LIVE ON ASKS FOR THE PASSWORD; turning paper on does not, because
 * paper cannot move money. Being ON the live mode costs nothing — looking is
 * free — so the prompt is raised by the switch, never by the navbar. It is
 * raised BEFORE the request when we can already tell the outcome, and again if
 * the server answers 403 `reauthRequired`: the server is the authority on which
 * edits are dangerous, so the client's guess is a courtesy, not the gate.
 *
 * `runtime` is ABSENT for `external` rows and that is rendered as "not
 * supervised", never as "stopped". We do not run the Python processes and must
 * not display a state we cannot observe.
 */

import { useEffect, useMemo, useState } from 'react'
import { VStack, HStack, Layout, LayoutContent, LayoutFooter } from '@astryxdesign/core/Layout'
import { AlertDialog } from '@astryxdesign/core/AlertDialog'
import { Card } from '@astryxdesign/core/Card'
import { Grid } from '@astryxdesign/core/Grid'
import { Text, Heading } from '@astryxdesign/core/Text'
import { Badge } from '@astryxdesign/core/Badge'
import { Button } from '@astryxdesign/core/Button'
import { Banner } from '@astryxdesign/core/Banner'
import { Link } from '@astryxdesign/core/Link'
import { Switch } from '@astryxdesign/core/Switch'
import { Selector } from '@astryxdesign/core/Selector'
import { TextInput } from '@astryxdesign/core/TextInput'
import { NumberInput } from '@astryxdesign/core/NumberInput'
import { Dialog, DialogHeader } from '@astryxdesign/core/Dialog'
import { DropdownMenu } from '@astryxdesign/core/DropdownMenu'
import {
  Table, proportional, pixel, useTableSortable, useTableSortableState,
} from '@astryxdesign/core/Table'
import type { TableColumn, TableSortState } from '@astryxdesign/core/Table'
import {
  ApiError, api, ago, explain, inSession, inr, isAdded, isOn, istDate, istDaysBefore,
  localDayTime, localTime,
  signed, sign, NOWRAP, RED,
  type BookDecisions, type BookRow, type BulkResult, type DailyLimits, type DayGuardFired,
  type DecisionActionRow, type DeskMode,
  type PnlLeg, type RuntimeState, type StrategyPatch, type StrategyRow,
} from './api.ts'
import { BULK_LIVE_STATEMENT, dayGuardStatement, liveStatement } from './live-copy.ts'
import { formatContract, parseContract } from './contract.ts'
import { cash, currencySymbol } from './format.ts'
import { VENUE } from './venue.ts'
import { PHONE, usePoll, useMedia } from './shell.tsx'
import { ModeBadge } from './mode.tsx'
import { useReauth, withReauth, type Reauth } from './auth.tsx'
import { Money, UnpricedNote } from './pnl.tsx'
import { LiveFeedNotice, useLivePnl, useStreamedPoll } from './stream.tsx'
import { IntradayPnlChart } from './chart.tsx'
import { OrderLogTable } from './orderlog.tsx'

const RUNTIME_TONE: Record<RuntimeState, 'success' | 'warning' | 'error' | 'neutral'> = {
  running: 'success',
  waiting: 'warning',
  'squared-off': 'neutral',
  stopped: 'neutral',
  failed: 'error',
}

/**
 * What a bulk switch does, in this mode, in one sentence.
 *
 * EVERY DIRECTION GETS ONE. Only live-on used to be confirmed — by the password
 * prompt — which left live-OFF, paper-on and paper-off as single unconfirmed
 * clicks whose only statement of which rail they hit was a badge at the far end
 * of the row. Off is not the harmless direction here: it blocks exits too.
 */
/**
 * WHAT OFF ACTUALLY DOES, in one sentence, stated ONCE.
 *
 * The bulk switch and the per-row switch both raise it — the bulk one about
 * every row, this one about a single strategy (audit F-51) — and the fact is
 * identical either way: the runner stops sending for a strategy that is off,
 * and an exit is something it sends. Two copies of this warning would
 * eventually disagree about what off means, which is the one thing the operator
 * is reading it to find out.
 */
const OFF_BLOCKS_EXITS =
  'Switching a strategy off blocks its EXITS as well as its entries, so nothing is flattened — ' +
  'anything currently open is left open and unmanaged until you close it yourself.'

function bulkStatement(mode: DeskMode, on: boolean): string {
  if (!on) {
    return `Every strategy on the ${mode} table will be switched off. ${OFF_BLOCKS_EXITS}`
  }
  return mode === 'live'
    ? BULK_LIVE_STATEMENT
    : 'Every strategy on the PAPER table will be switched on. They will trade the paper ' +
      'rail only; nothing routes to a broker.'
}

/**
 * The same statement, about ONE row.
 *
 * THE RAIL IS IN THE SENTENCE, as it is everywhere else on this page: the only
 * other thing naming it is a badge at the far end of a wide table, which is not
 * where anyone is looking while their finger is on the switch.
 */
function rowOffStatement(mode: DeskMode, tag: string): string {
  return `${tag} will stop trading in ${mode}. ${OFF_BLOCKS_EXITS}`
}

/**
 * Applies a patch, asking for the password whenever it turns the LIVE switch on
 * — or changes the day guard on a row that is already live.
 *
 * BOTH CONDITIONS MIRROR THE SERVER'S, which is the rule `withReauth`'s own
 * header states: prompting more widely than the server checks produces a scary
 * dialog that does nothing, and that is what teaches an operator to click
 * through the one that matters. `routes/desk.ts` gates `dailyLimits` on
 * `isOn(row.modes, 'live')`, so this asks the same question of the same row.
 */
async function patchWithReauth(
  row: StrategyRow,
  patch: StrategyPatch,
  reauth: Reauth,
  onDone: () => void,
  onError: (m: string) => void,
): Promise<void> {
  const guardingLive = patch.dailyLimits !== undefined && isOn(row.modes, 'live')
  await withReauth({
    // The statement describes what is ACTUALLY changing. Arming a rail and
    // removing the limit that stops one already armed are different acts, and a
    // prompt that called the second one the first would be describing something
    // that is not happening.
    statement: guardingLive ? dayGuardStatement(row.tag) : liveStatement(row.tag),
    // Turning paper on cannot move money, and neither can a lot or autostart
    // edit; only `modes.live.enabled: true` and a live row's daily limits are
    // gated, which is exactly what the server gates on.
    promptFirst: patch.modes?.live?.enabled === true || guardingLive,
    run: (password) => api.patchStrategy(
      row.tag, password === undefined ? patch : { ...patch, password },
    ),
    reauth,
    onDone: () => onDone(),
    onError,
  })
}

// --------------------------------------------------------------- day guard

/**
 * `10k`, `1.5L`, `2Cr` — a limit at the width of a table chip.
 *
 * NOT `inrCompact`, which is for headline tiles and keeps five-digit Indian
 * grouping (`10,000`) below a lakh. That is the right call at 2xl beside one
 * number; in a 150px cell holding two of them beside a switch it is the widest
 * thing in the row, and these are round configured numbers rather than figures
 * anyone reads to the rupee.
 */
function guardCompact(n: number): string {
  if (typeof n !== 'number' || !Number.isFinite(n)) return '—'
  const trim = (v: number): string => String(Math.round(v * 10) / 10)
  const a = Math.abs(n)
  // Lakhs and crores are rupee units; a USD limit reads in k and M.
  if (VENUE.currency === 'USD' && a >= 1e6) return `${trim(n / 1e6)}M`
  if (VENUE.currency === 'INR' && a >= 1e7) return `${trim(n / 1e7)}Cr`
  if (VENUE.currency === 'INR' && a >= 1e5) return `${trim(n / 1e5)}L`
  if (a >= 1_000) return `${trim(n / 1_000)}k`
  return trim(n)
}

/**
 * The armed lines as one chip: `▲10k ▼3k`. Null when the guard is unarmed.
 *
 * The arrows carry the direction so neither number needs a word beside it —
 * "target" and "stop" at this size are two labels that read as one block. Up is
 * the profit that stops it, down is the loss that stops it.
 */
export function armedChip(limits: DailyLimits | undefined): string | null {
  if (limits === undefined) return null
  const parts: string[] = []
  if (limits.target !== undefined) parts.push(`▲${guardCompact(limits.target)}`)
  if (limits.stop !== undefined) parts.push(`▼${guardCompact(limits.stop)}`)
  return parts.length === 0 ? null : parts.join(' ')
}

/**
 * WHAT HAPPENED, in one sentence, with the number and the time in it.
 *
 * `HH:MM` rather than the full `localTime`: the seconds are noise here, and the
 * sentence is already long enough to wrap in the cell it lives in.
 */
export function guardBadgeLabel(fired: DayGuardFired): string {
  const at = localTime(fired.firedAt).slice(0, 5)
  const n = fired.pnlAtTrigger
  // Written out rather than `signed()`, which formats a plain number: this
  // sentence is read on its own with no column header above it saying rupees,
  // and the sign is the half that decides whether it is a good day or a bad one.
  const money = `${n < 0 ? '-' : '+'}${cash(Math.abs(n))}`
  return `guard: ${fired.trigger} hit ${money} at ${at} — stopped for the day`
}

/**
 * The day guard, per row: what it is armed with, and whether it has already
 * fired today.
 *
 * A FIRED GUARD IS THE REASON THE SWITCH BESIDE IT IS OFF. Without it, a
 * strategy the guard stopped at 11:04 looks exactly like one an operator paused
 * — and the two want opposite responses. The tone splits on the trigger because
 * so does the response: a target hit is a good day that ended early (amber), a
 * stop is a loss that needs looking at (red).
 */
function DayGuardCell(props: { row: StrategyRow }): React.ReactElement {
  const chip = armedChip(props.row.dailyLimits)
  const fired = props.row.dayGuard
  if (fired === undefined) {
    // "off" rather than a blank cell: an empty column beside fourteen filled
    // ones reads as a rendering failure, and this one says a control is unarmed.
    return (
      <Text size="sm" color="secondary" style={NOWRAP}>{chip ?? 'off'}</Text>
    )
  }
  return (
    <VStack gap={1} align="start" style={{ minWidth: 0 }}>
      <Badge
        variant={fired.trigger === 'stop' ? 'error' : 'warning'}
        label={guardBadgeLabel(fired)}
      />
      {/*
        The figure the guard acted on came from realised alone, so it understates
        the move. Said where the number is, not in a footnote.
      */}
      {fired.incomplete
        ? <Text size="sm" color="secondary">realised only — a leg was unpriced</Text>
        : null}
      {chip === null ? null : <Text size="sm" color="secondary">{chip}</Text>}
    </VStack>
  )
}

// -------------------------------------------------------------- shared bits

/**
 * A STALE STATE IS STILL SHOWN, AND STOPS LOOKING CURRENT.
 *
 * `stale` means nothing has rewritten the document for 90s: the runner is gone,
 * wedged, or its publish has been failing. The state is the last thing that was
 * true and is worth keeping — the open-position count goes with it — but it must
 * not wear the green a live `running` wears, because that badge is what talks an
 * operator out of looking further. Dropped to `neutral` with one quiet word
 * beside it rather than an error tone: a runner that is down is a thing to
 * notice, not an alarm, and the strategy underneath may be perfectly fine.
 */
function RuntimeCell(props: { row: StrategyRow }): React.ReactElement {
  const rt = props.row.runtime
  // ABSENT is not `stopped`. External rows are Python processes we do not
  // supervise; claiming a state we cannot observe is worse than saying so.
  if (rt === undefined) return <Text size="sm" color="secondary">not supervised</Text>
  // `=== true` rather than truthiness: an API old enough not to send the field
  // must read as "not known to be stale", never as stale.
  const stale = rt.stale === true
  return (
    <HStack gap={2} align="center">
      <Badge variant={stale ? 'neutral' : RUNTIME_TONE[rt.state]} label={rt.state} />
      {stale ? <Text size="sm" color="secondary">stale</Text> : null}
      {rt.openPositions > 0
        ? <Text size="sm" color="secondary">{`${rt.openPositions} open`}</Text>
        : null}
    </HStack>
  )
}

/** A recorded reason, never a synthesised one. Empty means nobody wrote one. */
function realReason(row: StrategyRow): string | null {
  const r = row.disabledReason
  return r === null || r.trim() === '' ? null : r.trim()
}

function TagCell(props: { row: StrategyRow }): React.ReactElement {
  const reason = realReason(props.row)
  return (
    /*
      `minWidth: 0` so this can SHRINK. It is a flex item in the phone card
      below, beside a Switch that must not be pushed off the edge by a long
      tag — a flex item's automatic minimum size is its content, so without
      this the row grows instead of the name wrapping.
    */
    <VStack gap={0} style={{ minWidth: 0 }}>
      <Link href={`#/strategies/${encodeURIComponent(props.row.tag)}`}>{props.row.tag}</Link>
      <Text size="sm" color="secondary">{props.row.label}</Text>
      {/*
        Shown only where a HUMAN recorded a reason. A row nobody has switched on
        is simply off — the switch already says so, and a "not enabled" line
        beside it is fifteen copies of the same non-information.
      */}
      {reason === null ? null : <Text size="sm" style={RED}>{reason}</Text>}
    </VStack>
  )
}

// -------------------------------------------------------------- bulk switch

/**
 * Switch every row in the CURRENT MODE on or off.
 *
 * It acts on the mode the navbar says and never on both. One click that arms
 * live trading everywhere is precisely the ambiguity the single switch exists to
 * remove, so there is no "all modes" control anywhere.
 *
 * ON in live asks for the password; OFF never asks, in either mode. A password
 * in front of a mass stop is the same mistake as one in front of the kill
 * switch — the safe direction must never be the slow one.
 */
function useBulkSwitch(props: { mode: DeskMode; onDone: () => void }): {
  buttons: React.ReactElement
  report: React.ReactElement | null
} {
  const reauth = useReauth()
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<{ mode: DeskMode; on: boolean; value: BulkResult } | null>(null)
  const [error, setError] = useState<{ mode: DeskMode; message: string } | null>(null)
  /** The direction awaiting confirmation, or null when nothing is pending. */
  const [pending, setPending] = useState<boolean | null>(null)

  /**
   * A result belongs to the mode it ran in, and is dropped when the switch
   * moves. Without this a paper report sat under the LIVE table, describing
   * rows that are not the ones on screen.
   */
  useEffect(() => {
    setResult(null)
    setError(null)
    setPending(null)
  }, [props.mode])

  const run = async (on: boolean): Promise<void> => {
    // The mode is captured HERE. Moving the switch mid-flight must not file the
    // answer under the other table.
    const ran = props.mode
    setBusy(true)
    setError(null)
    setResult(null)
    await withReauth({
      statement: bulkStatement(ran, on),
      promptFirst: on && ran === 'live',
      run: (password) => api.bulkStrategies(ran, on, password),
      reauth,
      onDone: (value) => { setResult({ mode: ran, on, value }); props.onDone() },
      onError: (message) => setError({ mode: ran, message }),
    })
    setBusy(false)
  }

  /**
   * Live-ON is confirmed by the password prompt, which already states what it
   * arms; a second dialog in front of it would be one more thing to click
   * through. The other three directions have nothing in front of them, so they
   * get this.
   */
  const confirmFirst = (on: boolean): boolean => !(on && props.mode === 'live')

  const start = (on: boolean): void => {
    if (confirmFirst(on)) setPending(on)
    else void run(on)
  }

  const buttons = (
    <HStack gap={2} align="center" wrap="wrap">
      <Button
        // Destructive only in live, where it is. In paper it is a secondary
        // button, so the loudest thing on the page is never a mass arm.
        variant={props.mode === 'live' ? 'destructive' : 'secondary'}
        size="sm"
        // THE MODE IS IN THE LABEL. A badge at the other end of the row is not
        // where someone looks while clicking the button.
        label={`Turn all on in ${props.mode}`}
        isDisabled={busy}
        onClick={() => start(true)}
      />
      <Button
        variant="secondary"
        size="sm"
        label={`Turn all off in ${props.mode}`}
        isDisabled={busy}
        onClick={() => start(false)}
      />
      <AlertDialog
        isOpen={pending !== null}
        onOpenChange={() => setPending(null)}
        title={
          pending === true
            ? `Turn every ${props.mode} strategy on?`
            : `Turn every ${props.mode} strategy off?`
        }
        description={pending === null ? '' : bulkStatement(props.mode, pending)}
        actionLabel={pending === true ? `Turn all on in ${props.mode}` : `Turn all off in ${props.mode}`}
        actionVariant={props.mode === 'live' ? 'destructive' : 'primary'}
        isActionLoading={busy}
        onAction={() => {
          const on = pending
          setPending(null)
          if (on !== null) void run(on)
        }}
      />
      {reauth.dialog}
    </HStack>
  )

  const report =
    error !== null && error.mode === props.mode ? (
      <Banner status="error" title="The bulk switch did not run" description={error.message} />
    ) : result !== null && result.mode === props.mode ? (
      <BulkReport mode={result.mode} on={result.on} result={result.value} />
    ) : null

  return { buttons, report }
}

/**
 * The per-tag outcome, never a count.
 *
 * "15 changed" while three silently did nothing is how someone ends up believing
 * a strategy is off when it is running, so every tag the server refused is named
 * with the server's own reason.
 */
function BulkReport(props: { mode: DeskMode; on: boolean; result: BulkResult }): React.ReactElement {
  const r = props.result
  // The mode is in the sentence. "Switched on: A, B" said nothing about which
  // rail those tags are now trading on — the one fact that decides whether the
  // line is routine or alarming.
  const verb = `${props.on ? 'Switched on' : 'Switched off'} in ${props.mode}`

  return (
    <VStack gap={2}>
      {/*
        THE ONE THING THAT MUST NOT BE MISSED.

        Switching a strategy off blocks its EXITS as well as its entries — that
        asymmetry is deliberate — so a mass-off does not flatten anything, it
        strands it. A report that says "all off" while positions sit open and
        unmanaged is the worst outcome this page can produce.
      */}
      {r.stranded.length > 0 ? (
        <Banner
          status="error"
          title="These are switched off but still holding positions"
          description={
            <VStack gap={1}>
              <Text>
                {r.stranded
                  .map((s) => (s.openPositions === null ? s.tag : `${s.tag} (${s.openPositions} open)`))
                  .join(', ')}
              </Text>
              <Text>
                Switching a strategy off blocks its exits as well as its entries, so nothing
                was flattened — these positions are now open and unmanaged. Close them from{' '}
                <Link href="#/controls">Controls</Link>, which runs as you rather than as the
                strategy.
              </Text>
            </VStack>
          }
        />
      ) : null}

      {r.changed.length > 0
        ? <Text size="sm">{`${verb}: ${r.changed.join(', ')}`}</Text>
        : null}
      {r.unchanged.length > 0 ? (
        <Text size="sm" color="secondary">
          {`Already ${props.on ? 'on' : 'off'} in ${props.mode}: ${r.unchanged.join(', ')}`}
        </Text>
      ) : null}
      {r.skipped.map((s) => (
        <Text key={s.tag} size="sm" style={RED}>{`${s.tag} was not changed: ${s.reason}`}</Text>
      ))}
      {r.changed.length === 0 && r.unchanged.length === 0 && r.skipped.length === 0 ? (
        <Text size="sm" color="secondary">
          {`Nothing is added to ${props.mode} — nothing to switch.`}
        </Text>
      ) : null}
    </VStack>
  )
}

// ------------------------------------------------------------ row settings

/**
 * Flatten ONE strategy, from its own row.
 *
 * It lives here rather than on Controls because it is a per-strategy action and
 * this is where you are when you decide to take one off. Controls keeps the
 * global things — the kill switch, and closing a whole book.
 *
 * IT RUNS AS THE OPERATOR, not as the strategy, which is why it still works
 * when the strategy is switched off. Switching a strategy off deliberately
 * blocks its own exits, so without this the position is unreachable by anything
 * except the broker's own website.
 */
function FlattenDialog(props: {
  row: StrategyRow | null
  mode: DeskMode
  onClose: () => void
}): React.ReactElement {
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)
  const tag = props.row?.tag ?? ''

  /**
   * THE OUTCOME BELONGS TO THE ROW IT CAME FROM.
   *
   * This dialog is mounted permanently and opened by setting `row`, so its
   * state survives being closed. Clearing only inside `run()` meant flattening
   * ATR_BAND_NIFTY, reading "Flattened 3 contracts", cancelling, then clicking
   * Flatten on ORB_SCALP_BN opened a dialog titled ORB_SCALP_BN carrying the
   * other strategy's green success banner — for a strategy nothing had been
   * sent for. Keyed on the tag and the mode, both of which change what the
   * result would even mean.
   */
  useEffect(() => {
    setResult(null)
    setFailed(false)
  }, [tag, props.mode])

  const run = async (style: 'fast' | 'limit'): Promise<void> => {
    setBusy(true)
    setResult(null)
    try {
      const r = await api.flattenTag(tag, props.mode, style)
      // `flat` is the ONLY field that means nothing is left open. Everything
      // else has to name what remains — a flatten that partially succeeded and
      // reports "done" is the failure this whole path exists to remove.
      if (r.flat && r.legs.length === 0) {
        setFailed(false)
        setResult('Nothing was open — no orders were sent.')
      } else if (r.flat) {
        setFailed(false)
        setResult(`Flattened ${r.legs.length} contract${r.legs.length === 1 ? '' : 's'}.`)
      } else {
        setFailed(true)
        setResult(
          'STILL OPEN — ' +
            [
              ...r.legs.filter((l) => !l.routed).map((l) => `${l.tradingsymbol} (${l.error})`),
              ...r.unresolved.map((sym) => `${sym} (not in the instrument master)`),
              ...r.truncated.map((sym) => `${sym} (position could not be reconstructed safely)`),
            ].join('; '),
        )
      }
    } catch (err) {
      setFailed(true)
      setResult(explain(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog isOpen={props.row !== null} onOpenChange={props.onClose} purpose="form" width={520}>
      <Layout
        header={<DialogHeader title={`Flatten ${tag}`} onOpenChange={props.onClose} />}
        content={
          <LayoutContent>
            <VStack gap={4}>
              <Text>
                {`Closes everything ${tag} is holding on the ${props.mode} rail, in one decision so a
                  retry cannot double-sell. It runs as you, not as the strategy — so it works even
                  while the strategy is switched off.`}
              </Text>
              <Text size="sm" color="secondary">
                Delta takes limit orders only. <b>Fast</b> is an aggressive limit well through the
                price: near-certain fill, loosely controlled price. <b>Limit</b> prices just through the
                mark so it still crosses; a leg with no mark falls back to the fast price rather than
                being left open.
              </Text>
              {result !== null ? (
                <Banner status={failed ? 'error' : 'success'} title={result} />
              ) : null}
            </VStack>
          </LayoutContent>
        }
        footer={
          <LayoutFooter hasDivider>
            <HStack gap={2} justify="end">
              <Button variant="secondary" label="Cancel" onClick={props.onClose} />
              <Button
                variant="secondary"
                label="Flatten — limit"
                isDisabled={busy}
                onClick={() => void run('limit')}
              />
              <Button
                variant="destructive"
                label="Flatten — fast"
                isDisabled={busy}
                onClick={() => void run('fast')}
              />
            </HStack>
          </LayoutFooter>
        }
      />
    </Dialog>
  )
}

/**
 * Two limits off the form, as the patch the server takes.
 *
 * 0 AND BLANK BOTH MEAN "NO LINE", because there is no daily target of zero: a
 * book crosses zero on its first tick, so a stored 0 would be a guard that
 * fires immediately and looks like one that is armed sensibly. Both lines empty
 * is `null` — disarm — which is the same thing the server normalises to.
 */
export function limitsFromForm(target: number, stop: number): DailyLimits | null {
  const out: DailyLimits = {}
  if (Number.isFinite(target) && target > 0) out.target = target
  if (Number.isFinite(stop) && stop > 0) out.stop = stop
  return out.target === undefined && out.stop === undefined ? null : out
}

/** Same two lines, same shape, so "did the operator change them?" is one compare. */
function sameLimits(a: DailyLimits | null, b: DailyLimits | undefined): boolean {
  return (a?.target ?? 0) === (b?.target ?? 0) && (a?.stop ?? 0) === (b?.stop ?? 0)
}

function SettingsDialog(props: {
  row: StrategyRow
  onClose: () => void
  onSave: (patch: StrategyPatch) => void
}): React.ReactElement {
  const [lots, setLots] = useState<number>(props.row.liveLots)
  const [autostart, setAutostart] = useState<string>(props.row.autostartAt)
  const [target, setTarget] = useState<number>(props.row.dailyLimits?.target ?? 0)
  const [stop, setStop] = useState<number>(props.row.dailyLimits?.stop ?? 0)

  return (
    <Dialog isOpen onOpenChange={props.onClose} purpose="form" width={460}>
      <Layout
        header={<DialogHeader title={`${props.row.tag} settings`} onOpenChange={props.onClose} />}
        content={
          <LayoutContent>
            <VStack gap={4}>
              <NumberInput
                label="Live lots"
                value={lots}
                onChange={setLots}
                min={0}
                isIntegerOnly
                description="Replaces the strategy's configured lot size in live mode. An override, not a multiplier — multipliers compound invisibly, which is how the old system ended up sizing off an already-multiplied quantity."
              />
              <TextInput
                label="Autostart (HHmm IST)"
                value={autostart}
                onChange={setAutostart}
                placeholder="0918"
                description="Blank means the runner starts it at boot rather than at a time."
              />
              {/*
                THE DAY GUARD — the one limit the portal owns, and the reason the
                sentence below no longer says "targets are not editable here".
                It is not an entry rule: it is the outermost stop, applied to the
                same P&L number the card shows, and it switches the rail off for
                the day when it is hit.
              */}
              <Heading level={4}>Day guard</Heading>
              <NumberInput
                label={`Daily target (${currencySymbol()})`}
                value={target}
                onChange={setTarget}
                min={0}
                isIntegerOnly
                description="Switches this strategy off for the day once it has made this much. 0 or blank means no target."
              />
              <NumberInput
                label={`Daily stop-loss (${currencySymbol()})`}
                value={stop}
                onChange={setStop}
                min={0}
                isIntegerOnly
                // POSITIVE. A signed field is a control that can be armed
                // backwards, and nothing on the page would look wrong.
                description={`A POSITIVE number: 3000 stops this strategy for the day at a ${cash(3000)} loss. 0 or blank means no stop.`}
              />
              <Text color="secondary" size="sm">
                Both limits apply to each rail separately, on today's P&L. Paper comes back
                by itself the next morning; a live rail stays off until you switch it on
                again yourself.
              </Text>
              <Text color="secondary" size="sm">
                Entry rules and per-trade stops are not editable here — they live in the
                strategy file so the code that traded and the code you can read are the
                same thing.
              </Text>
            </VStack>
          </LayoutContent>
        }
        footer={
          <LayoutFooter hasDivider>
            <HStack gap={2} justify="end">
              <Button variant="secondary" label="Cancel" onClick={props.onClose} />
              <Button
                variant="primary"
                label="Save"
                onClick={() => {
                  const limits = limitsFromForm(target, stop)
                  props.onSave({
                    liveLots: lots,
                    autostartAt: autostart.trim(),
                    /*
                      SENT ONLY WHEN IT ACTUALLY CHANGED. On a live row the
                      server gates this field behind the password, so restating
                      it on every lot edit would raise the prompt for a change
                      nobody made — the exact "scary dialog that does nothing"
                      `withReauth` exists to avoid.
                    */
                    ...(sameLimits(limits, props.row.dailyLimits) ? {} : { dailyLimits: limits }),
                  })
                  props.onClose()
                }}
              />
            </HStack>
          </LayoutFooter>
        }
      />
    </Dialog>
  )
}

// --------------------------------------------------------------- add modal

/** One thing the modal can offer: an existing row, or a catalogue tag with none. */
interface Addable {
  tag: string
  label: string
  kind: 'external' | 'hosted'
  /** True when a registry row already exists and only this mode is missing. */
  registered: boolean
}

/**
 * What can still be added to THIS mode.
 *
 * Two sources, because the server answers two different questions: `?all=1`
 * knows the rows that exist (a strategy already running on paper is exactly what
 * you want to add to live), and `/available` knows the catalogue tags no row
 * claims yet. Neither alone is the answer.
 */
function addable(rows: readonly StrategyRow[], available: readonly { tag: string; label: string | null }[], mode: DeskMode): Addable[] {
  const out: Addable[] = rows
    .filter((r) => !isAdded(r.modes, mode))
    .map((r) => ({ tag: r.tag, label: r.label, kind: r.kind, registered: true }))
  const claimed = new Set(rows.map((r) => r.tag))
  for (const a of available) {
    if (claimed.has(a.tag)) continue
    out.push({ tag: a.tag, label: a.label ?? a.tag, kind: 'hosted', registered: false })
  }
  return out.sort((a, b) => (a.tag < b.tag ? -1 : a.tag > b.tag ? 1 : 0))
}

/**
 * Adding a strategy to this mode. THE ROW ARRIVES SWITCHED OFF, and the modal
 * says so.
 *
 * Adding and permitting are separate acts; a form that did both would make a
 * typo a live order, with no moment at which a human confirmed the switch. So
 * this asks for no password even in live mode — it grants nothing.
 *
 * A HOSTED tag is CHOSEN, never typed. A hosted row whose tag no implementation
 * matches is a switch that looks armed and runs nothing; the server rejects it
 * with a 400, and a free text box would just be a way to earn that error.
 * External rows are the opposite case: the Python desk names itself, and nothing
 * here can validate it.
 */
function AddStrategyDialog(props: {
  mode: DeskMode
  rows: readonly StrategyRow[]
  onClose: () => void
  onCreated: () => void
}): React.ReactElement {
  // The catalogue is asked for THIS mode: what is addable to live is not what
  // is addable to paper, and the server filters by the mode it is told.
  const { data: available, error: catalogueError } = usePoll(
    () => api.availableStrategies(props.mode), 30_000, [props.mode],
  )
  const [kind, setKind] = useState<'hosted' | 'external'>('hosted')
  const [tag, setTag] = useState('')
  const [label, setLabel] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const options = addable(props.rows, available ?? [], props.mode)
  const choices = options.filter((o) => o.kind === 'hosted' || o.registered)
  const nothing = kind === 'hosted' && choices.length === 0
  const chosen = tag.trim()

  const create = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      const existing = options.find((o) => o.tag === chosen)
      await api.createStrategy({
        tag: chosen,
        // An existing row keeps its own kind: "add BN_BREAKOUT to live" must not
        // be able to re-declare a hosted strategy as external.
        kind: existing?.registered === true ? existing.kind : kind,
        mode: props.mode,
        ...(label.trim() === '' ? {} : { label: label.trim() }),
      })
      props.onCreated()
      props.onClose()
    } catch (err) {
      setError(explain(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog isOpen onOpenChange={props.onClose} purpose="form" width={520}>
      <Layout
        header={
          <DialogHeader
            title={`Add a strategy to ${props.mode}`}
            onOpenChange={props.onClose}
          />
        }
        content={
          <LayoutContent>
            <VStack gap={4}>
              {error !== null ? (
                <Banner status="error" title="It was not added" description={error} />
              ) : null}

              <Selector
                label="Kind"
                size="sm"
                width={180}
                options={['hosted', 'external']}
                value={kind}
                onChange={(v) => { setKind(v === 'external' ? 'external' : 'hosted'); setTag('') }}
              />

              {kind === 'hosted' ? (
                <Selector
                  label="Strategy"
                  hasSearch
                  options={choices.map((o) => o.tag)}
                  value={chosen}
                  placeholder={nothing ? 'Nothing left to add' : 'Choose a strategy…'}
                  isDisabled={nothing}
                  onChange={setTag}
                />
              ) : (
                <TextInput
                  label="Tag"
                  value={tag}
                  onChange={setTag}
                  placeholder="MIRROR_XYZ"
                  description="The name the Python desk sends its decisions under."
                />
              )}
              <TextInput label="Label" value={label} onChange={setLabel} isOptional />

              <Text size="sm" color="secondary">
                {`It will be added to ${props.mode} SWITCHED OFF. Adding a strategy and letting ` +
                  'it trade are separate acts — flip the switch in the table once you can see it.'}
              </Text>

              {catalogueError !== null && kind === 'hosted' ? (
                <Text size="sm" style={RED}>
                  {`The runner catalogue could not be read (${catalogueError}), so no hosted row can be added without risking a tag nothing runs.`}
                </Text>
              ) : null}
              {catalogueError === null && nothing && available !== null ? (
                <Text size="sm" color="secondary">
                  {`Every strategy the runner implements is already on the ${props.mode} table.`}
                </Text>
              ) : null}
            </VStack>
          </LayoutContent>
        }
        footer={
          <LayoutFooter hasDivider>
            <HStack gap={2} justify="end">
              <Button variant="secondary" label="Cancel" onClick={props.onClose} />
              <Button
                variant="primary"
                label={`Add to ${props.mode}`}
                isLoading={busy}
                isDisabled={busy || chosen === '' || nothing}
                onClick={() => void create()}
              />
            </HStack>
          </LayoutFooter>
        }
      />
    </Dialog>
  )
}

// -------------------------------------------------------------- the table

interface StrategyTableRow extends Record<string, unknown> {
  row: StrategyRow
}

/**
 * The columns that are not the tag and not the switch, as one sentence.
 *
 * Autostart and last-seen are their own columns on the desk because a table can
 * afford a header per fact. On a phone they are a footnote under the name, so
 * they carry their own words — "Autostart at boot" rather than a bare "at boot"
 * with the header three screens away.
 */
function cardMeta(row: StrategyRow, live: boolean): string {
  const parts = [
    `Autostart ${row.autostartAt === '' ? 'at boot' : row.autostartAt}`,
    `last seen ${row.lastSeenAt === 0 ? 'never' : ago(Date.now() - row.lastSeenAt)}`,
  ]
  // Only meaningful live: it is the override applied to live sizing, and on the
  // paper table it is a number that governs nothing.
  if (live) parts.push(`${inr(row.liveLots)} live lots`)
  return parts.join(' · ')
}

/**
 * ONE STRATEGY AS A CARD — the phone rendering of one row of the table below.
 *
 * WHY A CARD AND NOT THE TABLE. Seven columns of which one is 240px of buttons
 * do not fit in 390px: the columns were cut off at the right edge and the three
 * ghost buttons wrapped into a ragged block that read as one control with a
 * three-line label. Neither problem is a padding problem, so no amount of
 * tightening the table fixes it.
 *
 * THE FIRST LINE IS THE TAG AND THE SWITCH, and it is the only line that
 * carries a control you can hit by accident. Putting the switch anywhere else
 * costs a scan of the card to find "is this one armed?", which is the question
 * this page is opened to answer.
 *
 * THE OTHER THREE ACTIONS ARE BEHIND ONE "⋯" BUTTON, deliberately one tap
 * further away. Settings opens a dialog, Flatten sends orders and Remove is a
 * DELETE — as three loose ghost buttons at phone size they were three
 * indistinguishable 44px targets under a thumb, with the destructive one on the
 * end. Behind a menu each is a full-width row with its own label. The
 * confirmations they raise are unchanged; this only changes what you have to
 * aim at.
 *
 * The button's `label` is its accessible name and also names the menu (astryx
 * puts it on `aria-label`), so it says which strategy it acts on — "⋯" alone
 * would announce fifteen identical buttons.
 */
function StrategyCard(props: {
  row: StrategyRow
  mode: DeskMode
  onSwitch: (on: boolean) => void
  /** True while this row's patch is in flight — see the table's own switch. */
  switchBusy: boolean
  onSettings: () => void
  onFlatten: () => void
  onRemove: () => void
}): React.ReactElement {
  const { row, mode } = props
  return (
    <Card>
      <VStack gap={2} padding={3}>
        {/*
          `align="start"`: the switch lines up with the TAG, not with the
          middle of a block whose height depends on whether a human recorded a
          disabled reason.
        */}
        <HStack gap={2} align="start" justify="between">
          <TagCell row={row} />
          <Switch
            label={`Let ${row.tag} trade in ${mode}`}
            isLabelHidden
            value={isOn(row.modes, mode)}
            isDisabled={props.switchBusy}
            onChange={props.onSwitch}
          />
        </HStack>
        <HStack gap={2} align="center" justify="between" wrap="wrap">
          <VStack gap={0} style={{ minWidth: 0 }}>
            <RuntimeCell row={row} />
            {/*
              THE SAME CELL THE TABLE USES, not a phone-shaped restatement of it.
              A fired guard is why the switch above is off, and a card that left
              that out would make the phone the one place you cannot tell an
              operator's pause from a stop-loss.

              Rendered only when there is something to say, unlike the table:
              the column there has a header explaining what "off" means, and a
              card has none — a bare "off" under a runtime badge would read as a
              second opinion about whether the strategy is running.
            */}
            {row.dailyLimits === undefined && row.dayGuard === undefined
              ? null
              : <DayGuardCell row={row} />}
            <Text size="sm" color="secondary">{cardMeta(row, mode === 'live')}</Text>
          </VStack>
          <DropdownMenu
            hasChevron={false}
            button={{
              label: `Actions for ${row.tag}`,
              icon: <span aria-hidden="true">⋯</span>,
              isIconOnly: true,
              variant: 'ghost',
              size: 'sm',
            }}
            items={[
              { label: 'Settings', onClick: props.onSettings },
              { label: 'Flatten', onClick: props.onFlatten },
              // Divided off: it is the only DELETE in the menu, and the row it
              // acts on is one of a dozen identical-looking ones.
              { type: 'divider' },
              { label: 'Remove', onClick: props.onRemove },
            ]}
          />
        </HStack>
      </VStack>
    </Card>
  )
}

export function StrategiesPage(props: { mode: DeskMode }): React.ReactElement {
  const live = props.mode === 'live'
  /*
    ONE LAYOUT IN THE DOCUMENT AT A TIME. Rendering the table and the cards
    together and hiding one with CSS would put TWO switches per strategy in the
    document — and a switch here arms live trading. See `PHONE` in shell.tsx.
  */
  const phone = useMedia(PHONE)
  const { data, error, refresh } = usePoll(() => api.strategies(props.mode), 8000, [props.mode])
  // The add modal needs to know what EXISTS, not just what is on this table.
  const { data: everything } = usePoll(() => api.allStrategies(), 30_000)
  const reauth = useReauth()
  const [note, setNote] = useState<string | null>(null)
  const [done, setDone] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)
  const [settings, setSettings] = useState<StrategyRow | null>(null)
  const [flattening, setFlattening] = useState<StrategyRow | null>(null)
  /**
   * The row a MANUAL ORDER dialog is open for. A strategy row carries no
   * symbol or expiry, so the dialog offers pickers fed by the master.
   */
  /** The row whose removal is awaiting confirmation. */
  const [removing, setRemoving] = useState<StrategyRow | null>(null)
  /** The row whose switch-OFF is awaiting confirmation. See `rowOffStatement`. */
  const [switchingOff, setSwitchingOff] = useState<StrategyRow | null>(null)
  /**
   * The tags whose patches are in flight — a SET, not one tag.
   *
   * ONE AT A TIME, BY TAG. A patch is a round trip and the switch stayed live
   * for all of it, so an impatient second click sent a second PATCH — two
   * writes racing to set the same field, and the loser is whichever the server
   * happened to apply last. The switch also cannot show the intermediate state
   * (it renders the SERVER's value, which has not changed yet), so nothing on
   * screen said the first click had been heard.
   *
   * A SINGLE TAG WAS NOT ENOUGH, because the table holds a dozen switches and
   * nothing stops an operator touching two. The second row's click overwrote
   * the tag, releasing the first row's switch while its own PATCH was still
   * open; and whichever answer came back first cleared the guard for EVERY row,
   * including the ones still waiting. Both are the F-51 race again, one row
   * removed. Each tag is added when its request starts and removed — from the
   * set as it stands at that moment, never from a copy captured earlier — when
   * its OWN request settles, so the rows do not interfere.
   */
  const [patching, setPatching] = useState<ReadonlySet<string>>(new Set())
  const bulk = useBulkSwitch({ mode: props.mode, onDone: refresh })

  /**
   * Messages do not survive the switch.
   *
   * "ORB_SCALP_BN was removed" or a failure from a paper edit left on screen
   * under the LIVE table describes a change to rows that are not the ones being
   * shown — and the reader has no way to tell which rail it happened on.
   */
  useEffect(() => {
    setNote(null)
    setDone(null)
    setRemoving(null)
    setSwitchingOff(null)
  }, [props.mode])

  const apply = (row: StrategyRow, patch: StrategyPatch): void => {
    setNote(null)
    setDone(null)
    const tag = row.tag
    setPatching((prev) => new Set(prev).add(tag))
    // `finally` rather than a `then`: the password prompt can be CANCELLED, in
    // which case `withReauth` resolves having sent nothing — and a switch left
    // disabled after a cancelled prompt is a control the operator cannot use
    // again without reloading the page.
    void patchWithReauth(row, patch, reauth, refresh, setNote)
      .finally(() => setPatching((prev) => {
        const next = new Set(prev)
        next.delete(tag)
        return next
      }))
  }

  /**
   * The patch a switch in THIS mode sends, in one place: the table's cell and
   * the phone card's control both go through it, so a row and a card cannot
   * come to mean different things.
   */
  const switchPatch = (on: boolean): StrategyPatch =>
    props.mode === 'live' ? { modes: { live: { enabled: on } } } : { modes: { paper: { enabled: on } } }

  /**
   * ON goes straight through; OFF is confirmed first.
   *
   * Live-ON is already confirmed by the password prompt `patchWithReauth`
   * raises, and a second dialog in front of it would be one more thing to click
   * through. Paper-ON cannot move money and cannot strand anything. OFF, in
   * either mode, blocks the exits of whatever is already open — the direction
   * that looks safe and is not, which is why the bulk switch asks about it too.
   */
  const flipSwitch = (row: StrategyRow, on: boolean): void => {
    if (on) apply(row, switchPatch(true))
    else setSwitchingOff(row)
  }

  const remove = async (row: StrategyRow): Promise<void> => {
    setNote(null)
    setDone(null)
    const mode = props.mode
    try {
      await api.removeStrategyMode(row.tag, mode)
      // Success is SAID. A row vanishing from a table is not confirmation that
      // the thing you intended is what happened — it looks identical to a poll
      // that dropped it for some other reason.
      setDone(`${row.tag} was removed from the ${mode} table. Its other mode is untouched.`)
      refresh()
    } catch (err) {
      // A 409 here is the open-position guard, and the server's sentence names
      // the route out. Rendered verbatim rather than summarised.
      setNote(explain(err))
    }
  }

  const rows: StrategyTableRow[] = (data?.strategies ?? []).map((row) => ({ row }))

  /**
   * WHY EVERY ROW SAYS `waiting`, stated once instead of inferred from the date.
   *
   * Outside the session there is nothing for a hosted strategy to do: the runner
   * refuses to start one on a non-weekday at all, and before the bell it is
   * waiting for its own autostart minute. A whole table of `waiting` looks
   * identical to a desk that failed to come up, and the reader is left checking
   * what day it is.
   *
   * Read at RENDER rather than held in state: this page polls every 8s, so it
   * re-renders often enough to cross 09:15 and 15:30 within a minute, and a
   * timer of its own would be a second clock to keep correct. `Market closed` is
   * the wording the positions page already uses for the same condition.
   */
  const marketClosed = !inSession(Date.now())

  const columns: TableColumn<StrategyTableRow>[] = [
    {
      key: 'tag', header: 'Tag', width: proportional(2),
      renderCell: ({ row }) => <TagCell row={row} />,
    },
    {
      key: 'enabled', header: live ? 'Trading live' : 'Trading', width: pixel(110),
      renderCell: ({ row }) => (
        <Switch
          label={`Let ${row.tag} trade in ${props.mode}`}
          isLabelHidden
          value={isOn(row.modes, props.mode)}
          isDisabled={patching.has(row.tag)}
          onChange={(v) => flipSwitch(row, v)}
        />
      ),
    },
    ...(live ? [{
      // Only meaningful live: it is the override applied to live sizing.
      key: 'liveLots', header: 'Live lots', align: 'end' as const, width: pixel(100),
      renderCell: ({ row }: StrategyTableRow) => <Text>{inr(row.liveLots)}</Text>,
    }] : []),
    {
      key: 'autostartAt', header: 'Autostart', width: pixel(110),
      renderCell: ({ row }) => (
        <Text size="sm" color="secondary">{row.autostartAt === '' ? 'at boot' : row.autostartAt}</Text>
      ),
    },
    {
      key: 'lastSeenAt', header: 'Last seen', width: pixel(110),
      renderCell: ({ row }) => (
        <Text size="sm" color="secondary">
          {row.lastSeenAt === 0 ? 'never' : ago(Date.now() - row.lastSeenAt)}
        </Text>
      ),
    },
    {
      key: 'runtime', header: 'Runtime', width: pixel(170),
      renderCell: ({ row }) => <RuntimeCell row={row} />,
    },
    {
      // Wide enough for the fired sentence to wrap in two lines rather than
      // five. It is the loudest thing a row can say, and a row that is saying
      // it has earned the height.
      key: 'dayGuard', header: 'Day guard', width: pixel(200),
      renderCell: ({ row }) => <DayGuardCell row={row} />,
    },
    {
      key: 'actions', header: '', width: pixel(240),
      renderCell: ({ row }) => (
        <HStack gap={1} justify="end" wrap="wrap">
          <Button variant="ghost" size="sm" label="Settings" onClick={() => setSettings(row)} />
          <Button
            variant="ghost"
            size="sm"
            label="Flatten"
            tooltip={`Close everything ${row.tag} holds on the ${props.mode} rail. Runs as you, so it works while the strategy is switched off.`}
            onClick={() => setFlattening(row)}
          />
          {/*
            CONFIRMED, because it is a DELETE with no undo and the row it acts
            on is one of a dozen identical-looking ones. It used to fire the
            request on the click, with the mode stated only in a tooltip nobody
            reads while aiming at a button.
          */}
          <Button
            variant="ghost"
            size="sm"
            label="Remove"
            onClick={() => setRemoving(row)}
          />
        </HStack>
      ),
    },
  ]

  return (
    <VStack gap={4}>
      {/*
        `wrap` ON EVERY LEVEL OF THIS TOOLBAR. It carries a heading, a badge,
        two bulk-switch buttons whose labels name the mode ("Turn all on in
        live") and "Add strategy" — around 700px of controls, on a page that has
        to work at 390. Without it the row simply ran off the side of the screen
        and took the horizontal scrollbar of the whole document with it.
      */}
      <HStack gap={3} align="center" justify="between" wrap="wrap">
        <HStack gap={3} align="center" wrap="wrap">
          <Heading level={2}>Strategies</Heading>
          {/* The third of the colour's three places. */}
          <ModeBadge />
          {/*
            Beside the mode chip, at the weight of secondary text — the same
            register as "at boot" or "never" in the table. It is CONTEXT for
            what the rows say, not an incident, so it gets no banner and no
            colour; a loud one every evening and all weekend is how a page
            teaches its reader to skip the top of it.
          */}
          {marketClosed ? <Text size="sm" color="secondary">Market closed</Text> : null}
        </HStack>
        <HStack gap={2} align="center" wrap="wrap">
          {bulk.buttons}
          <Button variant="secondary" label="Add strategy" onClick={() => setAdding(true)} />
        </HStack>
      </HStack>

      {error !== null ? (
        <Banner
          status="error"
          title="The table could not be loaded"
          description={`${error}. This list cannot be trusted to reflect what the gate is actually enforcing.`}
        />
      ) : null}
      {note !== null ? (
        <Banner status="error" title="That change was not applied" description={note} />
      ) : null}
      {done !== null ? <Banner status="success" title={done} /> : null}
      {/*
        THE BULK REPORT IS FULL WIDTH, HERE, not inside the header row.

        It used to render inside the header's `HStack`, squeezed into whatever
        space was left beside "Add strategy" — including the stranded-positions
        banner, which is the single most important message this page can emit
        ("switched off and still holding, exits blocked"). A page-wide error
        does not belong in a toolbar.
      */}
      {bulk.report}

      {data === null && error === null ? <Text color="secondary">Loading…</Text> : null}
      {data !== null && rows.length === 0 ? (
        <Text color="secondary">
          {`Nothing is added to ${props.mode} yet. "Add strategy" puts one here, switched off.`}
        </Text>
      ) : null}

      {/*
        THE SAME ROWS, THE SAME ACTIONS, TWO ARRANGEMENTS. Every handler below
        is the one the table's own cell calls, so a card and a row cannot come
        to mean different things — only the shape they are drawn in differs.
      */}
      {rows.length > 0 && phone ? (
        <VStack gap={2}>
          {rows.map(({ row }) => (
            <StrategyCard
              key={row.tag}
              row={row}
              mode={props.mode}
              onSwitch={(v) => flipSwitch(row, v)}
              switchBusy={patching.has(row.tag)}
              onSettings={() => setSettings(row)}
              onFlatten={() => setFlattening(row)}
              onRemove={() => setRemoving(row)}
            />
          ))}
        </VStack>
      ) : null}
      {rows.length > 0 && !phone
        ? <Table data={rows} columns={columns} density="compact" hasHover />
        : null}

      {/*
        The permanent footer that used to sit here — "off means off… flatten
        from Controls" — is gone. It restated the Flatten button's own tooltip
        and the confirmation dialog behind it, on every load, forever. The one
        moment that sentence matters is when a mass-off strands something, and
        the bulk report says it there with the tags named.
      */}

      {/*
        THE ONE-CLICK DIRECTION THAT WAS NOT SAFE.

        Rendered only when a row is pending, exactly like Remove above it — the
        dialog's own copy names the strategy, so an always-mounted one would
        have to render an empty title for the 99% of the time nothing is
        pending.
      */}
      {switchingOff !== null ? (
        <AlertDialog
          isOpen
          onOpenChange={() => setSwitchingOff(null)}
          title={`Turn ${switchingOff.tag} off in ${props.mode}?`}
          description={rowOffStatement(props.mode, switchingOff.tag)}
          // NAMES THE ROW, not just the direction: the bulk buttons say "Turn
          // all off in paper" a few pixels above, and the difference between
          // them is the whole page.
          actionLabel={`Turn ${switchingOff.tag} off`}
          actionVariant={props.mode === 'live' ? 'destructive' : 'primary'}
          isActionLoading={patching.has(switchingOff.tag)}
          onAction={() => {
            const row = switchingOff
            setSwitchingOff(null)
            if (row !== null) apply(row, switchPatch(false))
          }}
        />
      ) : null}

      {removing !== null ? (
        <AlertDialog
          isOpen
          onOpenChange={() => setRemoving(null)}
          title={`Remove ${removing.tag} from the ${props.mode} table?`}
          description={
            `It stops being listed here and nothing it sends in ${props.mode} can trade. ` +
            'Its other mode, its live lots and its autostart are untouched, and it can be ' +
            'added back. A row still holding an open position is refused — remove is not a ' +
            'way to close anything.'
          }
          actionLabel={`Remove from ${props.mode}`}
          onAction={() => {
            const row = removing
            setRemoving(null)
            void remove(row)
          }}
        />
      ) : null}

      {adding ? (
        <AddStrategyDialog
          mode={props.mode}
          rows={everything?.strategies ?? []}
          onClose={() => setAdding(false)}
          onCreated={refresh}
        />
      ) : null}
      {/* Its own `isOpen` handles the null row, so it needs no conditional here. */}
      <FlattenDialog
        row={flattening}
        mode={props.mode}
        onClose={() => { setFlattening(null); refresh() }}
      />
      {settings !== null ? (
        <SettingsDialog
          row={settings}
          onClose={() => setSettings(null)}
          onSave={(patch) => apply(settings, patch)}
        />
      ) : null}
      {reauth.dialog}
    </VStack>
  )
}

// --------------------------------------------------------- per-strategy page

/**
 * A leg of this strategy's position, straight off its P&L row.
 *
 * WHY NOT `desk-books` (2026-07-28). This table used to fan out over
 * `api.books(mode)` and filter each book's legs by `deskTag`. But `desk-books`
 * is written ONLY by the Python desk's `declare` — a hosted strategy owns its
 * position internally and journals fills, so the fan-out returned nothing and
 * every hosted tag rendered "No open legs under this tag" beside a P&L that had
 * just counted six of them. Worse, the disagreement banner fired on what is the
 * NORMAL state for a hosted strategy, so the page cried wolf all session.
 *
 * The legs were never missing: the P&L tick nets them out of the same fills it
 * computes the number from, and `openLegs` was the surviving count of exactly
 * this list. Reading it here means the count and the table cannot disagree, and
 * it costs no extra request — the row is already on screen.
 */
type TaggedLeg = PnlLeg & Record<string, unknown>

/**
 * THE LADDER THIS TABLE OPENS IN, and the one key that reorders it.
 *
 * Same shape and same default as the Positions page (`pages.tsx`): calls above
 * puts, strike falling down the screen, so the book reads as the option chain
 * it is. Clicking Contract flips it; the numeric columns sort too, which the
 * Positions page deliberately does not allow — see `legColumns`.
 *
 * Module scope so the initial state is one object rather than a fresh one per
 * render, and so the key cannot drift from the comparator naming it.
 */
const LEG_LADDER_KEY = 'contract'
const LEG_LADDER: TableSortState = [{ sortKey: LEG_LADDER_KEY, direction: 'descending' }]

/**
 * `compareLadder`'s rule, over a leg that carries only its SYMBOL.
 *
 * The Positions page sorts `PositionRow`, which has `strike` and `type` on it
 * already. A `PnlLeg` is netted from fills and has neither, so the packing is
 * parsed — through `parseContract`, the same function `formatContract` renders
 * with, so the strike a row sorts by is the strike printed in its cell.
 *
 * COMPARED, NOT SUBTRACTED, and an unparseable symbol sorts to the ascending
 * end rather than producing NaN: `Array.prototype.sort` reads NaN as "equal",
 * which scrambles the order of the rows AROUND it, not just its own.
 */
function compareLegLadder(a: PnlLeg, b: PnlLeg): number {
  const parsed = (l: PnlLeg): ReturnType<typeof parseContract> => parseContract(l.tradingsymbol)
  const rank = (l: PnlLeg): number => {
    const t = parsed(l)?.type
    return t === 'CE' ? 2 : t === 'PE' ? 1 : 0
  }
  const byType = rank(a) - rank(b)
  if (byType !== 0) return byType

  const strike = (l: PnlLeg): number => {
    const k = parsed(l)?.strike
    return typeof k === 'number' && Number.isFinite(k) ? k : Number.NEGATIVE_INFINITY
  }
  const sa = strike(a)
  const sb = strike(b)
  return sa < sb ? -1 : sa > sb ? 1 : 0
}

/**
 * The X on the per-strike close button.
 *
 * Inline rather than from an icon package because the design system ships no
 * icon set and this is the only glyph the page needs. `currentColor` so it
 * takes the button variant's own text colour in both themes — a hard-coded
 * stroke would go invisible on one of them.
 */
function CloseGlyph(): React.ReactElement {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true" focusable="false">
      <path
        d="M3.5 3.5 L10.5 10.5 M10.5 3.5 L3.5 10.5"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
    </svg>
  )
}

/**
 * The price a side was actually traded at, or an em-dash when there is no side.
 *
 * The API returns cash traded (`buyValue`) and size traded (`buyQty`), never
 * the average, so the division happens here. Amounts are not shown alongside:
 * an amount is `qty x avg` and recoverable at a glance, whereas an average
 * cannot be recovered from an amount without dividing — and the average is the
 * number compared against LTP to judge a fill.
 *
 * GUARD: DIVIDE BY ZERO. A contract traded on ONE side only — every open leg
 * of a short strangle, for instance — has `buyQty === 0`, and `0 / 0` is
 * `NaN`. A side with nothing traded on it has no average price, which is a
 * different fact from an average of zero, so it gets the same em-dash this
 * page uses everywhere else for "not known". `inr` would already catch the
 * non-finite result, but relying on that leaves the intent unstated and would
 * silently render `0` the day the numerator is a non-zero value against a zero
 * quantity.
 */
function avgPrice(value: number, qty: number): string {
  if (!Number.isFinite(qty) || qty === 0) return '—'
  return inr(value / qty, 2)
}

/**
 * A contract name: truncated with an ellipsis, NEVER broken across two lines.
 *
 * `SENSEX26JUL77200CE` breaking after the `C` has been a bug on this page once
 * already. A wrapped symbol is not a shorter symbol, it is a different-looking
 * one — and two strikes that differ in their last three characters become
 * indistinguishable at a glance the moment the line breaks somewhere else on
 * each row.
 *
 * An ELLIPSIS and not a hard clip: astryx's table cells already carry
 * `overflow: hidden`, so a name too long for its column would simply be cut
 * mid-character with nothing to say it had been. The "…" is the difference
 * between a shortened name and a wrong one. `minWidth: 0` is what lets it
 * happen at all — the name sits in a flex row beside the `no mark` badge, and
 * a flex item's automatic minimum size is its own content.
 */
const CONTRACT: React.CSSProperties = {
  whiteSpace: 'nowrap',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  minWidth: 0,
  display: 'block',
}

/**
 * The first IST day a BOOK's order log should cover: the day it was registered.
 *
 * A positional book lives until its monthly expiry, so the trade that opened it
 * — the one an operator is most often looking for — is weeks behind the current
 * session. `createdAt` is the only record of when that was.
 *
 * `createdAt` IS 0 ON A ROW WRITTEN BEFORE THE FIELD EXISTED, which is the one
 * case where the open day is genuinely unknown. 90 days is what the reports page
 * already defaults its range to, and comfortably outruns a monthly book; the
 * alternative, `istDate(0)`, would ask the journal for every event since 1970.
 */
function bookLogStart(book: BookRow, today: string): string {
  return book.createdAt > 0 ? istDate(book.createdAt) : istDaysBefore(today, 90)
}

/**
 * One strategy, in the mode the navbar switch says.
 *
 * NO MODE CONTROL HERE either. The page used to carry its own paper/live
 * buttons, which is one of the six mechanisms that made the dashboard hard to
 * read; the badge below states which book these figures are, and the switch
 * above changes it.
 */
/**
 * What the strategy says it is doing, and what it has actually done.
 *
 * THE REASON IS PRINTED VERBATIM. It is generated by the Python rule engine
 * ("recenter-otm: netΓ -3.8 — allowance 188 under one lot (225); no convexity
 * to centre") and its wording changes whenever a playbook does, so nothing
 * here parses it, shortens it or re-words it. The numbers in that sentence
 * ARE the content — the 2026-08-05 question turned on `allowance 188` against
 * a lot size of 225, and a truncated version would have answered nothing.
 *
 * THREE STATES, deliberately distinguished:
 *   - no reason at all      -> the desk has not reported one (or predates this)
 *   - a reason, no actions  -> the NORMAL state of a healthy quiet book
 *   - a reason and actions  -> both
 * Collapsing the first two would make a working book look broken on the day it
 * opens, which is exactly when an operator is watching it hardest.
 */
/**
 * The current reason as ONE ROW, for the top of the run page.
 *
 * Sits above the positions table because that is where the question gets
 * asked: the greek tiles say delta-neutral has drifted, and the next thing an
 * operator wants is whether the strategy means to act. Scrolling past the
 * whole book to find that out is what this removes.
 *
 * ONE LINE, ELLIPSIS, never wraps. Its whole value is being free — it must not
 * push the tiles or the table down the page, and it must not change height
 * when the reason changes, or the layout would jump every mark. The panel
 * lower down prints the same string in full, so nothing is lost to the clip.
 *
 * RENDERS NOTHING when there is no reason yet, rather than a placeholder row.
 * An empty strip above the book would be permanent furniture on every page
 * that has never reported one.
 */
export function StrategyReasonLine(props: { decisions: BookDecisions | null }): React.ReactElement | null {
  const d = props.decisions
  if (d === null || typeof d !== 'object') return null
  if (typeof d.lastReason !== 'string' || d.lastReason === '') return null
  return (
    <Card>
      <HStack gap={2} align="center" padding={2}>
        <Text size="sm" color="secondary" style={NOWRAP}>
          Strategy
        </Text>
        {typeof d.lastAction === 'string' && d.lastAction !== '' ? (
          <Badge variant="neutral" label={d.lastAction} />
        ) : null}
        <Text size="sm" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {d.lastReason}
        </Text>
        {typeof d.lastReasonAt === 'number' ? (
          <Text size="sm" color="secondary" style={NOWRAP}>
            {localTime(d.lastReasonAt)}
          </Text>
        ) : null}
      </HStack>
    </Card>
  )
}

export function StrategyReasonPanel(props: { decisions: BookDecisions | null }): React.ReactElement {
  const d = props.decisions
  if (d === null || typeof d !== 'object') return <Text color="secondary">Loading…</Text>

  /**
   * NARROWED, NOT TRUSTED — and the reason is worth stating.
   *
   * This panel is the LAST thing on the page and the least important: it
   * explains the book, where everything above it is evidence about the book.
   * A malformed payload here throwing would unmount the positions table, the
   * order log and the P&L chart along with it, so the one surface an operator
   * needs when something is wrong would be taken down by the one panel that
   * matters least. Every field is therefore checked before use rather than
   * trusted from the type, which describes the server's intent, not the bytes
   * that actually arrived.
   */
  const actions = Array.isArray(d.actions) ? d.actions : []
  return (
    <VStack gap={3}>
      <VStack gap={1}>
        <HStack gap={2} align="center">
          <Text size="sm" color="secondary">
            Now
          </Text>
          {typeof d.lastReasonAt !== 'number' ? null : (
            <Text size="sm" color="secondary" style={NOWRAP}>
              {localTime(d.lastReasonAt)}
            </Text>
          )}
          {typeof d.lastAction !== 'string' || d.lastAction === '' ? null : (
            <Badge variant="neutral" label={d.lastAction} />
          )}
        </HStack>
        {typeof d.lastReason !== 'string' || d.lastReason === '' ? (
          /*
            NOT an error, and worded so it does not read as one: a book whose
            supervisor has not shipped the reason field yet is working fine.
          */
          <Text color="secondary">
            No reason recorded yet — the desk reports one on its next mark.
          </Text>
        ) : (
          /*
            `pre-wrap` so the engine's own line breaks survive, and
            `break-word` so a long unbroken figure wraps instead of widening
            the grid cell and pushing the P&L chart off its row.
          */
          <Text style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{d.lastReason}</Text>
        )}
      </VStack>

      <VStack gap={1}>
        <Text size="sm" color="secondary">
          Actions
        </Text>
        {actions.length === 0 ? (
          <Text color="secondary">
            Nothing traded since this book opened.
          </Text>
        ) : (
          /*
            Oldest first — the entry structure reads at the top, as it
            happened. Scrolled inside itself so a long history cannot stretch
            this grid row; see `.strategy-actions-scroll`.
          */
          <VStack gap={2} className="strategy-actions-scroll">
            {actions.map((a, ai) => {
              // Typed explicitly: `Array.isArray` widens to `any[]` and would
              // make every field below implicitly `any`.
              const fills: DecisionActionRow['fills'] = Array.isArray(a?.fills) ? a.fills : []
              const key = typeof a?.decisionId === 'string' ? a.decisionId : `row:${String(ai)}`
              return (
                <VStack gap={0} key={key}>
                  <HStack gap={2} align="center">
                    {typeof a?.at !== 'number' ? null : (
                      <Text size="sm" style={NOWRAP}>
                        {localDayTime(a.at)}
                      </Text>
                    )}
                    {typeof a?.action !== 'string' || a.action === '' ? null : (
                      <Badge variant="neutral" label={a.action} />
                    )}
                    <Text size="sm" color="secondary">
                      {fills.length === 1 ? '1 leg' : `${String(fills.length)} legs`}
                    </Text>
                  </HStack>
                  {fills.map((f, i) => (
                    <Text size="sm" color="secondary" key={`${key}:${String(i)}`}>
                      {`${String(f?.side ?? '')} ${String(f?.qty ?? '')} ${String(f?.tradingsymbol ?? '')}`.trim() +
                        (typeof f?.price === 'number' ? ` @ ${inr(f.price, 2)}` : '')}
                    </Text>
                  ))}
                  {typeof a?.reason !== 'string' || a.reason === '' ? null : (
                    <Text size="sm" color="secondary" style={{ overflowWrap: 'anywhere' }}>
                      {a.reason}
                    </Text>
                  )}
                </VStack>
              )
            })}
          </VStack>
        )}
      </VStack>
    </VStack>
  )
}

export function StrategyPage(props: { tag: string; mode: DeskMode }): React.ReactElement {
  const mode = props.mode
  /*
    Column widths are INLINE STYLES on the `<th>` — astryx computes them from
    the `pixel()`/`proportional()` definitions — so a stylesheet cannot reach
    them without `!important`, and this file's rule is that nothing needs one.
    The breakpoint is therefore read here. See `PHONE` in shell.tsx.
  */
  const phone = useMedia(PHONE)
  const { data: registry, error: regError, refresh } = usePoll(() => api.allStrategies(), 10_000)
  const row = (registry?.strategies ?? []).find((s) => s.tag === props.tag) ?? null
  const reauth = useReauth()
  const [note, setNote] = useState<string | null>(null)
  const [settings, setSettings] = useState<StrategyRow | null>(null)
  /**
   * CLOSING ONE STRIKE: the leg awaiting confirmation, the one in flight, and
   * the last refusal.
   *
   * `closeError` is a BANNER rather than a toast on purpose. The realistic
   * refusal — "the book is not running", "nothing open on that contract" —
   * carries a sentence the operator has to act on, and a message that
   * disappears on a timer is one they will have half-read.
   */
  const [closing, setClosing] = useState<PnlLeg | null>(null)
  const [closingNow, setClosingNow] = useState<string | null>(null)
  const [closeError, setCloseError] = useState<string | null>(null)
  const [closed, setClosed] = useState<string | null>(null)

  /**
   * STREAMED, AND NARROWED TO THIS TAG.
   *
   * The LTP and MTM columns below are the reason this page is open during a
   * move, and a 10s poll made them sit still between refreshes. The socket now
   * carries them.
   *
   * The tag list is a BANDWIDTH hint to the shared socket, not a filter on what
   * is rendered — the connection subscribes to the UNION of what its consumers
   * want, so rows for other tags arrive legitimately whenever another consumer
   * on this tab asked for them. `find` below is what decides what belongs to
   * this strategy, exactly as it did before.
   *
   * THE REST CALL IS UNCHANGED and still fetches every strategy. Narrowing the
   * endpoint is a bigger, separate change.
   */
  const tagOnly = useMemo(() => [props.tag], [props.tag])
  const { data: pnl, error: pnlError } = useLivePnl(mode, tagOnly)
  const mine = (pnl?.strategies ?? []).find((s) => s.tag === props.tag) ?? null
  /**
   * Null while the first read is in flight, `[]` once it lands and this tag
   * holds nothing. A tag with no row in the response is genuinely flat — the
   * summary omits strategies with no position and no realised P&L — so it is
   * an empty list, not an unknown.
   */
  const legs: PnlLeg[] | null = pnl === null ? null : (mine?.legs ?? [])

  const today = istDate()
  /**
   * IS THIS TAG A POSITIONAL BOOK, AND SINCE WHEN?
   *
   * `desk-books-registry` is the answer to both, and the only one: a book row
   * exists for exactly the tags that are held across sessions, and it carries
   * the day the book was created. A hosted intraday strategy has no row here,
   * `book` stays null, and everything below reads the single day it always did.
   *
   * SLOW POLL, because `createdAt` never changes. The list is small and already
   * fetched on the Books page; this is one request a minute to learn a fact
   * about the tag on screen, not a live figure. Until it lands the log is
   * today's — the first paint is not delayed for a book's back-history.
   */
  const { data: bookRows } = usePoll(() => api.bookRegistry.list(mode), 60_000, [mode])
  const book = (bookRows ?? []).find((b) => b.tag === props.tag) ?? null
  /** The first day of the order log: this session for a strategy, the whole
   *  life of the book for a book. */
  const logFrom = book === null ? today : bookLogStart(book, today)
  /**
   * STREAMED. It was the SECOND surface on the socket, beside the desk-wide
   * Orders page; that page is gone (2026-08-16) and this is the only one left,
   * which is why `useStreamedPoll` still earns its keep.
   *
   * A fill on this tag now lands here as soon as the rail journals it, instead
   * of up to 8s later. The push is only a NUDGE: it re-fetches this exact
   * endpoint rather than carrying rows, so the tag correlation inside
   * `api.reportOrders` — the whole-day fetch that a server-side `?tag=` filter
   * would break, since the gateway writes a STATUS event with `tag: ''` for an
   * order it cannot resolve (a fill that raced `markPlaced`); a resolved
   * order's STATUS carries its tag (`fills.ts`) — is untouched and stays the
   * only thing that decides what belongs to this strategy.
   *
   * `degraded` drives the notice below. A socket that dies silently while the
   * page keeps showing its last fills is the failure this costs one line to
   * avoid.
   */
  const { data: orders, error: orderError, degraded: ordersDegraded } = useStreamedPoll(
    () => api.reportOrders(today, mode, props.tag, false, logFrom),
    mode,
    [props.tag, today, logFrom],
  )
  /**
   * The strategy's own account of itself.
   *
   * POLLED, NOT STREAMED, and slower than the order log on purpose: the reason
   * is rewritten every mark whether or not anything happened, so there is no
   * event to push and nothing is lost by reading it a few seconds late. 10s
   * against a ~30s mark cadence means the panel is never more than one mark
   * behind.
   *
   * Errors are deliberately not surfaced. This panel explains the book; it is
   * not evidence about it, and an error banner here would sit under a healthy
   * order log implying the book itself is in trouble.
   */
  const { data: decisions } = usePoll(
    () => api.bookRegistry.decisions(props.tag, mode),
    10_000,
    [props.tag, mode],
  )
  const { data: series, error: seriesError } = usePoll(
    () => api.pnlSeries(props.tag, mode), 15_000, [props.tag, mode],
  )

  /**
   * The position book, in the order an operator reads it: what it is worth NOW
   * (LTP, net qty, MTM) before how it got there (the two sides of the trade).
   *
   * The last row is the TOTAL, carried in the same table rather than beside it
   * so the figures sit under the columns they sum. A total in its own block
   * has to restate the column names to be legible, and then the two can drift.
   */
  /**
   * CLOSE ONE STRIKE, from the row it is read on.
   *
   * `decisionId` is minted per attempt and is what makes a double-click safe —
   * the endpoint dedupes on the same unique index `close-all` uses.
   *
   * NO OPTIMISTIC UPDATE. The row keeps showing the position until the P&L poll
   * says otherwise, because the only thing worse than a slow table here is one
   * that shows a leg as closed when the exit did not fill. `closed` reports what
   * actually came back.
   */
  const closeLeg = async (l: PnlLeg): Promise<void> => {
    setCloseError(null)
    setClosed(null)
    setClosingNow(l.tradingsymbol)
    try {
      const r = await api.bookRegistry.closeLeg(
        props.tag,
        mode,
        l.tradingsymbol,
        `opclose:${props.tag}:${mode}:${l.tradingsymbol}:${Date.now()}`,
      )
      /*
        A 200 WITH NO FILLS IS NOT A CLOSE, and must not be worded like one.

        The realistic case is AFTER HOURS: `MarksCache.feedAlive()` goes false
        once ticks stop, `marks.price()` then answers null, and `applyActions`
        SKIPS the close rather than pricing it off a dead feed — which is the
        right call, and no order is written. But the first version of this line
        began "Closed …" and appended ", 1 skipped", so the operator was told
        their leg was closed at the exact moment nothing had happened. That is
        the same failure the endpoint's own 409s shout NOTHING WAS CLOSED about.

        The skip carries the reason ("no mark for BHEL26AUG410PE"), so it is
        shown rather than paraphrased.
      */
      if (r.fills.length === 0) {
        const why = r.skips.map((s) => s.reason).filter((x) => typeof x === 'string')
        setCloseError(
          `Nothing was closed — ${formatContract(l.tradingsymbol)} is still open. ` +
            (why.length > 0
              ? why.join('; ')
              : 'The desk accepted the request but routed no order.') +
            ' With no live quote an exit cannot be priced;' +
            ' the position is unchanged.',
        )
        return
      }
      setClosed(
        `Closed ${formatContract(l.tradingsymbol)} — ${r.fills.length} order(s) routed` +
          (r.unpriceable.length > 0 ? `, ${r.unpriceable.length} at the fast price (no mark)` : '') +
          (r.skips.length > 0 ? `, ${r.skips.length} skipped` : ''),
      )
    } catch (err) {
      // The server's own sentence, verbatim. Its refusals name what to do next
      // ("start the book first", "it holds X, Y, Z") and paraphrasing them here
      // would lose exactly the part the operator needs.
      setCloseError(explain(err))
    } finally {
      setClosingNow(null)
    }
  }

  const legColumns: TableColumn<TaggedLeg>[] = [
    /*
      NOWRAP, AND WIDE ENOUGH FOR THE LONGEST SYMBOL.

      In the two-column layout this table lives in ~58% of the page, and a
      `proportional` Contract column shrank below the width of its own text —
      so `SENSEX26JUL77200CE` broke after the `C` and every row went
      double-height. A contract name split across two lines is not a smaller
      contract name, it is an unreadable one. Fixed width plus nowrap means the
      table scrolls inside its own wrapper instead, which is the behaviour the
      layout was designed around.
    */
    { key: 'tradingsymbol', header: 'Contract', width: pixel(phone ? 130 : 155),
      /*
        SORTED BY THE LADDER, NOT BY THE SYMBOL. `ITC26AUG277.5PE` sorts
        alphabetically between `ITC26AUG2750CE` and `ITC26AUG280PE` — the
        packing puts a year and a month ahead of the one number being compared
        and glues the type on the end. `compareLegLadder` reads the strike and
        type out of it instead.
      */
      sortable: { sortKey: LEG_LADDER_KEY },
      renderCell: (l) => (
        <HStack gap={2} align="center">
          <Text
            weight={l['isTotal'] === true ? 'bold' : 'medium'}
            /*
              A SIZE DOWN ON A PHONE, so the narrower column still holds the
              WHOLE name. `SENSEX26JUL77200CE` is 18 characters: ~126px at the
              14px body size, ~108px at the 12px one, against a 140px column
              whose compact padding spends 16 of it. Shrinking the type is what
              makes 140px a truncation that almost never fires, rather than one
              that clips every SENSEX weekly.

              `exactOptionalPropertyTypes` IS WHY THIS SPREADS RATHER THAN
              PASSING `undefined`. `apps/web/tsconfig.json` sets it, so an
              explicit `size={undefined}` is NOT the same as omitting `size`
              and is rejected — while the ROOT tsconfig does not set it, so
              `npm run typecheck` at the repo root passes and only the
              dashboard's own build fails. Omitting the prop is the fix; the
              spread is how you omit one conditionally.
            */
            {...(phone ? { size: 'sm' as const } : {})}
            style={CONTRACT}
          >
            {formatContract(l.tradingsymbol)}
          </Text>
          {/*
            NO "closed" CHIP — `Net qty` already says it, with a 0.

            The `no mark` badge STAYS, and the distinction it draws is the
            reason: a closed round trip and an open leg the feed could not
            price both render an em-dash under LTP, and they mean opposite
            things — one is over, the other is carrying live risk of unknown
            size. Net qty separates them (0 vs non-zero), so the chip was
            redundant; the warning is not, because nothing else on the row
            flags an open position we cannot value.
          */}
          {l['isTotal'] !== true && l.qty !== 0 && l.mark === null
            ? <Badge variant="warning" label="no mark" />
            : null}
        </HStack>
      ) },
    /*
      LTP RENDERS FOR CLOSED ROWS TOO. After a round trip, where the contract
      is trading NOW is how you judge whether the exit was early or late, and
      the em-dash that used to sit here answered nothing. Only the TOTAL row
      dashes it — there is no such thing as the last traded price of a book.
    */
    /*
      THE NUMERIC COLUMNS SORT HERE, WHERE THE POSITIONS PAGE'S DO NOT.

      That page's reasoning is that its risk columns are read against the row's
      own contract rather than against each other, which is true there. This
      table is where a decayed short gets FOUND — the whole point of the close
      button beside it — and "which leg is nearly worthless" is a question
      about LTP across rows, "which is hurting" one about MTM. Both are orders
      an operator asks for out loud.

      Buy/Sell avg stay unsorted: an average is read against its own row's LTP,
      and ordering the book by one side's entry price answers nothing.
    */
    { key: 'mark', header: 'LTP', align: 'end', width: pixel(phone ? 72 : 80), sortable: true,
      renderCell: (l) => (
        <Text>{l['isTotal'] === true || l.mark === null ? '—' : inr(l.mark, 2)}</Text>
      ) },
    /*
      MTM BEFORE NET QTY, on every width.

      Column order IS the priority list on a narrow screen — the leftmost
      columns are the ones that survive before the table starts scrolling, and
      the first thing anyone asks of a position is what it is worth, not how
      many lots it is. Desktop follows the same order rather than diverging,
      because two orderings of the same table is a thing to re-learn every time
      the window changes size.

      AND ON A PHONE IT HAS TO BE VISIBLE WITHOUT SCROLLING THE TABLE, which
      is arithmetic, not intent. A 390px screen less the page's 12px padding
      and the card's 12px leaves 342px. Contract 140 + LTP 80 + MTM 100 = 320,
      so MTM lands inside the viewport with room to spare; at the desk widths
      (210 + 90) it was the third column of a table that starts scrolling at
      the second. Net qty and the two averages keep their widths and are
      reached by swiping the table — which is the right thing to have to swipe
      for.

      An em-dash, never a ₹0: an open leg the feed could not price contributes
      an UNKNOWN, and a confident zero beside real risk is the one rendering
      this page must never produce.
    */
    { key: 'mtm', header: 'MTM', align: 'end', width: pixel(phone ? 95 : 105), sortable: true,
      renderCell: (l) => (
        l.mtm === null
          ? <Text color="secondary">—</Text>
          : <Text weight={l['isTotal'] === true ? 'bold' : 'medium'} style={sign(l.mtm)}>
              {signed(l.mtm)}
            </Text>
      ) },
    { key: 'qty', header: 'Net qty', align: 'end', width: pixel(85), sortable: true,
      renderCell: (l) => (
        l['isTotal'] === true
          ? <Text color="secondary">—</Text>
          : l.qty === 0
            ? <Text color="secondary">0</Text>
            : <Text style={sign(l.qty)}>{signed(l.qty)}</Text>
      ) },
    /*
      NO BUY/SELL QUANTITY COLUMNS, at the operator's call.

      They cost ~170px that the contract name needed more, and `Net qty` plus
      the order log already answer "how much". The reconciliation identity they
      used to make visible — net qty === buy qty - sell qty — is now only
      checkable against the order log rather than within this row. That is the
      trade: a readable contract name over an at-a-glance cross-check.

      GUARD: NO AVERAGE ON THE TOTAL ROW.

      Quantities sum — 30 bought plus 10 bought is 40 bought. Averages do not:
      the mean of two contracts' average prices is not the average price of
      anything, and the size-weighted figure it would have to be instead is a
      blended price across two different strikes that nobody trades at. A
      number that describes nothing is worse in a P&L column than a blank, so
      both average columns say "not applicable" out loud.
    */
    { key: 'buyAvg', header: 'Buy avg', align: 'end', width: pixel(85),
      renderCell: (l) => (
        l['isTotal'] === true
          ? <Text size="sm" color="secondary">—</Text>
          : <Text size="sm">{avgPrice(l.buyValue, l.buyQty)}</Text>
      ) },
    { key: 'sellAvg', header: 'Sell avg', align: 'end', width: pixel(85),
      renderCell: (l) => (
        l['isTotal'] === true
          ? <Text size="sm" color="secondary">—</Text>
          : <Text size="sm">{avgPrice(l.sellValue, l.sellQty)}</Text>
      ) },
    /*
      CLOSE THIS STRIKE.

      A blank header — the icon says what it is, and a "Close" heading over a
      column of buttons reads as a status ("closed?") in a table that already
      has closed rows in it.

      NO BUTTON ON THE TOTAL ROW OR A FLAT ONE. The total is not a position, and
      a flat contract has nothing to close: rendering a live-looking button that
      can only ever 409 invites the click and then explains why it was pointless.

      ONLY FOR A REGISTERED BOOK. A hosted intraday strategy has no registry row
      and no `desk-books` document, so this endpoint has nothing to act on — its
      position exists only as journalled fills, which is what `close-all` by tag
      is for. The column is hidden entirely rather than shown disabled, because a
      permanently dead control is noise on every row.
    */
    ...(book === null
      ? []
      : [{
          key: 'close', header: '', align: 'end' as const, width: pixel(44),
          renderCell: (l: TaggedLeg) =>
            l['isTotal'] === true || l.qty === 0 ? null : (
              <Button
                variant="secondary"
                size="sm"
                isIconOnly
                icon={<CloseGlyph />}
                label={`Close ${formatContract(l.tradingsymbol)}`}
                tooltip={`Close ${formatContract(l.tradingsymbol)}`}
                isLoading={closingNow === l.tradingsymbol}
                isDisabled={closingNow !== null}
                onClick={() => setClosing(l)}
              />
            ),
        }]),
  ]

  /**
   * The rows plus a TOTAL, or null while the first read is in flight.
   *
   * MTM sums to `null` the moment ANY open leg is unmarked — the same rule the
   * P&L card obeys. Summing the legs that DID price would produce a confident
   * figure that is understated by an unknown amount, which is worse than
   * admitting the total is not known.
   */
  /*
    SORTED, BUT THE TOTAL IS NOT PART OF THE SORT.

    The total is a row of this table rather than a block beside it, so its
    figures sit under the columns that produced them — but it is a SUMMARY, and
    sorting it with the legs would file it by its own MTM somewhere in the
    middle of the book. So only the legs go through the sort and the total is
    appended to the result below.

    UNCONDITIONAL, like every hook here: it sorts `[]` while the first read is
    in flight rather than being skipped, which is what keeps the hook order
    identical across the loading, error and loaded renders.
  */
  const { sortedData: sortedLegs, sortConfig } = useTableSortableState<TaggedLeg>({
    data: (legs ?? []) as TaggedLeg[],
    defaultSort: LEG_LADDER,
    comparators: { [LEG_LADDER_KEY]: compareLegLadder },
    allowUnsortedState: false,
  })
  const sortPlugin = useTableSortable<TaggedLeg>(sortConfig)

  const legRows: TaggedLeg[] | null = legs === null ? null : (() => {
    if (legs.length === 0) return []
    const anyUnknown = legs.some((l) => l.mtm === null)
    const sum = (pick: (l: PnlLeg) => number): number => legs.reduce((n, l) => n + pick(l), 0)
    /**
     * FOR A DESK BOOK, THE TOTAL IS THE BOOK'S — `sinceEntry` off the server,
     * the same figure the book page's tile, table foot and P&L chip show
     * (operator's call 2026-08-18: one P&L per stock book, everywhere). The
     * per-contract rows above stay the journal's reconstruction, and the two
     * can legitimately differ where entries were administratively restated —
     * the ROWS explain the trades, the TOTAL states the book. A hosted tag
     * has no book and keeps the journal sum, which for it IS the truth.
     */
    const total = {
      tradingsymbol: 'Total', qty: 0, avgCost: 0, mark: null, unrealised: null,
      realised: sum((l) => l.realised),
      buyQty: sum((l) => l.buyQty), buyValue: sum((l) => l.buyValue),
      sellQty: sum((l) => l.sellQty), sellValue: sum((l) => l.sellValue),
      mtm:
        mine?.sinceEntry !== undefined
          ? mine.sinceEntry
          : anyUnknown
            ? null
            : sum((l) => l.mtm ?? 0),
      isTotal: true,
    }
    return [...sortedLegs, total] as TaggedLeg[]
  })()


  const reason = row === null ? null : realReason(row)
  const added = row !== null && isAdded(row.modes, mode)

  return (
    /* gap 3, not 4: five stacked cards at gap 4 spent more of the page on the
       spaces between panels than on two of the panels themselves. */
    <VStack gap={3}>
      {/*
        THE HEADER WRAPS RATHER THAN RUNS OFF THE SIDE.

        At 390px this line — "BULL_SNX_1 PAPER running 8 open Bull SNX-1 SENSEX
        straddle Settings" — was one nowrap row wider than the screen, and the
        squeeze landed on the last item: `Settings` broke a character at a time
        into "Se/tti/ngs", because responsive.css lets a button's label wrap so
        long labels do not make the BUTTON wider than the phone. A word that
        cannot fit is a smaller word; a word broken into three is not a word.

        The fix is three classes and no new markup, so the desk is untouched:
        the description takes its own line below the tag (`.desk-strategy-label`
        is given `flex-basis: 100%` on a phone), and the button is told not to
        shrink and not to wrap — it wraps to its own line instead, whole. The
        rules are in responsive.css beside the breakpoint they belong to.
      */}
      <HStack gap={3} align="center" justify="between" wrap="wrap" className="desk-strategy-header">
        <HStack gap={3} align="center" wrap="wrap" className="desk-strategy-headline">
          <Heading level={2}>{props.tag}</Heading>
          <ModeBadge />
          {row !== null ? (
            <>
              <RuntimeCell row={row} />
              <Text color="secondary" className="desk-strategy-label">{row.label}</Text>
            </>
          ) : null}
        </HStack>
        {row !== null ? (
          <Button
            className="desk-strategy-settings"
            variant="ghost"
            label="Settings"
            onClick={() => setSettings(row)}
          />
        ) : null}
      </HStack>

      {regError !== null ? (
        <Banner status="error" title="Registry unavailable" description={regError} />
      ) : null}
      {note !== null ? (
        <Banner status="error" title="That change was not applied" description={note} />
      ) : null}
      {registry !== null && row === null ? (
        <Banner
          status="warning"
          title={`${props.tag} is not in the registry`}
          description="An unregistered tag is rejected by the gate, so nothing it sends can trade. The figures below are whatever is still recorded against the name."
        />
      ) : null}
      {/*
        THREE STATES, SAID IN THREE DIFFERENT SENTENCES. "Not added to live" and
        "added to live but switched off" are different situations with different
        fixes, and collapsing them into "off" is what the boolean did.
      */}
      {row !== null && !added ? (
        <Banner
          status="info"
          title={`${props.tag} is not on the ${mode} table`}
          description={`Nothing it sends in ${mode} can trade. Add it from Strategies; it arrives switched off.`}
        />
      ) : null}
      {row !== null && added && !isOn(row.modes, mode) ? (
        <Text size="sm" color="secondary">
          {`Added to ${mode} but switched off — its orders in this mode are rejected, exits included.`}
        </Text>
      ) : null}
      {/* Only a reason a human recorded; an off switch does not need narrating. */}
      {reason !== null ? <Text size="sm" style={RED}>{reason}</Text> : null}
      {row?.runtime?.lastError !== undefined && row.runtime?.lastError !== null ? (
        <Banner status="error" title="Last runtime error" description={row.runtime.lastError} />
      ) : null}

      {/*
        ONE STRIP, NOT THREE CARDS.

        Three `2xl` figures in three full-width cards spent roughly a fifth of
        the viewport restating what is one line of arithmetic — Total =
        Realised + Unrealised — and pushed the positions table, which is what
        the page is actually for, below the fold. The numbers are unchanged and
        still read left to right; they just no longer need a screenful. Total
        stays the emphasised one because it is the figure being looked for.
      */}
      {pnlError !== null ? (
        <Banner status="error" title="P&L unavailable" description={pnlError} />
      ) : null}
      {mine !== null ? <UnpricedNote unpriced={mine.unpriced} /> : null}

      {/*
        THE THREE PANELS, IN TWO COLUMNS ON A WIDE SCREEN.

        NET POSITIONS FIRST, AND IT CARRIES THE TOTAL ITSELF. The page used to
        open with three `2xl` cards restating one line of arithmetic — Total =
        Realised + Unrealised — which cost a fifth of the viewport and pushed
        the table the page exists for below the fold. The table's own total row
        says the same thing under the columns that produced it, so the number
        is now checkable rather than merely stated.

        DOM ORDER IS THE NARROW-VIEWPORT ORDER: what you hold, then what
        happened (the order log), then the shape of the day (the chart). The
        chart is last because it is the only panel that answers no question on
        its own. On a wide screen `.strategy-grid` moves the LOG into its own
        right-hand column — by explicit placement, not by reordering this
        markup, so a screen reader still gets the order above. The reasoning
        for the split, and for not using the `Grid` component, is in
        comfort.css beside the rules.

        The wrappers are plain `div`s because the classes have to land on the
        GRID ITEMS themselves, and a `Card` is free to render whatever element
        it likes underneath.
      */}
      {/*
        THE CURRENT REASON, ONE LINE, ABOVE EVERYTHING.

        The full panel lower down carries the history; this is the glance
        version, and it sits here because the question it answers is asked
        while looking at the greeks, not after scrolling past them: the tiles
        above say delta-neutral has drifted, and the very next thing an
        operator wants is whether the strategy intends to do anything about it.

        Deliberately ONE ROW and clipped with an ellipsis. Its job is to be
        readable without moving the tiles or the positions table down the page;
        the panel below prints the same string in full.
      */}
      <StrategyReasonLine decisions={decisions} />

      <div className="strategy-grid">
        <div className="strategy-grid-positions">
          <Card>
            <VStack gap={2} padding={3}>
              <HStack justify="between" align="center">
                <Heading level={3}>Net positions</Heading>
                <Text size="sm" color="secondary">
                  {legs === null
                    ? ''
                    : `${legs.filter((l) => l.qty !== 0).length} open, ${legs.filter((l) => l.qty === 0).length} closed`}
                </Text>
              </HStack>
              {/*
                NO SEPARATE ERROR OR LOADING STATE. These legs arrive on the P&L
                row, so `pnlError` above already reports a failed read once, and a
                second banner for the same request said the same thing twice.
              */}
              {pnl === null && pnlError === null ? <Text color="secondary">Loading…</Text> : null}
              {legRows !== null && legRows.length === 0 ? (
                <Text color="secondary">This tag has not traded today.</Text>
              ) : null}
              {/*
                THE OUTCOME OF A PER-STRIKE CLOSE, under the table it changed.

                Both are banners rather than toasts: a refusal here names what
                to do next ("start the book first", "it holds X, Y, Z") and a
                message that vanishes on a timer is one that gets half-read. The
                success line stays too — an operator wants to see how many
                orders actually routed, not just that the click registered.
              */}
              {closeError !== null ? (
                <Banner
                  status="error"
                  title="The strike was not closed"
                  description={closeError}
                />
              ) : null}
              {closed !== null ? <Banner status="success" title={closed} /> : null}
              {legRows !== null && legRows.length > 0 ? (
                <Table
                  data={legRows}
                  columns={legColumns}
                  density="compact"
                  hasHover
                  plugins={{ sort: sortPlugin }}
                />
              ) : null}
            </VStack>
          </Card>
        </div>

        <div className="strategy-grid-log">
          <Card>
            <VStack gap={2} padding={3}>
              <HStack justify="between" align="center">
                <Heading level={3}>Order log</Heading>
                {/*
                  THE PANEL SAYS WHAT IT COVERS. It read `<today> IST` under
                  every log, which is a claim about the window and was wrong for
                  a book whose log now starts the day it was opened.
                */}
                <Text size="sm" color="secondary">
                  {logFrom === today ? `${today} IST` : `${logFrom} → ${today} IST`}
                </Text>
              </HStack>
              {orderError !== null ? (
                <Banner status="error" title="The order log could not be loaded" description={orderError} />
              ) : null}
              {/* Says so when the push is gone, rather than looking live. */}
              {ordersDegraded ? <LiveFeedNotice /> : null}
              {orders !== null && orders.events.length === 0 ? (
                /*
                  The old copy here said paper orders "are not journalled" — true of
                  `desk-order-events`, and wrong as a statement about paper, whose
                  fills the paper rail writes to `desk-paper-trade`. Both are now
                  merged server-side, so an empty log genuinely means nothing traded.
                */
                <Text color="secondary">
                  {logFrom === today
                    ? 'No orders from this tag today.'
                    : `No orders from this tag since it was opened on ${logFrom}.`}
                </Text>
              ) : null}
              {orders !== null && orders.events.length > 0 ? (
                /*
                  Capped and scrolled inside — see `.strategy-log-scroll`. The log
                  spans both left-hand rows, so an untamed one sized the grid and
                  pushed the P&L chart away from the positions table it is read
                  against. The heading and date stay outside the box so it is
                  clear what is scrolling.
                */
                <div className="strategy-log-scroll">
                  {/*
                    ONE ROW PER ORDER, the lifecycle a click away. This panel
                    used to render the raw journal, where one 3-lot order was
                    eleven rows — twice over, because the broker echoes its own
                    contract spelling — so the log the page is read against was
                    mostly repetition of itself. See `orderlog.tsx`.
                  */}
                  <OrderLogTable events={orders.events} />
                </div>
              ) : null}
            </VStack>
          </Card>

        </div>

        {/*
          UNDER THE POSITIONS TABLE, not under the order log.

          It belongs on this side because it is read against what the book
          HOLDS: "no convexity to centre" is a statement about the legs in the
          table above it, and the figures in it — netΓ, the allowance, the lot
          size — are the ones being compared. The order log opposite answers a
          different question: what reached the broker.
        */}
        <div className="strategy-grid-strategy">
          <Card>
            <VStack gap={2} padding={3}>
              <Heading level={3}>Strategy</Heading>
              <StrategyReasonPanel decisions={decisions} />
            </VStack>
          </Card>
        </div>

        {/* Last in the DOM: the only panel that answers no question on its own. */}
        <div className="strategy-grid-chart">
          <Card>
            <VStack gap={2} padding={3}>
              <Heading level={3}>Intraday P&L</Heading>
              {seriesError !== null ? (
                <Banner status="error" title="The P&L series could not be loaded" description={seriesError} />
              ) : (
                <IntradayPnlChart
                  points={series?.points ?? []}
                  emptyNote="No snapshots yet today. The series starts once the strategy has a position to mark."
                />
              )}
            </VStack>
          </Card>
        </div>
      </div>

      {settings !== null ? (
        <SettingsDialog
          row={settings}
          onClose={() => setSettings(null)}
          onSave={(patch) => {
            setNote(null)
            void patchWithReauth(settings, patch, reauth, refresh, setNote)
          }}
        />
      ) : null}
      {/*
        CONFIRMING A PER-STRIKE CLOSE.

        The description states the ORDER that will go out — side, size, contract
        and rail — not just the contract name. "Close TCS 2660 CE" reads the same
        whether it buys back 1,125 or sells 5,000, and catching the row that was
        clicked by mistake is the entire point of the confirmation.

        `destructive` on live. Paper cannot move money, and colouring both the
        same trains the operator past the one that can.
      */}
      {closing !== null ? (
        <AlertDialog
          isOpen
          onOpenChange={() => setClosing(null)}
          title={`Close ${formatContract(closing.tradingsymbol)} in ${mode}?`}
          description={
            `${closing.qty < 0 ? 'Buys back' : 'Sells'} ${inr(Math.abs(closing.qty))} ` +
            `of ${formatContract(closing.tradingsymbol)} at market, closing the whole ` +
            `position in that contract. The rest of the book is untouched, and the ` +
            `strategy picks the change up on its next mark — it will not re-open this ` +
            `strike unless its own rules call for it.`
          }
          actionLabel={`Close ${formatContract(closing.tradingsymbol)}`}
          actionVariant={mode === 'live' ? 'destructive' : 'primary'}
          onAction={() => {
            const leg = closing
            setClosing(null)
            void closeLeg(leg)
          }}
        />
      ) : null}
      {reauth.dialog}
    </VStack>
  )
}
