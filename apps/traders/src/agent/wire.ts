/**
 * The assistant on the wire — types only, shared by the server (agent/*,
 * routes/assistant.ts) and the page (apps/web/src/traders/assistant/*), like
 * `analytics/wire.ts`. Spec: docs/superpowers/specs/2026-10-23-traders-ai-desk-design.md §6.4, §7.
 *
 * The stream is OUR protocol, not the AI SDK's UI stream: the page needs no
 * agent library, and the library can be swapped without touching the page.
 */
import type { PresetId } from '@algomaker/payoff'
import type { HypotheticalLeg } from '../analytics/wire.ts'
import type { MarketContext } from '../analytics/context-wire.ts'

/** The web's `WhatIfLeg`: a hypothetical row without its id. */
export type AssistantWhatIfLeg = Omit<HypotheticalLeg, 'id' | 'iv'> & { readonly iv?: number | null }

/** The trader's market view as the page sends it; the server resolves 'hv20' from the market context. */
export interface ViewChoice {
  readonly vol: 'implied' | 'hv20' | { readonly shiftPts: number } | { readonly annual: number }
  /** Percent per year. */
  readonly driftPct?: number
  /** ISO date. */
  readonly horizon?: string
}

export interface AssistantStatus {
  readonly enabled: boolean
  /** Why it is off, in a sentence for the page. */
  readonly reason?: string
  readonly provider?: string
  readonly model?: string
  readonly budget: {
    readonly traderUsdToday: number
    readonly traderCapUsd: number
    readonly globalUsdToday: number
    readonly globalCapUsd: number
  }
  readonly presets: readonly { readonly id: PresetId; readonly label: string }[]
}

export interface ChatRequest {
  readonly conversationId?: string
  readonly stock?: string
  /** ≤ 4000 characters. */
  readonly message: string
  /** The page's "Allow closing legs" checkbox. The model can never set it. */
  readonly allowClose?: boolean
  readonly presets?: readonly PresetId[]
  readonly view?: ViewChoice
}

export interface PlanSearchRequest {
  readonly presets: readonly PresetId[]
  readonly view?: ViewChoice
  readonly allowClose?: boolean
}

export interface CardMetrics {
  readonly margin: number | null
  readonly pop: number | null
  readonly ev: number | null
  readonly maxLoss: number
  readonly worstShock: number
  readonly deltaShares: number
  readonly deltaLots: number | null
  readonly delta0Gap: number | null
  readonly gamma: number
  readonly vega: number
  readonly theta: number
  readonly credit: number
  readonly charges: number | null
  /** Where `margin` came from: the real NSE SPAN + exposure, or the SPAN-lite estimate. Optional: added after the contract was cut. */
  readonly marginSource?: 'span' | 'span-lite'
  /** A SPAN file was there but could not price every contract (or had no exposure rate): `margin` is the estimate instead. */
  readonly marginPartial?: boolean
}

export interface PlanCard {
  readonly planId: string
  readonly rank: number
  /** e.g. "Sell 1 lot TCS 27 Oct 3600 CE @ 42.50". */
  readonly lines: readonly string[]
  readonly after: CardMetrics
  readonly change: Partial<CardMetrics>
  readonly flags: readonly string[]
  readonly binding: readonly string[]
  readonly whatIf: readonly AssistantWhatIfLeg[]
}

export type AssistantCard =
  | {
      readonly kind: 'plans'
      readonly id: string
      readonly stock: string
      readonly title: string
      /** One sentence: the goal and constraints as the search ran them. */
      readonly objective: string
      readonly view: string | null
      readonly indicative: boolean
      readonly baseline: CardMetrics
      readonly plans: readonly PlanCard[]
      readonly rejected: readonly { readonly reason: string; readonly count: number }[]
    }
  | {
      readonly kind: 'evaluation'
      readonly id: string
      readonly stock: string
      readonly title: string
      readonly indicative: boolean
      readonly plan: PlanCard
      readonly baseline: CardMetrics
    }
  | {
      readonly kind: 'neutralize'
      readonly id: string
      readonly stock: string
      readonly deltaShares: number
      readonly deltaLots: number | null
      readonly futures: { readonly lots: number; readonly side: 'BUY' | 'SELL'; readonly expiry: string; readonly price: number | null } | null
      readonly delta0: number | null
      readonly spot: number | null
      readonly plans: readonly PlanCard[]
      readonly baseline: CardMetrics
      readonly indicative: boolean
    }
  | { readonly kind: 'context'; readonly id: string; readonly stock: string; readonly context: MarketContext }

export type AssistantErrorCode = 'budget' | 'busy' | 'provider' | 'timeout' | 'internal'

/** One server-sent event: `event: <name>` then `data: <json>`. */
export type AssistantEvent =
  | { readonly event: 'meta'; readonly data: { readonly conversationId: string; readonly model: string; readonly stock: string | null } }
  | { readonly event: 'text'; readonly data: { readonly delta: string } }
  | { readonly event: 'status'; readonly data: { readonly label: string } }
  | {
      readonly event: 'tool'
      readonly data: { readonly id: string; readonly name: string; readonly label: string; readonly state: 'start' | 'done' | 'error'; readonly summary?: string }
    }
  | { readonly event: 'card'; readonly data: AssistantCard }
  | { readonly event: 'warning'; readonly data: { readonly text: string } }
  | {
      readonly event: 'usage'
      readonly data: { readonly inputTokens: number; readonly outputTokens: number; readonly cachedTokens: number; readonly costUsd: number; readonly traderUsdToday: number }
    }
  | {
      readonly event: 'done'
      /** `turn` = this answer's index in ConversationView.turns, for feedback. */
      readonly data: { readonly provenance: { readonly checked: number; readonly unverified: readonly string[] }; readonly turn?: number }
    }
  | { readonly event: 'error'; readonly data: { readonly message: string; readonly code: AssistantErrorCode } }
  | { readonly event: 'ping'; readonly data: Record<string, never> }

export interface ConversationSummary {
  readonly id: string
  readonly title: string
  readonly stock: string | null
  readonly updatedAt: number
  readonly model: string
}

export interface ConversationView {
  readonly id: string
  readonly stock: string | null
  readonly turns: readonly {
    readonly role: 'user' | 'assistant'
    readonly text: string
    readonly cards: readonly AssistantCard[]
    readonly at: number
    readonly feedback?: 'up' | 'down' | null
  }[]
}

/** POST /assistant/conversations/:id/feedback — the trader's thumbs on one answer (spec §6.5a). */
export interface FeedbackRequest {
  readonly turn: number
  readonly rating: 'up' | 'down'
  /** ≤ 500 characters. */
  readonly note?: string
}

export interface AssistantUsageView {
  readonly days: number
  readonly rows: readonly { readonly trader: string; readonly day: string; readonly turns: number; readonly inputTokens: number; readonly outputTokens: number; readonly usd: number }[]
}
