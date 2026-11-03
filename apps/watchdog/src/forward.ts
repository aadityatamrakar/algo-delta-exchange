/**
 * ALERT DELIVERY — the reader side of the shared `desk-alerts` contract:
 *
 *   { at, severity: 'critical'|'warn'|'info', source, mode: 'paper'|'live',
 *     tag?, key, message, ackedAt?, forwardedAt? }
 *
 * Every pass forwards the oldest un-forwarded alerts (`forwardedAt` absent) to
 * Telegram when DX_ALERT_TELEGRAM_TOKEN and DX_ALERT_TELEGRAM_CHAT are both
 * set — a plain HTTPS POST to `sendMessage` — and stamps `forwardedAt` (with
 * `forwardedVia`). A failed send is not stamped, so it is retried next pass.
 * Without config each alert is logged once and stamped `via: 'log'`, so
 * turning Telegram on later does not replay history. Alerts older than six
 * hours are stamped `skipped-old`, never sent: a first start must not page a
 * backlog. The token is part of the URL and is never logged.
 */
type Doc = Record<string, unknown>
type Env = Readonly<Record<string, string | undefined>>

export const DESK_ALERTS_COLLECTION = 'desk-alerts'
const MAX_AGE_MS = 6 * 3600_000
const BATCH = 20
/** Telegram's message limit is 4096 characters. */
const MAX_TEXT = 3900

export interface TelegramConfig {
  readonly token: string
  readonly chat: string
}

export function telegramConfigFromEnv(env: Env): TelegramConfig | null {
  const token = env['DX_ALERT_TELEGRAM_TOKEN']?.trim() ?? ''
  const chat = env['DX_ALERT_TELEGRAM_CHAT']?.trim() ?? ''
  return token === '' || chat === '' ? null : { token, chat }
}

export interface AlertsCollection {
  find(q: Doc): { sort(s: Doc): { limit(n: number): { toArray(): Promise<Doc[]> } } }
  updateOne(f: Doc, u: Doc): Promise<unknown>
  insertOne(d: Doc): Promise<unknown>
}

function textOf(a: Doc): string {
  const sev = String(a['severity'] ?? 'info').toUpperCase()
  const head = [`[${sev}]`, String(a['mode'] ?? ''), String(a['source'] ?? ''), typeof a['tag'] === 'string' ? a['tag'] : '']
    .filter((x) => x !== '')
    .join(' · ')
  const when = typeof a['at'] === 'number' ? new Date(a['at']).toISOString().replace('.000Z', 'Z') : ''
  const t = `${head}\n${String(a['message'] ?? '')}${when === '' ? '' : `\n${when}`}`
  return t.length > MAX_TEXT ? `${t.slice(0, MAX_TEXT)}…` : t
}

const msgOf = (err: unknown): string => (err instanceof Error ? err.message : String(err))

export function createAlertForwarder(deps: {
  readonly collection: AlertsCollection
  readonly telegram: TelegramConfig | null
  readonly fetch: typeof fetch
  readonly log: (msg: string, ctx?: Record<string, unknown>) => void
  readonly now: () => number
}): { run(): Promise<number> } {
  let running = false
  const stamp = async (a: Doc, via: string): Promise<void> => {
    await deps.collection.updateOne({ _id: a['_id'] }, { $set: { forwardedAt: deps.now(), forwardedVia: via } })
  }
  const send = async (a: Doc): Promise<boolean> => {
    const t = deps.telegram
    if (t === null) return false
    try {
      const res = await deps.fetch(`https://api.telegram.org/bot${t.token}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: t.chat, text: textOf(a), disable_web_page_preview: true }),
        signal: AbortSignal.timeout(10_000),
      })
      if (!res.ok) {
        deps.log('ALERT FORWARD: Telegram refused the message — retrying next pass', { status: res.status, key: a['key'] })
        return false
      }
      return true
    } catch (err) {
      // `fetch failed` / a timeout; the URL (and its token) is not in the message.
      deps.log('ALERT FORWARD: Telegram unreachable — retrying next pass', { error: msgOf(err).replace(t.token, '<token>') })
      return false
    }
  }
  return {
    async run(): Promise<number> {
      if (running) return 0
      running = true
      let n = 0
      try {
        const docs = await deps.collection.find({ forwardedAt: { $exists: false } }).sort({ at: 1 }).limit(BATCH).toArray()
        for (const a of docs) {
          const at = typeof a['at'] === 'number' ? a['at'] : 0
          if (deps.now() - at > MAX_AGE_MS) {
            await stamp(a, 'skipped-old')
            continue
          }
          if (deps.telegram === null) {
            deps.log(`ALERT ${textOf(a).replace(/\n/g, ' | ')}`)
            await stamp(a, 'log')
            n++
            continue
          }
          if (!(await send(a))) break
          await stamp(a, 'telegram')
          n++
        }
      } catch (err) {
        deps.log('ALERT FORWARD pass failed', { error: msgOf(err) })
      } finally {
        running = false
      }
      return n
    },
  }
}

/** The watchdog's own `desk-alerts` writer: the contract shape, deduped per key for 10 min. Never throws. */
export function createWatchdogAlertSink(deps: {
  readonly collection: Pick<AlertsCollection, 'insertOne'>
  readonly now: () => number
  readonly log: (msg: string, ctx?: Record<string, unknown>) => void
  readonly dedupeMs?: number
}): (a: { severity: 'critical' | 'warn' | 'info'; mode: 'paper' | 'live'; key: string; message: string; tag?: string }) => void {
  const last = new Map<string, number>()
  const window = deps.dedupeMs ?? 10 * 60_000
  return (a) => {
    const now = deps.now()
    const prev = last.get(a.key)
    if (prev !== undefined && now - prev < window) return
    last.set(a.key, now)
    deps.log(`ALERT ${a.severity.toUpperCase()} ${a.mode}: ${a.message}`)
    const doc: Doc = { at: now, severity: a.severity, source: 'dx-watchdog', mode: a.mode, key: a.key, message: a.message, ...(a.tag === undefined ? {} : { tag: a.tag }) }
    void deps.collection.insertOne(doc).catch((err: unknown) => deps.log('desk-alerts insert failed', { error: msgOf(err) }))
  }
}
