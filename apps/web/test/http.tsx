/**
 * A fetch double, and the record of what the client actually sent.
 *
 * NOT a mock of `./api.ts`. The interesting properties of this client are IN
 * that module — that it sends no bearer, that it asks for the mode it is
 * showing, that a tag filter is applied where the journal can answer it — and a
 * test that stubs `api` asserts nothing about any of them. Standing in for the
 * network instead keeps the whole client under test.
 *
 * Not a `.test.tsx` file, so the runner does not collect it as a suite.
 */
import { vi } from 'vitest'

export interface SentRequest {
  readonly url: string
  readonly path: string
  readonly method: string
  readonly headers: Record<string, string>
  readonly body: Record<string, unknown> | null
}

export interface Reply {
  status?: number
  body?: unknown
}

/**
 * Install a fetch that answers from `handler`. Returns the live list of
 * requests, in order — assertions read it after the render settles.
 */
export function installFetch(
  handler: (req: { path: string; url: URL; method: string; body: Record<string, unknown> | null }) => Reply,
): SentRequest[] {
  const sent: SentRequest[] = []
  vi.stubGlobal('fetch', vi.fn(async (input: string, init?: RequestInit) => {
    const url = new URL(String(input))
    const method = init?.method ?? 'GET'
    const raw = typeof init?.body === 'string' ? init.body : null
    const body = raw === null ? null : (JSON.parse(raw) as Record<string, unknown>)
    const headers = { ...((init?.headers ?? {}) as Record<string, string>) }
    sent.push({ url: url.toString(), path: url.pathname, method, headers, body })
    const reply = handler({ path: url.pathname, url, method, body })
    const status = reply.status ?? 200
    return {
      ok: status >= 200 && status < 300,
      status,
      statusText: String(status),
      json: async () => reply.body ?? {},
    } as unknown as Response
  }))
  return sent
}

/** The paths a request was made to, deduplicated in order. Reads well in a diff. */
export function pathsOf(sent: readonly SentRequest[]): string[] {
  return [...new Set(sent.map((r) => r.path))]
}
