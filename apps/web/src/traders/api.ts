/**
 * The traders page's only door to the network: the traders API, nothing else.
 *
 * A separate client from the desk's (`../api.ts`) on purpose. The two pages
 * share a chart and the number formatters, never a session, a base URL or an
 * error type — a traders login must not be able to reach a desk route, and the
 * import test (`test/traders-imports.test.ts`) holds this file to that.
 *
 * Nothing here places, changes or cancels an order. The whole surface is the
 * endpoint table in `apps/traders/src/routes/endpoints.ts`.
 */

import type {
  AnalysisView, ChargeRates, GapInput, MarginView, ScenarioRequest, ScenarioView, VolBasis,
} from '../../../traders/src/analytics/wire.ts'
import type {
  AdminPortfolioView, AdviceCard, BandStatus, ContractsView, GroupsView, LegGroup, MarketWatchView, PortfolioView, RepairView,
} from '../../../traders/src/analytics/r3-wire.ts'
import type {
  AdminTraderRow, BookSummary, BookView, LogLine, ManualLegInput, Role, StoredFile,
  TraderAlert, TraderLeg, TraderOrder, TraderTrade, WatcherStatus,
} from '../../../traders/src/types.ts'
import type {
  AssistantCard, AssistantErrorCode, AssistantStatus, ChatRequest, ConversationSummary, ConversationView, FeedbackRequest, PlanSearchRequest,
} from '../../../traders/src/agent/wire.ts'
import type { MarketContext, VolView } from '../../../traders/src/analytics/context-wire.ts'
import type { EventRiskView, RiskView } from '../../../traders/src/analytics/risk-wire.ts'
import type { DailyView, DataStatusView } from '../../../traders/src/analytics/daily-wire.ts'
import type { AdminBookedView, BookedView } from '../../../traders/src/analytics/booked-wire.ts'

const PREFIX = '/v1/traders'

/**
 * Where the traders server is. In dev the page is :5185 and the API :8894, a
 * cross-origin call (the cookie rides on `credentials: 'include'`); built, the
 * page is served by the same host that proxies `/v1/traders`, so it is relative.
 */
export const TRADERS_BASE: string =
  import.meta.env['VITE_TRADERS_API'] ??
  (import.meta.env.DEV ? `${window.location.protocol}//${window.location.hostname}:8894` : '')

export class TradersApiError extends Error {
  readonly status: number
  constructor(status: number, message: string) {
    super(message)
    this.name = 'TradersApiError'
    this.status = status
  }
}

const READ_TIMEOUT_MS = 20_000
const WRITE_TIMEOUT_MS = 60_000

let asTrader: string | null = null
let onUnauthorized: (() => void) | null = null

/** The admin's trader picker. `null` clears it. Sent as `?as=` on trader-data calls only. */
export function setAsTrader(name: string | null): void {
  asTrader = name === null || name === '' ? null : name
}

export function setUnauthorized(fn: () => void): void {
  onUnauthorized = fn
}

const tradersListeners = new Set<() => void>()

/** Called after an admin adds or changes a trader, so the top bar's picker lists it without a reload. */
export function onTradersChanged(fn: () => void): () => void {
  tradersListeners.add(fn)
  return () => { tradersListeners.delete(fn) }
}

function tradersChanged<T>(p: Promise<T>): Promise<T> {
  return p.then((v) => { for (const fn of tradersListeners) fn(); return v })
}

function withAs(path: string): string {
  if (asTrader === null || path.startsWith('/admin/') || path.startsWith('/auth/')) return path
  return `${path}${path.includes('?') ? '&' : '?'}as=${encodeURIComponent(asTrader)}`
}

