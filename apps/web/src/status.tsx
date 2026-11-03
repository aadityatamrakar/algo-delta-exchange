/**
 * Status — is the desk working?
 *
 * ONE PAGE, BECAUSE IT IS ONE QUESTION. Feed health and broker credentials had a
 * tab each, and between them they answered about a third of it: neither said
 * whether desk-runner was running, whether either Python supervisor had
 * converged in the last two minutes, or whether the gateway had spoken to the
 * broker since breakfast. An operator asking "is everything up?" had to visit
 * two screens and then know, unaided, which processes neither screen covered.
 *
 * So the two are stacked under a third section that reports EVERY process, and
 * the systems grid goes first — it is the part that answers the question. The
 * Feed and Brokers sections below are unchanged in what they measure; they were
 * moved, not rewritten.
 *
 * FIVE SECTIONS NOW, and the two later ones answer the question from the other
 * side. `Order failures` is what the desk TRIED and was refused — the only
 * thing on this dashboard that can be silently wrong, and after the Orders page
 * was removed the only screen that reaches it. `Recent operator actions` is
 * what was DONE to the desk. See each section's own note.
 *
 * WHAT THIS PAGE DOES NOT DO IS ARITHMETIC. Every state on the grid is the
 * server's own verdict (`apps/api/src/routes/system.ts`), which derives it from
 * an age it measured against a cadence it knows. Re-deriving "stale" here from
 * `ageMs` and the browser's clock would put a second opinion on screen that
 * disagrees with the first on any laptop whose clock has drifted — and a status
 * page that contradicts itself is worse than no status page.
 *
 * `stale` IS NEUTRAL WORDING, DELIBERATELY. Several of these components are
 * legitimately quiet outside a session: a supervisor with no session to
 * converge and a gateway with no orders look exactly like ones that have died,
 * and neither this page nor the server can tell the difference. So amber says
 * "older than expected" and prints both the age and the cadence, rather than
 * claiming a fault. Two days a week of false alarm is how a colour stops being
 * read on the third.
 */

import { VStack, HStack } from '@astryxdesign/core/Layout'
import { Text, Heading } from '@astryxdesign/core/Text'
import { Card } from '@astryxdesign/core/Card'
import { Grid } from '@astryxdesign/core/Grid'
import { Badge } from '@astryxdesign/core/Badge'
import { Banner } from '@astryxdesign/core/Banner'
import { Table, pixel, proportional } from '@astryxdesign/core/Table'
import type { TableColumn } from '@astryxdesign/core/Table'
import {
  ago,
  api,
  istDate,
  localDayTime,
  localTime,
  orderDetail,
  spansDays,
  NOWRAP,
  RED,
  type AuditEntry,
  type OrderEvent,
  type SystemComponent,
  type SystemReport,
} from './api.ts'
import { usePoll } from './shell.tsx'
import { FeedSection } from './pages.tsx'
import { BrokersSection } from './brokers.tsx'
import { ModeBadge, useMode } from './mode.tsx'
import { MarginStatusCard } from './margin.tsx'
import { DemoFeedLine, demoFeedOf } from './marks-source.tsx'

/**
 * Fast enough to watch a process come back after a restart, slow enough that a
 * left-open tab is not a load. The report is six small reads server-side, and
 * they are sequential there for exactly this reason.
 */
const POLL_MS = 5_000

/**
 * The four states, in the palette this dashboard already uses for them.
 *
 * `unknown` IS GREY, NOT AMBER. It is the colour `Brokers` gives "not
 * configured" and `Books` gives a stopped book: a condition, not a warning. A
 * gateway in simulate mode and a rail with nothing registered on it are both
 * healthy desks, and painting them amber would teach the operator that amber
 * means nothing.
 *
 * `attention` IS AMBER AND SAYS "attention", NOT "stale". Both are warnings and
 * both wear the same colour, but the WORD is the whole content of the badge and
 * the two words are different claims: `stale` says the component stopped
 * writing, `attention` says it wrote on time and what it wrote needs looking at.
 * Labelling a current report "stale" would send the operator to restart a
 * process that is working perfectly while the seventeen mismatched contracts it
 * was trying to report went on sitting there.
 */
