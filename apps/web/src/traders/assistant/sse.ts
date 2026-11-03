/**
 * The assistant's stream, read off a fetch body: `text/event-stream`, one JSON object per `data:` line under an
 * `event:` name (spec 2026-10-23 §7). EventSource cannot POST, so this is the small part of it the page needs.
 *
 * Chunks arrive cut anywhere — mid-line, mid-UTF-8 character, several events in one — so the parser keeps the
 * unfinished tail and only dispatches on the blank line that ends an event. Unknown event names, comments (`:`) and
 * data that is not a JSON object are dropped, never thrown: a newer server's extra event must not break the page.
 */

import type { AssistantEvent } from '../../../../traders/src/agent/wire.ts'

const NAMES: ReadonlySet<string> = new Set<AssistantEvent['event']>(
  ['meta', 'text', 'status', 'tool', 'card', 'warning', 'usage', 'done', 'error', 'ping'],
)

export interface SseParser {
  /** Some more of the stream, as text. */
  push(chunk: string): void
  /** The stream ended: an event still open is dispatched (a server that left off the last blank line). */
  end(): void
}

export function sseParser(onEvent: (e: AssistantEvent) => void): SseParser {
  let buf = ''
  let name = ''
  let data: string[] = []

  const dispatch = (): void => {
    const event = name === '' ? 'message' : name
    const raw = data.join('\n')
    const had = data.length > 0
    name = ''
    data = []
    if (!NAMES.has(event)) return
    if (!had) {
      if (event === 'ping') onEvent({ event: 'ping', data: {} })
      return
    }
    let parsed: unknown
    try { parsed = JSON.parse(raw) } catch { return }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return
    onEvent({ event, data: parsed } as AssistantEvent)
  }

  const line = (l: string): void => {
    if (l === '') { dispatch(); return }
    if (l.startsWith(':')) return
    const i = l.indexOf(':')
    const field = i === -1 ? l : l.slice(0, i)
    let value = i === -1 ? '' : l.slice(i + 1)
    if (value.startsWith(' ')) value = value.slice(1)
    if (field === 'event') name = value
    else if (field === 'data') data.push(value)
  }

  return {
    push(chunk) {
      buf += chunk
      for (;;) {
        const m = /\r\n|\n|\r/.exec(buf)
        if (m === null) return
        // A lone \r at the very end may be the first half of a \r\n split across chunks: wait for the next one.
        if (m[0] === '\r' && m.index === buf.length - 1) return
        line(buf.slice(0, m.index))
        buf = buf.slice(m.index + m[0].length)
      }
    },
    end() {
      if (buf !== '') { line(buf.replace(/\r$/, '')); buf = '' }
      if (name !== '' || data.length > 0) dispatch()
    },
  }
}

/** Reads `body` to its end (or until the fetch is aborted, which rejects), handing each event to `onEvent`. */
export async function readEventStream(body: ReadableStream<Uint8Array>, onEvent: (e: AssistantEvent) => void): Promise<void> {
  const reader = body.getReader()
  const text = new TextDecoder()
  const parser = sseParser(onEvent)
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      parser.push(text.decode(value, { stream: true }))
    }
    parser.push(text.decode())
    parser.end()
  } finally {
    try { reader.releaseLock() } catch { /* already released by an abort */ }
  }
}