/** The book's live stream (Server-Sent Events), with the admin's `?as=` like the other book reads. */
export function liveUrl(stock: string): string {
  return `${TRADERS_BASE}${PREFIX}${withAs(`/books/${encodeURIComponent(stock)}/live`)}`
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const isBlob = typeof Blob !== 'undefined' && body instanceof Blob
  const hasBody = body !== undefined
  const headers: Record<string, string> = {}
  if (hasBody) headers['content-type'] = isBlob ? 'application/octet-stream' : 'application/json'
  const isRead = method === 'GET'
  try {
    const res = await fetch(`${TRADERS_BASE}${PREFIX}${withAs(path)}`, {
      method,
      credentials: 'include',
      signal: AbortSignal.timeout(isRead ? READ_TIMEOUT_MS : WRITE_TIMEOUT_MS),
      headers,
      ...(hasBody ? { body: isBlob ? (body as Blob) : JSON.stringify(body) } : {}),
    })
    if (!res.ok) {
      const b = (await res.json().catch(() => ({}))) as { error?: string }
      // A rejected login is the expected answer to a wrong password, not a dead session.
      if (res.status === 401 && path !== '/auth/login') onUnauthorized?.()
      throw new TradersApiError(res.status, b.error ?? res.statusText)
    }
    return (await res.json().catch(() => ({}))) as T
  } catch (err) {
    if (err instanceof DOMException && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      throw new TradersApiError(
        0,
        isRead
          ? 'no response — the traders server is not answering'
          : 'no response — the change may still have been applied; reload to check',
      )
    }
    throw err
  }
}

export const tradersApi = {
  get: <T>(path: string): Promise<T> => request<T>('GET', path),
  post: <T>(path: string, body?: unknown): Promise<T> => request<T>('POST', path, body),
  put: <T>(path: string, body: unknown | Blob): Promise<T> => request<T>('PUT', path, body),
  patch: <T>(path: string, body: unknown): Promise<T> => request<T>('PATCH', path, body),
  del: <T>(path: string): Promise<T> => request<T>('DELETE', path),
}

const seg = encodeURIComponent

/** `?a=1&b=2` from the defined entries, or ''. */
function query(q: Record<string, string | undefined>): string {
  const parts = Object.entries(q)
    .filter((e): e is [string, string] => e[1] !== undefined && e[1] !== '')
    .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
  return parts.length === 0 ? '' : `?${parts.join('&')}`
}

export interface AnalysisQueryInput {
  readonly expiry: string | null; readonly exclude: readonly string[]; readonly illiquid: readonly string[]
  readonly ivOverrides: Readonly<Record<string, number>> // decimal
  readonly callVol: number; readonly putVol: number; readonly future: number | null
  readonly gap?: readonly GapInput[]; readonly gapUseLtp?: boolean; readonly gapUseVol?: boolean; readonly volBasis?: VolBasis
}

const DEFAULT_GAP: readonly GapInput[] = [{ movePct: 10, volPts: -10 }, { movePct: -10, volPts: -10 }]

/** The analysis query string, in the order and with the omissions the server's parser expects. */
export function analysisQuery(p: AnalysisQueryInput): string {
  const parts: string[] = []
  const add = (k: string, v: string | number): void => { parts.push(`${k}=${encodeURIComponent(String(v))}`) }
  if (p.expiry !== null) add('expiry', p.expiry)
  for (const k of p.exclude) add('exclude', k)
  for (const k of p.illiquid) add('illiquid', k)
  // The server splits on the LAST '@', so a key may itself contain one.
  for (const [k, iv] of Object.entries(p.ivOverrides)) if (Number.isFinite(iv) && iv > 0) add('iv', `${k}@${iv}`)
  if (Number.isFinite(p.callVol) && p.callVol !== 0) add('callVol', p.callVol)
  if (Number.isFinite(p.putVol) && p.putVol !== 0) add('putVol', p.putVol)
  if (p.future !== null && Number.isFinite(p.future) && p.future > 0) add('future', p.future)
  const gap = p.gap
  const gapFinite = gap !== undefined && gap.every((g) => Number.isFinite(g.movePct) && Number.isFinite(g.volPts))
  if (gap !== undefined && gapFinite && !(gap.length === 2 && gap.every((g, i) => g.movePct === DEFAULT_GAP[i]?.movePct && g.volPts === DEFAULT_GAP[i]?.volPts))) {
    for (const g of gap) add('gap', `${g.movePct},${g.volPts}`)
  }
  if (p.gapUseLtp === false) add('gapLtp', 0)
  if (p.gapUseVol === false) add('gapVol', 0)
  if (p.volBasis !== undefined && p.volBasis !== 'future') add('basis', p.volBasis)
  return parts.join('&')
}

