/**
 * THE OPTION CHAIN PAGE (operator, 3 Nov): expiry tabs grouped into dailies,
 * weeklies and monthlies; the index price; per strike CE | strike | PE with
 * bid, ask, mark, IV, delta and OI, the ATM row highlighted; gamma, theta,
 * vega and the touch sizes on hover.
 *
 * READ-ONLY. It reads `GET /v1/desk/chain/:symbol?expiry=` and
 * `GET /v1/desk/chain/:symbol/expiries`, polled — nothing here places or
 * prepares an order.
 *
 * EVERY FIELD PAST bid/ask IS OPTIONAL on the wire (only the DX feed sends
 * mark, sizes, IV, OI and greeks). Absent renders as a dash, never as 0: a
 * strike with no OI reported and a strike with zero OI are different facts.
 */
import { useEffect, useState } from 'react'
import { VStack, HStack } from '@astryxdesign/core/Layout'
import { Text, Heading } from '@astryxdesign/core/Text'
import { Banner } from '@astryxdesign/core/Banner'
import { TabList, Tab } from '@astryxdesign/core/TabList'
import { api, type ChainRowWire, type ChainSide } from './api.ts'
import { asOf, usePoll } from './shell.tsx'
import { VENUE } from './venue.ts'

/** How often the chain is re-read. The api's quote cache is fed by the tick stream. */
const CHAIN_POLL_MS = 2000
const EXPIRIES_POLL_MS = 60_000

export type ExpiryClass = 'daily' | 'weekly' | 'monthly'

/**
 * Delta's listing pattern: a monthly is the LAST Friday of its month, a weekly
 * any other Friday, a daily every other day. Decided from the date alone, so
 * an expiry the instrument list adds tomorrow files itself.
 */
export function expiryClass(expiry: string): ExpiryClass {
  const at = Date.parse(`${expiry}T12:00:00Z`)
  if (!Number.isFinite(at)) return 'daily'
  const d = new Date(at)
  if (d.getUTCDay() !== 5) return 'daily'
  const nextWeek = new Date(at + 7 * 86_400_000)
  return nextWeek.getUTCMonth() !== d.getUTCMonth() ? 'monthly' : 'weekly'
}

/** The listed strike nearest the index price; null without a price or strikes. */
export function atmStrike(strikes: readonly number[], spot: number | null): number | null {
  if (spot === null || !Number.isFinite(spot) || strikes.length === 0) return null
  let best = strikes[0] as number
  for (const k of strikes) if (Math.abs(k - spot) < Math.abs(best - spot)) best = k
  return best
}

const MONTH = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** `2026-11-04` → `04 Nov`. */
function expiryLabel(expiry: string): string {
  const [, m, d] = expiry.split('-')
  return `${d ?? ''} ${MONTH[Number(m) - 1] ?? m ?? ''}`
}

const LOCALE = VENUE.currency === 'USD' ? 'en-US' : 'en-IN'

function num(v: number | null | undefined, maxDigits: number): string {
  return typeof v === 'number' && Number.isFinite(v)
    ? v.toLocaleString(LOCALE, { maximumFractionDigits: maxDigits })
    : '—'
}

function pct(v: number | null | undefined): string {
  return typeof v === 'number' && Number.isFinite(v) ? `${(v * 100).toFixed(1)}%` : '—'
}

/** The hover text for one side: the fields the row has no room for. */
function sideTitle(type: 'CE' | 'PE', s: ChainSide | null | undefined): string {
  if (s === null || s === undefined) return `${type}: no quote`
  return [
    `${type}`,
    `gamma ${num(s.gamma, 6)}`,
    `theta ${num(s.theta, 2)}`,
    `vega ${num(s.vega, 2)}`,
    `bid size ${num(s.bidSize, 0)}`,
    `ask size ${num(s.askSize, 0)}`,
  ].join(' · ')
}

/** CE columns read outward from the strike, PE columns mirror them. */
const SIDE_COLS: readonly { key: string; label: string; cell: (s: ChainSide) => string }[] = [
  { key: 'oi', label: 'OI', cell: (s) => num(s.oi, 0) },
  { key: 'delta', label: 'Delta', cell: (s) => num(s.delta, 2) },
  { key: 'iv', label: 'IV', cell: (s) => pct(s.iv) },
  { key: 'mark', label: 'Mark', cell: (s) => num(s.mark, 2) },
  { key: 'bid', label: 'Bid', cell: (s) => num(s.bid, 2) },
  { key: 'ask', label: 'Ask', cell: (s) => num(s.ask, 2) },
]

const CELL: React.CSSProperties = { padding: '4px 8px', textAlign: 'end', whiteSpace: 'nowrap' }
const STRIKE: React.CSSProperties = { ...CELL, textAlign: 'center', fontWeight: 600 }

