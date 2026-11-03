/**
 * Identities never leave the box (spec R5). Two layers:
 *
 * 1. Every tool result is BUILT from an allowlist of fields — no client code,
 *    note, trader name, file name or leg key is ever copied into one — and a
 *    leg is named by an alias, `L1`…`Ln`, per conversation. The aliases are
 *    kept server side in the conversation's document, so "close L3" in a later
 *    turn still means the same leg.
 * 2. Before anything is handed to the model library, `Redactor.scrub` walks the
 *    value and replaces any string carrying one of the trader's identity tokens
 *    (client codes, leg keys, the username, long notes) with `[redacted]` — the
 *    backstop for a server line that quotes one.
 */

export const REDACTED = '[redacted]'

const ALIAS_RE = /^L([1-9]\d{0,3})$/

/** Leg key ↔ alias for one conversation. Aliases are handed out in order of first use and never reused. */
export class LegAliases {
  readonly #keys: string[]
  readonly #byKey = new Map<string, number>()

  constructor(keys: readonly string[] = []) {
    this.#keys = [...keys]
    this.#keys.forEach((k, i) => this.#byKey.set(k, i))
  }

  alias(key: string): string {
    let i = this.#byKey.get(key)
    if (i === undefined) {
      i = this.#keys.length
      this.#keys.push(key)
      this.#byKey.set(key, i)
    }
    return `L${i + 1}`
  }

  /** The leg key behind an alias; null for anything that is not one handed out in this conversation. */
  keyOf(alias: string): string | null {
    const m = ALIAS_RE.exec(alias.trim().toUpperCase())
    if (m === null) return null
    return this.#keys[Number(m[1]) - 1] ?? null
  }

  /** For the conversation's document (server side only). */
  get keys(): readonly string[] {
    return this.#keys
  }
}

export interface IdentitySource {
  readonly trader: string
  readonly legs: readonly { readonly clientCode: string; readonly key: string; readonly note: string }[]
  /** Anything else known to identify (other client codes from trades, file names). */
  readonly extra?: readonly string[]
}

const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** Replaces identity tokens in every string of a value. Short tokens are left alone: they would garble ordinary words. */
export class Redactor {
  readonly #re: RegExp | null

  constructor(src: IdentitySource) {
    const tokens = new Set<string>()
    for (const l of src.legs) {
      if (l.clientCode.length >= 3) tokens.add(l.clientCode)
      if (l.key.length >= 3) tokens.add(l.key)
      // a note is free text: only a long one is distinctive enough to hunt for inside other strings
      if (l.note.trim().length >= 12) tokens.add(l.note.trim())
    }
    for (const x of src.extra ?? []) if (x.length >= 3) tokens.add(x)
    const parts = [...tokens].sort((a, b) => b.length - a.length).map(escape)
    // the username only as a whole word: "ravi", never the "ravi" in "gravity"
    if (src.trader.length >= 3) parts.push(`(?<![A-Za-z0-9._-])${escape(src.trader)}(?![A-Za-z0-9._-])`)
    this.#re = parts.length === 0 ? null : new RegExp(parts.join('|'), 'g')
  }

  scrubText(s: string): string {
    if (this.#re === null) return s
    this.#re.lastIndex = 0
    return s.replace(this.#re, REDACTED)
  }

  /** A deep copy with every string (keys included) scrubbed. Plain data only: what a tool result is. */
  scrub<T>(value: T): T {
    return this.#walk(value) as T
  }

  #walk(v: unknown): unknown {
    if (typeof v === 'string') return this.scrubText(v)
    if (Array.isArray(v)) return v.map((x) => this.#walk(x))
    if (v !== null && typeof v === 'object') {
      const out: Record<string, unknown> = {}
      for (const [k, x] of Object.entries(v)) out[this.scrubText(k)] = this.#walk(x)
      return out
    }
    return v
  }
}
