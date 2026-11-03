/**
 * The two error predicates every write path in this app needs.
 *
 * Lifted out of `service.ts`/`submit.ts`/`store.ts`, which each carried their
 * own copy: three places to fix when a driver changes how it words a duplicate
 * key, and one of them (`store.ts`) had the check inlined where nobody would
 * grep for it.
 */

/**
 * A message safe to hand back to the caller.
 *
 * Covers `LiveRailBlocked` and every other `Error` subclass without naming
 * them — subclasses ARE `Error`, so their `.message` flows through here.
 */
export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** Mongo duplicate-key, across driver versions that word it differently. */
export function isDuplicateKey(err: unknown): boolean {
  const e = err as { code?: number; message?: string }
  return e?.code === 11000 || (e?.message ?? '').includes('duplicate key')
}