const PAINT: Record<SystemComponent['state'], { variant: 'success' | 'warning' | 'neutral'; label: string }> = {
  ok: { variant: 'success', label: 'ok' },
  stale: { variant: 'warning', label: 'stale' },
  attention: { variant: 'warning', label: 'attention' },
  unknown: { variant: 'neutral', label: 'unknown' },
}

/** "expected every 10s" / "every 1s" — the cadence the age should be read against. */
function cadence(ms: number | null): string | null {
  if (ms === null) return null
  return ms < 1000 ? `expected every ${ms}ms` : `expected every ${Math.round(ms / 1000)}s`
}

function ComponentCard(props: { component: SystemComponent }): React.ReactElement {
  const c = props.component
  const paint = PAINT[c.state]
  const every = cadence(c.expectedEveryMs)
  /**
   * "never" rather than "0s ago" when nothing has been seen. `ago(null)` already
   * says it, and the distinction is the whole point of the `unknown` state:
   * a component with no artifact has not been seen recently, it has not been
   * seen at all.
   */
  const seen = c.lastSeenMs === null ? 'never seen' : `last seen ${ago(c.ageMs)}`
  const demo = demoFeedOf(c.extra)
  return (
    <Card padding={3}>
      <VStack gap={1}>
        <HStack justify="between" align="center" wrap="wrap" gap={2}>
          <Text weight="bold">{c.name}</Text>
          <Badge variant={paint.variant} label={paint.label} />
        </HStack>
        {/* The pm2 process name, so what is on screen and what an operator
            would type into `pm2 restart` are the same string. */}
        <Text size="sm" color="secondary">{c.id}</Text>
        <Text size="sm">{c.detail}</Text>
        {/* The Delta TESTNET price socket, carried on the market-data card's
            `extra.demo` — what demo-rail paper books are marked off. Absent
            on a bridge a deploy behind, and then nothing is said. */}
        {demo === null ? null : <DemoFeedLine demo={demo} />}
        <Text size="sm" color="secondary">
          {every === null ? seen : `${seen} · ${every}`}
        </Text>
      </VStack>
    </Card>
  )
}

function SystemsSection(): React.ReactElement {
  const { data, error } = usePoll<SystemReport>(() => api.system(), POLL_MS)
  const components = data?.components ?? []
  /**
   * The count of what is NOT ok, said once at the top.
   *
   * Counted from the server's states, never re-derived. `unknown` is excluded:
   * it is not a fault, and a headline that folded it in would read "3 not ok"
   * on a perfectly healthy simulate-mode desk.
   */
  const stale = components.filter((c) => c.state === 'stale')
  /**
   * Counted and headlined SEPARATELY from `stale`, because it is a separate
   * claim. Folding the two together would put "have not written recently" above
   * a report that was written thirty seconds ago, which is the same wrong word
   * the badge refuses.
   */
  const attention = components.filter((c) => c.state === 'attention')
  /**
   * THE TESTNET PRICE SOCKET BEING DOWN is said once, above the grid, as well
   * as on its card. It does not move the card's state (the process is still
   * speaking) but it does change what demo-rail books are worth: their legs
   * fall back to production prices, and each such book says so on its page.
   */
  const demoDown = components.some((c) => demoFeedOf(c.extra)?.connected === false)

  return (
    <VStack gap={3}>
      <Heading level={3}>Systems</Heading>

      {error !== null ? (
        <Banner
          status="error"
          title="Cannot reach the bridge"
          description={`${error}. Nothing below is current — and the bridge being unreachable is itself a fault, whatever the cards last said.`}
        />
      ) : null}

      {attention.length > 0 ? (
        <Banner
          status="warning"
          title={`${attention.length} of ${components.length} components need attention`}
          description={
            `${attention.map((c) => c.id).join(', ')} — these are CURRENT and reporting something. ` +
            'The card below carries what each one says; nothing here has been changed by the desk.'
          }
        />
      ) : null}

      {demoDown ? (
        <Banner
          status="warning"
          title="Delta testnet price socket is down"
          description={
            'Paper books on the demo rail cannot be marked at testnet prices. Legs with no demo quote ' +
            'fall back to Delta production prices, and each such book is flagged incomplete.'
          }
        />
      ) : null}

      {stale.length > 0 ? (
        <Banner
          status="warning"
          title={`${stale.length} of ${components.length} components have not written recently`}
          description={
            `${stale.map((c) => c.id).join(', ')} — each card below states the age measured and the cadence expected. ` +
            'Some of these are quiet for honest reasons; the age is reported, not judged.'
          }
        />
      ) : null}

      {data === null && error === null ? (
        // Nothing invented while the first reply is in flight: an empty grid is
        // not "no components", it is "we have not been told yet".
        <Text color="secondary" size="sm">Asking the bridge…</Text>
      ) : null}

      {/* Three across on a desk, one on a phone. 260px is the width at which a
          detail line like "2 of 2 sockets connected · 900 tokens" still reads. */}
      <Grid columns={{ minWidth: 260, max: 3 }} gap={3}>
        {components.map((c) => <ComponentCard key={c.id} component={c} />)}
        {/* The Delta accounts' margin, on its own read: not a process, but the
            same question — is anything here about to stop the desk trading? */}
        <MarginStatusCard />
      </Grid>

      <Text color="secondary" size="sm">
        Liveness is measured from what each process WRITES, never from the process table.
        A crash-looping or wedged process still reads "online" under pm2; one that has
        stopped writing its artifact is not doing its job whatever pm2 says.
      </Text>
    </VStack>
  )
}

