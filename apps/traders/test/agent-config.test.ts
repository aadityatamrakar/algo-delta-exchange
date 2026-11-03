/**
 * The assistant's settings, prices, caps and provider factory. No Mongo, no
 * network: a provider is built but never called (a fetch that throws proves it).
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { inspect } from 'node:util'
import { MockLanguageModelV4 } from 'ai/test'
import { capRefusal, costUsd, priceFor, PRICE_TABLE, SpendLedger, TurnGate, worstCallUsd } from '../src/agent/budget.ts'
import { AI_OFF, aiConfigFromEnv, Secret } from '../src/agent/config.ts'
import { assertModelObject, modelFor } from '../src/agent/model.ts'

const ON = { TRADERS_AI_ENABLED: '1', TRADERS_AI_API_KEY: 'sk-test-SENTINEL-KEY' }

test('off by default, off without a key, and every reason is a sentence', () => {
  const none = aiConfigFromEnv({})
  assert.equal(none.enabled, false)
  assert.equal(none.reason, AI_OFF.reason)
  const noKey = aiConfigFromEnv({ TRADERS_AI_ENABLED: '1' })
  assert.equal(noKey.enabled, false)
  assert.match(noKey.reason ?? '', /no API key/)
  const keyOnly = aiConfigFromEnv({ TRADERS_AI_API_KEY: 'k' })
  assert.equal(keyOnly.enabled, false, 'a key alone does not turn it on')
})

test('on with ENABLED=1 and a key: the defaults are the spec\'s', () => {
  const c = aiConfigFromEnv(ON)
  assert.equal(c.enabled, true)
  assert.equal(c.reason, null)
  assert.deepEqual([c.provider, c.model, c.effort, c.maxSteps, c.dailyUsd, c.traderDailyUsd], ['anthropic', 'claude-opus-5-5', 'medium', 10, 25, 5])
  assert.deepEqual(c.price, PRICE_TABLE['claude-opus-5-5'])
})

test('the key never prints: JSON, String() and inspect all say [redacted]', () => {
  const c = aiConfigFromEnv(ON)
  assert.equal(JSON.stringify(c).includes('SENTINEL'), false)
  assert.equal(inspect(c, { depth: 5 }).includes('SENTINEL'), false)
  assert.equal(String(c.key), '[redacted]')
  assert.equal(new Secret('x').reveal(), 'x')
})

test('bad values turn it off with the reason; a step cap over 10 is clamped', () => {
  assert.match(aiConfigFromEnv({ ...ON, TRADERS_AI_PROVIDER: 'acme' }).reason ?? '', /TRADERS_AI_PROVIDER is not one of/)
  assert.match(aiConfigFromEnv({ ...ON, TRADERS_AI_DAILY_USD: '-3' }).reason ?? '', /TRADERS_AI_DAILY_USD/)
  assert.match(aiConfigFromEnv({ ...ON, TRADERS_AI_PROVIDER: 'openai-compatible', TRADERS_AI_MODEL: 'llama' }).reason ?? '', /needs TRADERS_AI_BASE_URL/)
  assert.equal(aiConfigFromEnv({ ...ON, TRADERS_AI_MAX_STEPS: '50' }).maxSteps, 10)
  assert.equal(aiConfigFromEnv({ ...ON, TRADERS_AI_MAX_STEPS: '4' }).maxSteps, 4)
})

test('a model with no price stays off unless both price overrides are set', () => {
  const unknown = aiConfigFromEnv({ ...ON, TRADERS_AI_PROVIDER: 'openai', TRADERS_AI_MODEL: 'gpt-9' })
  assert.equal(unknown.enabled, false)
  assert.match(unknown.reason ?? '', /no price for the model in TRADERS_AI_MODEL/)
  const half = aiConfigFromEnv({ ...ON, TRADERS_AI_MODEL: 'gpt-9', TRADERS_AI_PRICE_IN_PER_MTOK: '1' })
  assert.match(half.reason ?? '', /set both/)
  const priced = aiConfigFromEnv({ ...ON, TRADERS_AI_PROVIDER: 'openai', TRADERS_AI_MODEL: 'gpt-9', TRADERS_AI_PRICE_IN_PER_MTOK: '2', TRADERS_AI_PRICE_OUT_PER_MTOK: '8' })
  assert.equal(priced.enabled, true)
  assert.deepEqual(priced.price, { inPerMTok: 2, outPerMTok: 8, cacheReadPerMTok: 0.2, cacheWritePerMTok: 2.5 })
})

test('cost: uncached input, cache reads and writes, and output each at their own rate', () => {
  const p = priceFor('claude-opus-5-5', null)!
  // 1M prompt tokens of which 600k read from cache and 100k written; 10k out
  const usd = costUsd({ inputTokens: 1_000_000, cacheReadTokens: 600_000, cacheWriteTokens: 100_000, outputTokens: 10_000 }, p)
  assert.equal(usd, Math.round((300_000 * 4 + 600_000 * 0.2 + 100_000 * 5 + 10_000 * 20) / 1e6 * 1e4) / 1e4)
})

test('caps: the desk cap first, then the trader\'s', () => {
  assert.equal(capRefusal({ traderUsd: 1, globalUsd: 1 }, { traderUsd: 5, globalUsd: 25 }), null)
  assert.match(capRefusal({ traderUsd: 5, globalUsd: 6 }, { traderUsd: 5, globalUsd: 25 })!.message, /your assistant budget/)
  assert.match(capRefusal({ traderUsd: 0, globalUsd: 25 }, { traderUsd: 5, globalUsd: 25 })!.message, /desk's assistant budget/)
})

test('one turn per trader, four in all; a release frees the slot once', () => {
  const g = new TurnGate()
  const a = g.enter('ravi')
  assert.ok(a)
  assert.equal(g.enter('ravi'), null, 'a second turn for the same trader is busy')
  const others = ['sita', 'gita', 'mira'].map((t) => g.enter(t))
  assert.ok(others.every((r) => r !== null))
  assert.equal(g.enter('lata'), null, 'the fifth turn on the desk is busy')
  a!(); a!()
  assert.equal(g.running, 3)
  assert.ok(g.enter('lata'))
})

test('modelFor never returns a string: every provider answers an explicit instance', () => {
  const refuse = (async () => { throw new Error('no network in tests') }) as typeof fetch
  const cases = [
    { TRADERS_AI_PROVIDER: 'anthropic', TRADERS_AI_MODEL: 'claude-opus-5-5' },
    { TRADERS_AI_PROVIDER: 'openai', TRADERS_AI_MODEL: 'gpt-6', TRADERS_AI_PRICE_IN_PER_MTOK: '1', TRADERS_AI_PRICE_OUT_PER_MTOK: '2' },
    { TRADERS_AI_PROVIDER: 'google', TRADERS_AI_MODEL: 'gemini-3-pro', TRADERS_AI_PRICE_IN_PER_MTOK: '1', TRADERS_AI_PRICE_OUT_PER_MTOK: '2' },
    { TRADERS_AI_PROVIDER: 'openai-compatible', TRADERS_AI_MODEL: 'llama-4', TRADERS_AI_BASE_URL: 'http://127.0.0.1:9/v1', TRADERS_AI_PRICE_IN_PER_MTOK: '1', TRADERS_AI_PRICE_OUT_PER_MTOK: '2' },
  ]
  for (const env of cases) {
    const cfg = aiConfigFromEnv({ ...ON, ...env })
    assert.equal(cfg.enabled, true, cfg.reason ?? '')
    const m = modelFor(cfg, { fetch: refuse })
    assert.notEqual(typeof m.model, 'string', env.TRADERS_AI_PROVIDER)
    assert.equal(typeof (m.model as { doStream: unknown }).doStream, 'function')
    assert.equal(m.modelId, env.TRADERS_AI_MODEL)
    assert.equal(m.provider, env.TRADERS_AI_PROVIDER)
    assert.equal(JSON.stringify(m.providerOptions).includes('SENTINEL'), false, 'the key is not in the provider options')
  }
})

test('anthropic: prompt caching on, effort and server-side fallbacks for Opus 5.5; others carry no cache markers', () => {
  const a = modelFor(aiConfigFromEnv(ON))
  assert.deepEqual(a.caps, { promptCaching: true, parallelTools: true, effort: true })
  assert.deepEqual(a.providerOptions, { anthropic: { effort: 'medium', fallbacks: 'default' } })
  const haiku = modelFor(aiConfigFromEnv({ ...ON, TRADERS_AI_MODEL: 'claude-haiku-4-5' }))
  assert.deepEqual(haiku.providerOptions, { anthropic: {} }, 'Haiku 4.5 takes no effort')
  const o = modelFor(aiConfigFromEnv({ ...ON, TRADERS_AI_PROVIDER: 'openai', TRADERS_AI_MODEL: 'gpt-6', TRADERS_AI_PRICE_IN_PER_MTOK: '1', TRADERS_AI_PRICE_OUT_PER_MTOK: '2' }))
  assert.equal(o.caps.promptCaching, false)
  assert.equal(o.providerOptions['openai']?.['store'], false, 'nothing is stored at OpenAI')
})

test('assertModelObject refuses a string id and a non-model; a mock model passes', () => {
  assert.throws(() => assertModelObject('anthropic/claude-opus-5-5'), /never a string/)
  assert.throws(() => assertModelObject({}), /not a language model/)
  assertModelObject(new MockLanguageModelV4())
})

test('the ledger: four turns at once cannot pass the desk cap together — each new one sees what the others hold', () => {
  const p = priceFor('claude-opus-5-5', null)!
  const caps = { traderUsd: 5, globalUsd: 25 }
  const worst = worstCallUsd(500_000, 16_000, p)   // $2 + $0.32
  assert.equal(worst, 2.32)
  const ledger = new SpendLedger()
  const stored = { traderUsd: 0, globalUsd: 18 }
  const admitted: string[] = []
  for (const t of ['ravi', 'sita', 'gita', 'mira']) {
    const held = ledger.held(t)
    if (capRefusal({ traderUsd: stored.traderUsd + held.traderUsd, globalUsd: stored.globalUsd + held.globalUsd }, caps, worst) === null) {
      ledger.hold(`turn-${t}`, t, worst)
      admitted.push(t)
    }
  }
  assert.deepEqual(admitted, ['ravi', 'sita', 'gita'], '18 + 3 × 2.32 = 24.96 fits; a fourth would pass 25')
  assert.deepEqual(ledger.held('ravi', 'turn-ravi'), { traderUsd: 0, globalUsd: 4.64 })
  ledger.set('turn-ravi', 0.5)
  ledger.release('turn-sita')
  assert.deepEqual(ledger.held('mira'), { traderUsd: 0, globalUsd: 2.82 })
  assert.equal(capRefusal({ traderUsd: 4.9, globalUsd: 0 }, caps, 0.2)?.code, 'budget', 'a reservation past the trader cap is refused')
  assert.equal(capRefusal({ traderUsd: 4.7, globalUsd: 0 }, caps, 0.2), null)
})

test('a reason names the variable, never its value: every trader sees it, and main.ts logs it', () => {
  const env = {
    ...ON, TRADERS_AI_PROVIDER: 'sk-live-LEAKED-1', TRADERS_AI_EFFORT: 'LEAKED-2', TRADERS_AI_BASE_URL: 'LEAKED-3 not a url',
    TRADERS_AI_MODEL: 'LEAKED-4', TRADERS_AI_DAILY_USD: 'LEAKED-5',
  }
  const reason = aiConfigFromEnv(env).reason ?? ''
  assert.match(reason, /TRADERS_AI_PROVIDER/)
  assert.match(reason, /TRADERS_AI_EFFORT/)
  assert.equal(reason.includes('LEAKED'), false, reason)
  const unpriced = aiConfigFromEnv({ ...ON, TRADERS_AI_MODEL: 'LEAKED-6' }).reason ?? ''
  assert.equal(unpriced.includes('LEAKED'), false, unpriced)
})
