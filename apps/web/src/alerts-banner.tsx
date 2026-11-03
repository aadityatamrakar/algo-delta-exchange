/**
 * THE DESK-ALERTS BANNER — unacked critical and warn `desk-alerts`, above every
 * page.
 *
 * The alerts are what the exchange-backstop loop and dx-watchdog raise when the
 * desk cannot protect a position on its own: a backstop Delta refused, a short
 * no book accounts for, a desk process down while Delta holds positions, an
 * automatic flatten. Info alerts stay off the banner.
 *
 * Polled every 15 s. Ack hides one alert for everyone (the bridge stamps who
 * acked it) and fixes nothing. A failed read shows nothing rather than a
 * second error banner: Status already reports a bridge that is not answering.
 *
 * Built from astryx `Banner`, so it follows the light/dark theme tokens.
 */
import { useState } from 'react'
import { Banner } from '@astryxdesign/core/Banner'
import { Button } from '@astryxdesign/core/Button'
import { VStack } from '@astryxdesign/core/Layout'
import { api, explain, localDayTime, type DeskAlert } from './api.ts'
import { usePoll } from './shell.tsx'

export const ALERTS_POLL_MS = 15_000

export function AlertsBanner(): React.ReactElement | null {
  const poll = usePoll(() => api.alerts(), ALERTS_POLL_MS)
  const [acked, setAcked] = useState<ReadonlySet<string>>(new Set())
  const [busy, setBusy] = useState<string | null>(null)
  const [failed, setFailed] = useState<string | null>(null)
  const rows = (Array.isArray(poll.data?.alerts) ? poll.data.alerts : []).filter(
    (a: DeskAlert) => (a.severity === 'critical' || a.severity === 'warn') && !acked.has(a.id),
  )
  if (rows.length === 0) return null

  const ack = async (id: string): Promise<void> => {
    setBusy(id)
    setFailed(null)
    try {
      await api.ackAlert(id)
      setAcked((s) => new Set([...s, id]))
      poll.refresh()
    } catch (err) {
      setFailed(explain(err))
    } finally {
      setBusy(null)
    }
  }

  return (
    <VStack gap={2} className="desk-alerts">
      {rows.map((a) => (
        <Banner
          key={a.id}
          status={a.severity === 'critical' ? 'error' : 'warning'}
          title={a.message}
          description={
            `${a.source} · ${a.mode === 'live' ? 'LIVE' : 'paper'}${a.tag === undefined ? '' : ` · ${a.tag}`} · ` +
            `${localDayTime(a.at)}${failed !== null && busy === null ? ` · ack failed: ${failed}` : ''}`
          }
          endContent={
            <Button
              variant="secondary"
              label={busy === a.id ? 'Acking…' : 'Ack'}
              isDisabled={busy !== null}
              onClick={() => void ack(a.id)}
            />
          }
        />
      ))}
    </VStack>
  )
}