/**
 * Slower than the systems grid on purpose. This list changes when a HUMAN does
 * something, which is a handful of times a session — polling it at the grid's
 * cadence would be three hundred reads an hour of a collection that answered
 * the same thing three hundred times.
 */
const AUDIT_POLL_MS = 20_000

/**
 * How many entries the page asks for.
 *
 * A GLANCE, not the archive. This section answers "what has been done to the
 * desk recently?" — the sort of question asked after finding a strategy off or
 * a book missing. Answering it with two hundred rows would bury the last three
 * actions, which are the ones that explain what is on screen. The server caps
 * it again regardless.
 */
const AUDIT_LIMIT = 12

/** The row type the table takes — see `orderlog.tsx` for the same shape. */
type AuditRow = AuditEntry & Record<string, unknown>

/**
 * WHO IS NOT ALWAYS A PERSON. The day guard writes its automatic stops into the
 * same log under `principalKind: 'system'`, and it must be readable as the desk
 * acting rather than as an operator's own decision — that distinction is most
 * of the value of having the two in one list. A machine principal (the Python
 * desk's shared bearer) is marked for the same reason.
 */
function whoBadge(entry: AuditEntry): React.ReactElement {
  const kind = entry.principalKind
  if (kind === 'system') return <Badge variant="neutral" label="desk" />
  if (kind === 'machine') return <Badge variant="warning" label="machine" />
  return <></>
}

function auditColumns(dated: boolean): TableColumn<AuditRow>[] {
  return [
    {
      key: 'at',
      header: 'Time',
      width: pixel(dated ? 150 : 100),
      renderCell: (e) => (
        <Text size="sm" color="secondary" style={NOWRAP}>
          {dated ? localDayTime(e.at) : localTime(e.at)}
        </Text>
      ),
    },
    {
      key: 'principal',
      header: 'Who',
      width: pixel(150),
      renderCell: (e) => (
        <HStack gap={2} align="center" wrap="wrap">
          <Text size="sm" style={NOWRAP}>{e.principal}</Text>
          {whoBadge(e)}
        </HStack>
      ),
    },
    {
      key: 'action',
      header: 'Action',
      width: proportional(1),
      renderCell: (e) => <Text size="sm">{e.action}</Text>,
    },
    {
      key: 'tag',
      header: 'Book',
      width: pixel(230),
      // A dash, not a blank: several of these acts are desk-wide (the kill
      // switch, a bulk switch), and an empty cell reads as a missing value
      // rather than as "this one was not about a book".
      renderCell: (e) => (
        <Text size="sm" color="secondary" style={NOWRAP}>
          {e.tag === undefined || e.tag === '' ? '—' : e.tag}
          {e.mode === undefined ? '' : ` · ${e.mode}`}
        </Text>
      ),
    },
  ]
}

/**
 * RECENT OPERATOR ACTIONS — who did what to this desk (audit roadmap 17).
 *
 * It lives on Status rather than on its own page because it answers the same
 * question the rest of this screen does, from the other side: the grid says
 * what the desk IS doing, and this says what was DONE to it. A strategy that is
 * off, a book that is gone, dials that are not what you remember — the systems
 * grid cannot explain any of them, and until this existed neither could
 * anything else the operator could reach.
 *
 * IT IS DELIBERATELY NOT THE WHOLE ENTRY. The server's `detail` is a small
 * before/after summary whose shape differs per action; rendering it generically
 * would produce a column of JSON. The four fields every entry carries are what
 * is on screen, and the full record is in `desk-audit-log` for the question
 * that needs it.
 */
