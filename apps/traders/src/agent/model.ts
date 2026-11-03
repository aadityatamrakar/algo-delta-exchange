/**
 * The provider factory (spec R3, §6.1): one of the two files that import the
 * AI SDK. It turns an `AiConfig` into an EXPLICIT provider instance, its
 * per-call provider options and what the provider can do (`caps`), so the loop
 * adapts without knowing which provider it holds.
 *
 * Never a bare string model id: in AI SDK v7 a string routes to Vercel's AI
 * Gateway, which would send book data to a third party. `modelFor` builds the
 * instance itself and refuses anything that is not one (`assertModelObject`,
 * pinned by test/agent-model.test.ts). The key leaves its `Secret` here and
 * only here.
 */

import { createAnthropic } from '@ai-sdk/anthropic'
import { createGoogle } from '@ai-sdk/google'
import { createOpenAI } from '@ai-sdk/openai'
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import type { JSONValue, LanguageModel } from 'ai'
import type { AiConfig, AiEffort } from './config.ts'

/** A model object, never the gateway's string form. */
export type ModelObject = Exclude<LanguageModel, string>

export type ProviderOptionsBag = Record<string, Record<string, JSONValue>>

export interface ModelCaps {
  /** Explicit cache markers (Anthropic `cache_control`) on the stable prefix and the conversation tail. */
  readonly promptCaching: boolean
  readonly parallelTools: boolean
  /** A reasoning-effort option was set from TRADERS_AI_EFFORT. */
  readonly effort: boolean
}

export interface ModelChoice {
  readonly model: ModelObject
  readonly providerOptions: ProviderOptionsBag
  readonly caps: ModelCaps
  readonly provider: string
  readonly modelId: string
}

export type ModelFactory = (cfg: AiConfig) => ModelChoice

export interface ModelForOptions {
  /** Tests hand in a fetch that answers canned bytes: nothing leaves the box. */
  readonly fetch?: typeof globalThis.fetch
}

/** Throws when handed a string (the gateway route) or anything that is not a language model object. */
export function assertModelObject(m: unknown): asserts m is ModelObject {
  if (typeof m === 'string') throw new Error('a model must be a provider instance, never a string id (a string routes to the AI Gateway)')
  if (typeof m !== 'object' || m === null || typeof (m as { doStream?: unknown }).doStream !== 'function') {
    throw new Error('not a language model object')
  }
}

/** Claude models that take `effort` (Opus 4.5 on); Haiku 4.5 and Sonnet 4.5 refuse it. */
const ANTHROPIC_EFFORT = /^claude-(opus-4-[5-9]|opus-5|sonnet-4-6|sonnet-5|haiku-5|fable-5|mythos-5)/
/** Claude models whose refusals the API can serve from a fallback model (the claude-api skill's default). */
const ANTHROPIC_FALLBACKS = /^claude-(opus-5-5|opus-5$|sonnet-5-5|fable-5-1)/
/** OpenAI models that reason (and take `reasoningEffort`). */
const OPENAI_REASONING = /^(o\d|gpt-[5-9])/
/** Gemini models with thinking levels. */
const GEMINI_THINKING = /^gemini-([3-9])/

const googleLevel = (e: AiEffort): 'low' | 'medium' | 'high' => (e === 'low' ? 'low' : e === 'medium' ? 'medium' : 'high')

export function modelFor(cfg: AiConfig, o: ModelForOptions = {}): ModelChoice {
  if (cfg.key === null) throw new Error('no API key: the assistant is off')
  const apiKey = cfg.key.reveal()
  const baseURL = cfg.baseUrl ?? undefined
  const fetch = o.fetch
  const common = { apiKey, ...(baseURL === undefined ? {} : { baseURL }), ...(fetch === undefined ? {} : { fetch }) }
  let choice: ModelChoice
  switch (cfg.provider) {
    case 'anthropic': {
      const effort = ANTHROPIC_EFFORT.test(cfg.model)
      const options: Record<string, JSONValue> = {
        ...(effort ? { effort: cfg.effort } : {}),
        ...(ANTHROPIC_FALLBACKS.test(cfg.model) ? { fallbacks: 'default' } : {}),
      }
      choice = {
        model: createAnthropic(common)(cfg.model), providerOptions: { anthropic: options },
        caps: { promptCaching: true, parallelTools: true, effort }, provider: 'anthropic', modelId: cfg.model,
      }
      break
    }
    case 'openai': {
      const effort = OPENAI_REASONING.test(cfg.model)
      // not stored at OpenAI; reasoning comes back encrypted so a later step can replay it
      const options: Record<string, JSONValue> = {
        store: false,
        ...(effort ? { reasoningEffort: cfg.effort, include: ['reasoning.encrypted_content'] } : {}),
      }
      choice = {
        model: createOpenAI(common).responses(cfg.model), providerOptions: { openai: options },
        caps: { promptCaching: false, parallelTools: true, effort }, provider: 'openai', modelId: cfg.model,
      }
      break
    }
    case 'google': {
      const effort = GEMINI_THINKING.test(cfg.model)
      const options: Record<string, JSONValue> = effort ? { thinkingConfig: { thinkingLevel: googleLevel(cfg.effort) } } : {}
      choice = {
        model: createGoogle(common)(cfg.model), providerOptions: { google: options },
        caps: { promptCaching: false, parallelTools: true, effort }, provider: 'google', modelId: cfg.model,
      }
      break
    }
    case 'openai-compatible': {
      if (baseURL === undefined) throw new Error('the openai-compatible provider needs TRADERS_AI_BASE_URL')
      const p = createOpenAICompatible({ name: 'compatible', baseURL, apiKey, includeUsage: true, ...(fetch === undefined ? {} : { fetch }) })
      choice = {
        model: p.chatModel(cfg.model), providerOptions: {},
        caps: { promptCaching: false, parallelTools: false, effort: false }, provider: 'openai-compatible', modelId: cfg.model,
      }
      break
    }
  }
  assertModelObject(choice.model)
  return choice
}