function SideCells(props: { type: 'CE' | 'PE'; side: ChainSide | null | undefined }): React.ReactElement {
  const cols = props.type === 'CE' ? SIDE_COLS : [...SIDE_COLS].reverse()
  const title = sideTitle(props.type, props.side)
  return (
    <>
      {cols.map((c) => (
        <td key={`${props.type}-${c.key}`} style={CELL} title={title}>
          {props.side === null || props.side === undefined ? '—' : c.cell(props.side)}
        </td>
      ))}
    </>
  )
}

function ChainTable(props: { rows: readonly ChainRowWire[]; atm: number | null }): React.ReactElement {
  const head = [
    ...SIDE_COLS.map((c) => `CE ${c.label}`),
    'Strike',
    ...[...SIDE_COLS].reverse().map((c) => `PE ${c.label}`),
  ]
  return (
    <div style={{ overflowX: 'auto' }}>
      <table style={{ borderCollapse: 'collapse', width: '100%', fontVariantNumeric: 'tabular-nums' }}>
        <thead>
          <tr>
            {head.map((h) => (
              <th key={h} style={{ ...CELL, borderBottom: '1px solid var(--color-border-gray)' }}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {props.rows.map((r) => {
            const atm = r.strike === props.atm
            return (
              <tr
                key={r.strike}
                data-atm={atm ? 'true' : 'false'}
                style={atm
                  ? { background: 'var(--color-background-blue)', outline: '1px solid var(--color-border-gray)' }
                  : undefined}
              >
                <SideCells type="CE" side={r.CE} />
                <td style={STRIKE}>{num(r.strike, 2)}</td>
                <SideCells type="PE" side={r.PE} />
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

const CLASSES: readonly { cls: ExpiryClass; label: string }[] = [
  { cls: 'daily', label: 'Daily' },
  { cls: 'weekly', label: 'Weekly' },
  { cls: 'monthly', label: 'Monthly' },
]

export function ChainPage(props: { underlying?: string }): React.ReactElement {
  const underlying = props.underlying ?? 'BTC'
  const expiries = usePoll(() => api.chainExpiries(underlying), EXPIRIES_POLL_MS, [underlying])
  const [picked, setPicked] = useState<string | null>(null)

  const list = expiries.data ?? []
  // The first listed expiry until the operator picks one, and again if the
  // picked one is delisted (it settled) — never a chain for an expiry that is gone.
  const expiry = picked !== null && list.includes(picked) ? picked : (list[0] ?? null)
  useEffect(() => {
    if (picked !== null && expiries.data !== null && !expiries.data.includes(picked)) setPicked(null)
  }, [picked, expiries.data])

  const chain = usePoll(
    () => (expiry === null ? Promise.resolve(null) : api.chain(underlying, expiry)),
    CHAIN_POLL_MS,
    [underlying, expiry],
  )
  const data = chain.data
  const rows = data?.rows ?? []
  const atm = atmStrike(rows.map((r) => r.strike), data?.spot ?? null)

  return (
    <VStack gap={3}>
      <HStack gap={3} align="center" wrap="wrap" justify="between">
        <Heading level={2}>{`Option chain · ${underlying}`}</Heading>
        <Text weight="medium">
          {`Index price ${num(data?.spot ?? null, 2)}`}
          {chain.updatedAt === null ? '' : ` · ${asOf(chain.updatedAt) ?? ''}`}
        </Text>
      </HStack>

      {expiries.error !== null ? (
        <Banner status="error" title="The expiry list could not be loaded" description={expiries.error} />
      ) : null}
      {expiries.data !== null && list.length === 0 ? (
        <Text color="secondary">{`No expiries are listed for ${underlying}.`}</Text>
      ) : null}

      {CLASSES.map(({ cls, label }) => {
        const group = list.filter((e) => expiryClass(e) === cls)
        if (group.length === 0) return null
        return (
          <HStack key={cls} gap={2} align="center" wrap="wrap">
            <Text size="sm" color="secondary" style={{ minWidth: 70 }}>{label}</Text>
            <TabList
              value={expiry !== null && group.includes(expiry) ? expiry : ''}
              onChange={(v) => setPicked(v)}
              layout="hug"
              aria-label={`${label} expiries`}
            >
              {group.map((e) => <Tab key={e} value={e} label={expiryLabel(e)} />)}
            </TabList>
          </HStack>
        )
      })}

      {chain.error !== null ? (
        <Banner
          status="error"
          title="The chain could not be loaded"
          description={`${chain.error}. The figures below are the last that arrived.`}
        />
      ) : null}
      {data?.feedAlive === false ? (
        <Banner
          status="warning"
          title="The price feed is down"
          description="These are the last quotes received, not the market."
        />
      ) : null}

      {expiry !== null && data !== null && rows.length === 0 ? (
        <Text color="secondary">{`No strikes listed for ${underlying} ${expiry}.`}</Text>
      ) : null}
      {rows.length > 0 ? <ChainTable rows={rows} atm={atm} /> : null}
    </VStack>
  )
}