function RecentActionsSection(): React.ReactElement {
  const { data, error } = usePoll<{ entries: AuditEntry[] }>(
    () => api.audit(AUDIT_LIMIT),
    AUDIT_POLL_MS,
  )
  const entries = data?.entries ?? []
  // The same rule the order log follows: the day goes in front of the time
  // exactly when there is more than one day on screen. This list spans days
  // routinely — it is not an intraday log — so a bare clock would render last
  // Tuesday's book deletion as if it happened this morning.
  const dated = spansDays(entries.map((e) => e.at))

  return (
    <VStack gap={3}>
      <Heading level={3}>Recent operator actions</Heading>

      {error !== null ? (
        <Banner
          status="error"
          title="Cannot read the audit log"
          description={`${error}. This says nothing about whether actions were taken — only that the record of them could not be read.`}
        />
      ) : null}

      {data === null && error === null ? (
        <Text color="secondary" size="sm">Asking the bridge…</Text>
      ) : null}

      {data !== null && entries.length === 0 ? (
        /**
         * "Nothing recorded" is NOT "nothing happened", and the difference
         * matters on the day this ships: the log starts empty and only carries
         * what has been done since. Saying so is the honest empty state.
         */
        <Text color="secondary" size="sm">
          No operator actions recorded yet. This log begins when the bridge that writes it
          starts — it is not a record of anything done before that.
        </Text>
      ) : null}

      {entries.length > 0 ? (
        <Table data={entries as AuditRow[]} columns={auditColumns(dated)} density="compact" hasHover />
      ) : null}

      <Text color="secondary" size="sm">
        Every mutation this bridge makes is recorded with the AUTHENTICATED principal — never a
        name a request claimed for itself. Automatic stops appear as “desk”.
      </Text>
    </VStack>
  )
}

// -------------------------------------------------------- order failures

/**
 * Faster than the audit log, slower than the systems grid.
 *
 * A refusal is not a human action — it arrives at the speed the desk trades —
 * so the audit log's twenty seconds is too long to find out that a book has
 * stopped being able to place orders. The grid's five is faster than this
 * journal can change, over a query that reads two collections.
 */
const FAILURES_POLL_MS = 15_000

/** The row type the table takes — the same shape `orderlog.tsx` renders. */
type FailureRow = OrderEvent & Record<string, unknown>

/**
 * The reason, capped — with the whole sentence on hover.
 *
 * A broker's refusal runs to a paragraph on a bad day ("RMS:21038 blocked for
 * NIFTY26AUG25000CE, contract expiry…"), and one such row would push every
 * other failure off a section that exists to be read at a glance. The full text
 * is the cell's `title`, and the journal has it verbatim.
 */
const REASON_CAP = 130

function short(text: string): string {
  return text.length <= REASON_CAP ? text : `${text.slice(0, REASON_CAP - 1)}…`
}

/**
 * BUILT ONCE. Nothing here varies per render, and the design system's table
 * re-renders every row when the columns array stops being the one it was given
 * last — which on a polling page is every cadence, forever.
 */
const FAILURE_COLUMNS: TableColumn<FailureRow>[] = [
  {
    key: 'ts',
    header: 'Time',
    width: pixel(100),
    // No day: this list is bounded to today, so there is nothing to
    // disambiguate and a date would cost 50px of the reason column.
    renderCell: (e) => (
      <Text size="sm" color="secondary" style={NOWRAP}>{localTime(e.ts)}</Text>
    ),
  },
  {
    key: 'tag',
    header: 'Book',
    width: pixel(230),
    // A refusal the gateway raised before it knew the book is still a refusal.
    renderCell: (e) => (
      <Text size="sm" style={NOWRAP}>{e.tag === '' ? '—' : e.tag}</Text>
    ),
  },
  {
    key: 'tradingsymbol',
    header: 'Contract',
    width: pixel(190),
    /*
      THE BROKER'S OWN SPELLING, unshortened — the same rule the flat journal
      follows. This is the row that gets pasted into a support ticket or matched
      against the gateway's log, and a prettified `BHEL 410 PE` matches neither.
    */
    renderCell: (e) => (
      <Text size="sm" style={NOWRAP}>
        {e.tradingsymbol === '' ? '—' : e.tradingsymbol}
      </Text>
    ),
  },
  {
    key: 'why',
    header: 'Why',
    width: proportional(1),
    renderCell: (e) => {
      const full = orderDetail(e)
      return (
        <span title={full}>
          <Text size="sm" style={RED}>{short(full)}</Text>
        </span>
      )
    },
  },
]