export const tapi = {
  me: () => tradersApi.get<{ username: string; role: Role }>('/auth/me'),
  login: (u: string, p: string) =>
    tradersApi.post<{ username: string; role: Role }>('/auth/login', { username: u, password: p }),
  logout: () => tradersApi.post<void>('/auth/logout'),

  books: () => tradersApi.get<BookSummary[]>('/books'),
  book: (stock: string) => tradersApi.get<BookView>(`/books/${seg(stock)}`),
  addLeg: (stock: string, body: Omit<ManualLegInput, 'stock'>) =>
    tradersApi.post<TraderLeg>(`/books/${seg(stock)}/legs`, body),
  analysis: (stock: string, p: AnalysisQueryInput) => {
    const q = analysisQuery(p)
    return tradersApi.get<AnalysisView>(`/books/${seg(stock)}/analysis${q === '' ? '' : `?${q}`}`)
  },
  scenario: (stock: string, body: ScenarioRequest) =>
    tradersApi.post<ScenarioView>(`/books/${seg(stock)}/scenario`, body),
  margin: (stock: string, exclude: readonly string[]) =>
    tradersApi.get<MarginView>(
      `/books/${seg(stock)}/margin${exclude.length === 0 ? '' : `?${exclude.map((k) => `exclude=${encodeURIComponent(k)}`).join('&')}`}`,
    ),
  chargeSettings: () => tradersApi.get<{ charges: ChargeRates }>('/admin/settings'),
  putChargeSettings: (charges: ChargeRates) => tradersApi.put<{ charges: ChargeRates }>('/admin/settings', { charges }),
  patchLeg: (key: string, p: { qty?: number; avgPrice?: number; note?: string }) =>
    tradersApi.patch<TraderLeg>(`/legs/${seg(key)}`, p),
  deleteLeg: (key: string) => tradersApi.del<void>(`/legs/${seg(key)}`),

  orders: (q: { day?: string; stock?: string }) =>
    tradersApi.get<TraderOrder[]>(`/orders${query({ day: q.day, stock: q.stock })}`),
  trades: (q: { day?: string; stock?: string }) =>
    tradersApi.get<TraderTrade[]>(`/trades${query({ day: q.day, stock: q.stock })}`),
  log: (q: { day?: string }) => tradersApi.get<LogLine[]>(`/log${query({ day: q.day })}`),
  watcher: () => tradersApi.get<WatcherStatus | null>('/watcher'),
  files: () => tradersApi.get<StoredFile[]>('/files'),

  adminTraders: () => tradersApi.get<AdminTraderRow[]>('/admin/traders'),
  addTrader: (u: string, p: string) =>
    tradersChanged(tradersApi.post<void>('/admin/traders', { username: u, password: p })),
  patchTrader: (name: string, p: { disabled?: boolean; password?: string }) =>
    tradersChanged(tradersApi.patch<void>(`/admin/traders/${seg(name)}`, p)),
  issueToken: (name: string) => tradersApi.post<{ token: string }>(`/admin/traders/${seg(name)}/token`),
  revokeToken: (name: string) => tradersApi.del<void>(`/admin/traders/${seg(name)}/token`),
  uploadFile: (name: string, path: string, file: Blob) =>
    tradersApi.put<{ stored: true; parser: string | null; parseError: string | null }>(
      `/admin/traders/${seg(name)}/files?path=${seg(path)}`,
      file,
    ),

  market: (stock: string) => tradersApi.get<MarketWatchView>(`/market/${seg(stock)}`),
  contracts: (stock: string) => tradersApi.get<ContractsView>(`/contracts/${seg(stock)}`),

  portfolio: () => tradersApi.get<PortfolioView>('/portfolio'),
  adminPortfolio: () => tradersApi.get<AdminPortfolioView>('/admin/portfolio'),
  groups: (stock: string) => tradersApi.get<GroupsView>(`/books/${seg(stock)}/groups`),
  putGroups: (stock: string, groups: readonly LegGroup[]) =>
    tradersApi.put<GroupsView>(`/books/${seg(stock)}/groups`, { groups }),

  advice: (stock: string) => tradersApi.get<AdviceCard>(`/books/${seg(stock)}/advice`),
  putBand: (stock: string, lots: number | null) => tradersApi.put<BandStatus>(`/books/${seg(stock)}/band`, { lots }),
  repair: (stock: string, tailCap?: number) =>
    tradersApi.post<RepairView>(`/books/${seg(stock)}/repair`, tailCap === undefined ? {} : { tailCap }),

  // The AI desk (spec 2026-10-23 §6.4). Every one of these may answer 404 from a server not yet restarted onto it.
  assistantStatus: () => tradersApi.get<AssistantStatus>('/assistant/status'),
  conversations: () => tradersApi.get<readonly ConversationSummary[] | { conversations: readonly ConversationSummary[] }>('/assistant/conversations'),
  conversation: (id: string) => tradersApi.get<ConversationView>(`/assistant/conversations/${seg(id)}`),
  deleteConversation: (id: string) => tradersApi.del<void>(`/assistant/conversations/${seg(id)}`),
  feedback: (id: string, body: FeedbackRequest) => tradersApi.post<unknown>(`/assistant/conversations/${seg(id)}/feedback`, body),
  planSearch: (stock: string, body: PlanSearchRequest) => tradersApi.post<{ card: AssistantCard }>(`/books/${seg(stock)}/plan-search`, body),
  marketContext: (stock: string) => tradersApi.get<MarketContext>(`/market/${seg(stock)}/context`),

  // End-of-day volatility of the held stocks (vol addendum); an admin without a trader picked gets every held stock.
  vol: () => tradersApi.get<VolView>('/vol'),

  // Portfolio risk and the results-event risk of the held books (risk spec); `get` adds the admin's `?as=`.
  risk: () => tradersApi.get<RiskView>('/risk'),
  events: () => tradersApi.get<EventRiskView>('/events'),

  // The daily record (written at 15:45 IST) and, for an admin, which data arrived. Either may answer 404 from a server not yet restarted onto it.
  daily: (q: { days?: number; trader?: string }) =>
    tradersApi.get<DailyView>(`/daily${query({ days: q.days === undefined ? undefined : String(q.days), trader: q.trader })}`),
  dataStatus: (days?: number) =>
    tradersApi.get<DataStatusView>(`/admin/data-status${query({ days: days === undefined ? undefined : String(days) })}`),
  // Booked P&L over expiry months (spec 2026-10-23 G3); an admin's page pick goes as `?trader=`, the desk roll-up is admin only.
  booked: (q: { from?: string; to?: string; trader?: string }) =>
    tradersApi.get<BookedView>(`/booked${query({ from: q.from, to: q.to, trader: q.trader })}`),
  adminBooked: (q: { from?: string; to?: string }) => tradersApi.get<AdminBookedView>(`/admin/booked${query({ from: q.from, to: q.to })}`),
  // Phone alerts (gaps G7): the signed-in user's own phones, and the stored alerts the bell lists.
  pushKey: () => tradersApi.get<{ publicKey: string }>('/push/key'),
  pushSubscribe: (subscription: unknown) => tradersApi.post<{ subscribed: true; phones: number }>('/push/subscribe', subscription),
  pushUnsubscribe: (endpoint: string) => tradersApi.post<{ removed: boolean }>('/push/unsubscribe', { endpoint }),
  pushTest: () => tradersApi.post<{ sent: number; phones: number }>('/push/test', {}),
  alerts: (since: number) => tradersApi.get<readonly TraderAlert[]>(`/alerts${query({ since: String(since) })}`),
}

