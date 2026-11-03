/**
 * Subscription demand declared by ANOTHER PROCESS.
 *
 * THE HOLE THIS CLOSES. `main.ts` used to build its subscription plan out of
 * `store.allBooks(...)` alone — the Python desk's open books — so the hosted
 * strategy runner's tokens were never subscribed at all. `RunnerMarketData`
 * exposed `subscriptionSet()` and nothing in the repo but its own test ever
 * called it. The visible consequence was not an error: BHEL kept ticking, so
 * `/v1/desk/feed` reported healthy, while NIFTY/BANKNIFTY/SENSEX never arrived,
 * `isTrustworthy()` stayed false for the whole session, `canEnter()` blocked
 * every entry, and no option token could ever be declared because a chain
 * window cannot be centred without spot. A perfectly healthy-looking desk that
 * could not take a trade.
 *
 * WHY MONGO AND NOT THE BUS. `WsTransportServer` never registers a handler for
 * inbound client frames — it broadcasts and clients filter locally — so a
 * `publish()` from the runner (a client) reaches nobody. Rather than change the
 * bus's direction, demand is declared exactly the way the desk's own demand
 * already is: a document both processes can see. It also survives a marketdata
 * restart, which a fire-and-forget message would not.
 *
 * STALENESS IS PART OF THE CONTRACT. A declaration carries the instant it was
 * written and the reader drops one that has stopped being refreshed, so a
 * decommissioned or wedged publisher does not hold hundreds of tokens on the
 * sockets forever. The window is generous (the runner rewrites every 15s) —
 * this is garbage collection, not a heartbeat, and dropping a live publisher's
 * tokens would blind it.
 */

export const SUBSCRIPTION_COLLECTION = 'desk-subscriptions'

/**
 * How long a declaration stays honoured after its last write.
 *
 * 10 minutes against a 15-second refresh: 40 consecutive missed writes before
 * anything is dropped. A GC pass that fires on one slow Mongo round trip would
 * unsubscribe a running strategy's instruments mid-session, which is a far more
 * expensive mistake than carrying a dead publisher's tokens for ten minutes.
 */
export const SUBSCRIPTION_MAX_AGE_MS = 10 * 60_000

/** The subscriber name the hosted strategy runner declares under. */
export const RUNNER_SUBSCRIPTION_SOURCE = 'hosted-runner'

export interface DeclaredSubscription {
  readonly source: string
  readonly tokens: readonly number[]
  readonly updatedAt: number
}

/** The narrow Mongo surface this needs. Same port style as `sync-runner.ts`. */
export interface SubscriptionCollection {
  find(filter: Record<string, unknown>): { toArray(): Promise<Record<string, unknown>[]> }
  updateOne(
    filter: Record<string, unknown>,
    update: Record<string, unknown>,
    options?: { upsert?: boolean },
  ): Promise<unknown>
  createIndex(spec: Record<string, 1 | -1>, options?: { unique?: boolean }): Promise<unknown>
}

/**
 * `source` is UNIQUE. Two documents for one publisher would make "what does the
 * runner want subscribed?" depend on Mongo's return order, and a half-applied
 * write would look like a working declaration with an arbitrary subset of the
 * tokens — i.e. a strategy silently blind to some of its own instruments.
 */
export async function ensureSubscriptionIndexes(col: SubscriptionCollection): Promise<void> {
  await col.createIndex({ source: 1 }, { unique: true })
}

/**
 * Declare a publisher's COMPLETE token set. Idempotent and last-writer-wins:
 * the document is the whole declaration, never a delta, so a publisher that
 * dropped a strategy shrinks its set on the next write with nothing to
 * reconcile.
 */
export async function publishSubscription(
  col: SubscriptionCollection,
  source: string,
  tokens: readonly number[],
  nowMs: number,
): Promise<void> {
  // Sorted and de-duplicated so an unchanged set produces a byte-identical
  // document: the reader hands it to `KiteFeedPool.declare`, which diffs, and a
  // set that only differs in ORDER would otherwise look like a change to any
  // future equality check.
  const unique = [...new Set(tokens)].sort((a, b) => a - b)
  await col.updateOne(
    { source },
    { $set: { source, tokens: unique, updatedAt: nowMs } },
    { upsert: true },
  )
}

/**
 * Split stored declarations into the ones still being refreshed and the ones
 * that have gone quiet. PURE, so the age rule is testable without a database.
 *
 * A malformed document (no source, tokens that are not numbers) is treated as
 * stale rather than as an empty declaration: an empty token list is a
 * meaningful statement ("I want nothing"), and letting a broken document make
 * that statement would unsubscribe a live publisher.
 */
export function splitByFreshness(
  docs: readonly Record<string, unknown>[],
  opts: { nowMs: number; maxAgeMs?: number },
): { live: DeclaredSubscription[]; stale: DeclaredSubscription[] } {
  const maxAgeMs = opts.maxAgeMs ?? SUBSCRIPTION_MAX_AGE_MS
  const live: DeclaredSubscription[] = []
  const stale: DeclaredSubscription[] = []
  for (const doc of docs) {
    const source = doc['source']
    if (typeof source !== 'string' || source === '') continue
    const raw = doc['tokens']
    const updatedAt = Number(doc['updatedAt'] ?? 0)
    const tokens = Array.isArray(raw)
      ? raw.filter((t): t is number => typeof t === 'number' && Number.isFinite(t))
      : null
    const entry: DeclaredSubscription = { source, tokens: tokens ?? [], updatedAt }
    if (tokens === null || !Number.isFinite(updatedAt) || opts.nowMs - updatedAt > maxAgeMs) {
      stale.push(entry)
    } else {
      live.push(entry)
    }
  }
  return { live, stale }
}

export async function readSubscriptions(
  col: SubscriptionCollection,
  opts: { nowMs: number; maxAgeMs?: number },
): Promise<{ live: DeclaredSubscription[]; stale: DeclaredSubscription[] }> {
  const docs = await col.find({}).toArray()
  return splitByFreshness(docs, opts)
}