/**
 * ORDER FAILURES — the one thing on this desk that can be silently wrong.
 *
 * THIS SECTION EXISTS BECAUSE THE ORDERS PAGE DOES NOT. That page was removed
 * on 2026-08-16 as a third copy of the submission journal, which it was — but
 * the half of it that was NOT duplicated anywhere went with it. Nothing else
 * reaches a refusal: the audit log records what an operator did to the bridge
 * and excludes the order path by design, the Broker page shows what REACHED the
 * broker (a freeze-limit or kill-switch refusal never does), and the
 * per-strategy log is tag-scoped, so it answers only for a book somebody had
 * already thought to open. A live gateway refusal on any other book was on no
 * screen at all.
 *
 * IT IS MODE-SCOPED, and that is not cosmetic — it is the defect the deleted
 * page was fixed for on 2026-07-28. `desk-order-events` carries refusals from
 * BOTH rails; read unscoped, a paper rejection appears to an operator watching
 * live. The switch in the navbar decides, like every other page.
 *
 * TODAY ONLY, filtered HERE. The journal endpoint is bounded by count, not by
 * date, so an unfiltered section would still be shouting Friday's freeze-limit
 * on Monday morning — and a warning that is always on stops being read. The IST
 * calendar day is the one this desk files everything under; the browser's own
 * midnight is not the desk's.
 */
function OrderFailuresSection(): React.ReactElement {
  const mode = useMode()
  const { data, error } = usePoll<{ events: OrderEvent[] }>(
    () => api.orders(mode, true),
    FAILURES_POLL_MS,
    [mode],
  )
  const today = istDate()
  const rows = (data?.events ?? []).filter((e) => istDate(e.ts) === today) as FailureRow[]

  return (
    <VStack gap={3}>
      <HStack gap={2} align="center" wrap="wrap">
        <Heading level={3}>Order failures</Heading>
        {/* The rail this list is about, in the colour the switch is already
            wearing — the section is the only mode-scoped thing on this page. */}
        <ModeBadge />
      </HStack>

      {error !== null ? (
        <Banner
          status="error"
          title="Could not read the order journal"
          description={`${error}. This says NOTHING about whether orders are failing — only that the record of them could not be read.`}
        />
      ) : null}

      {data === null && error === null ? (
        <Text color="secondary" size="sm">Asking the bridge…</Text>
      ) : null}

      {data !== null && rows.length > 0 ? (
        <Table data={rows} columns={FAILURE_COLUMNS} density="compact" hasHover />
      ) : null}

      {data !== null && rows.length === 0 ? (
        /**
         * "Nothing refused today" is the honest claim, and it is narrower than
         * "everything is fine": a strategy that never tried to trade fails
         * nothing. The count is what this section knows; it does not know
         * whether an order should have been placed.
         */
        <Text color="secondary" size="sm">
          No order failures today on this rail. That is not the same as “every order worked” —
          a book that placed nothing refuses nothing.
        </Text>
      ) : null}

      <Text color="secondary" size="sm">
        Every refused submission — an order cap, the kill switch, margin, an exchange reject from
        Delta. The desk's own refusals never reach Delta, so they are on no other screen; the full
        lifecycle of any one of these is in its own book's order log.
      </Text>
    </VStack>
  )
}

export function StatusPage(): React.ReactElement {
  return (
    <VStack gap={4}>
      <Heading level={2}>Status</Heading>
      <SystemsSection />
      {/* Directly under the grid, and above the audit log: a book that cannot
          place an order is the same class of fact as a process that has
          stopped, and it is the one this page used not to carry at all. */}
      <OrderFailuresSection />
      <RecentActionsSection />
      <FeedSection />
      <BrokersSection />
    </VStack>
  )
}