/** A refused chat turn: the HTTP status and, when the server named one, the reason's code (429 → busy or budget). */
export class AssistantHttpError extends TradersApiError {
  readonly code: AssistantErrorCode | null
  constructor(status: number, message: string, code: AssistantErrorCode | null) {
    super(status, message)
    this.name = 'AssistantHttpError'
    this.code = code
  }
}

const ERROR_CODES: readonly AssistantErrorCode[] = ['budget', 'busy', 'provider', 'timeout', 'internal']

/**
 * One chat turn: a POST answered with `text/event-stream` (EventSource cannot POST), read by the caller off
 * `body`. No timeout of its own — the server holds a turn to 120 s and the Stop button aborts `signal`. With the
 * admin's `?as=` like every trader-data call.
 */
export async function assistantChat(body: ChatRequest, signal: AbortSignal): Promise<Response> {
  const res = await fetch(`${TRADERS_BASE}${PREFIX}${withAs('/assistant/chat')}`, {
    method: 'POST',
    credentials: 'include',
    signal,
    headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    const b = (await res.json().catch(() => ({}))) as { error?: unknown; message?: unknown; code?: unknown }
    if (res.status === 401) onUnauthorized?.()
    const code = ERROR_CODES.find((c) => c === b.code) ?? null
    const text = typeof b.error === 'string' ? b.error : typeof b.message === 'string' ? b.message : res.statusText
    throw new AssistantHttpError(res.status, text, code)
  }
  return res
}
