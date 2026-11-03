/**
 * Out-of-page alerts (spec 2026-10-23-traders-gaps G7), the page's two parts:
 *
 * - `PhoneAlerts`, the sidebar's control: this browser's phone alerts on or off, with the state the browser allows
 *   (not supported / blocked / off / on), the iPhone's one condition (Add to Home Screen first) and "Send test".
 * - `AlertFeed`, which reports today's stored alerts (expiring ITM, rejected orders, watchers, band breaches) to the
 *   bell, the same lines the phones were sent; each is dismissible there like any warning.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import { Button } from '@astryxdesign/core/Button'
import { HStack, VStack } from '@astryxdesign/core/Layout'
import { Text } from '@astryxdesign/core/Text'
import type { TraderAlert } from '../../../traders/src/types.ts'
import { tapi } from './api.ts'
import { useBellReport } from './bell-store.tsx'
import { usePoll, useSession } from './hooks.ts'
import {
  browserEnv, readPhoneAlerts, syncSubscription, turnOffPhoneAlerts, turnOnPhoneAlerts, type PhoneAlertState, type PushEnv,
} from './push-client.ts'
import { istDay, istHm } from './wire.ts'

const STATE_TEXT: Readonly<Record<PhoneAlertState, string>> = {
  unsupported: 'not supported in this browser', blocked: 'blocked', off: 'off', on: 'on',
}
export const IPHONE_HINT = 'On iPhone: Add to Home Screen first (Share → Add to Home Screen), then open Delta Desk from the Home Screen and turn alerts on there.'
export const BLOCKED_HINT = 'Notifications are blocked for this site: allow them in the browser\'s site settings, then reload.'

const failed = (err: unknown): string => `Phone alerts: ${err instanceof Error ? err.message : String(err)}`

export function PhoneAlerts(props: { env?: PushEnv }): React.ReactElement {
  const env = useMemo(() => props.env ?? browserEnv(), [props.env])
  const [state, setState] = useState<PhoneAlertState | null>(null)
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    readPhoneAlerts(env).then(
      ({ state: s, reg }) => {
        if (!alive) return
        setState(s)
        // on: the subscription is checked against the server's key and the server's copy refreshed (it may have
        // dropped it, have new keys, or the user signed in as someone else on this browser)
        if (s === 'on' && reg !== null) void syncSubscription(reg).catch(() => undefined)
      },
      () => { if (alive) setState('unsupported') },
    )
    return () => { alive = false }
  }, [env])

  const act = useCallback((run: () => Promise<PhoneAlertState | string>) => {
    setBusy(true)
    setNote(null)
    run().then(
      (r) => { if (r === 'unsupported' || r === 'blocked' || r === 'off' || r === 'on') setState(r); else setNote(r) },
      (err: unknown) => setNote(failed(err)),
    ).finally(() => setBusy(false))
  }, [])

  const on = (): void => act(() => turnOnPhoneAlerts(env))
  const off = (): void => act(() => turnOffPhoneAlerts(env))
  const test = (): void => act(async () => {
    const r = await tapi.pushTest()
    return r.sent > 0 ? `Test sent to ${r.sent} ${r.sent === 1 ? 'phone' : 'phones'}` : 'No phone took the test: turn alerts off and on again'
  })

  return (
    <VStack gap={1} role="group" aria-label="Phone alerts">
      <Text size="sm">{`Phone alerts: ${state === null ? 'checking…' : STATE_TEXT[state]}`}</Text>
      {state === 'off' ? <Button variant="ghost" size="sm" label="Turn on phone alerts" isDisabled={busy} onClick={on} /> : null}
      {state === 'on' ? (
        <HStack gap={1}>
          <Button variant="ghost" size="sm" label="Send test" isDisabled={busy} onClick={test} />
          <Button variant="ghost" size="sm" label="Turn off" isDisabled={busy} onClick={off} />
        </HStack>
      ) : null}
      {state === 'blocked' ? <Text size="sm" color="secondary">{BLOCKED_HINT}</Text> : null}
      {env.iPhone && !env.standalone ? <Text size="sm" color="secondary">{IPHONE_HINT}</Text> : null}
      {note === null ? null : <Text size="sm" color="secondary" role="status">{note}</Text>}
    </VStack>
  )
}

/** The bell's stored alerts are polled this often (the runner raises them once a minute). */
export const ALERTS_POLL_MS = 60_000
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000

/** Midnight IST of the day `ms` falls on: the bell lists the day's alerts. */
export function istDayStart(ms: number): number {
  return Date.parse(`${istDay(ms)}T00:00:00Z`) - IST_OFFSET_MS
}

/** One alert as the bell's line: its time, title and text. */
export const alertLine = (a: Pick<TraderAlert, 'at' | 'title' | 'body'>): string => `${istHm(a.at)} ${a.title}: ${a.body}`

/** Reports today's stored alerts to the bell; draws nothing. Re-read when the admin picks another trader. */
export function AlertFeed(): null {
  const session = useSession()
  const feed = usePoll(() => tapi.alerts(istDayStart(Date.now())), ALERTS_POLL_MS, [session?.asTrader ?? ''])
  // an older server answers 404 here, and a test's catch-all an object: either is no alerts
  const lines = Array.isArray(feed.data) ? (feed.data as readonly TraderAlert[]).map(alertLine) : []
  useBellReport(lines.length === 0 ? null : { items: lines })
  return null
}
