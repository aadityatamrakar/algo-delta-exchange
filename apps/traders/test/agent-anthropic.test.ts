/**
 * The real Anthropic provider, built by modelFor, against a fetch that answers
 * canned bytes: nothing leaves the box. Pins what the wire request carries —
 * the cache markers on the stable prefix and the tail, effort, the server-side
 * fallback, toolChoice auto — and that the key goes only in its header.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { runModel, type RunPart } from '../src/agent/ai-tools.ts'
import { aiConfigFromEnv } from '../src/agent/config.ts'
import { modelFor } from '../src/agent/model.ts'
import { SYSTEM_PROMPT } from '../src/agent/prompt.ts'
import { LegAliases, Redactor } from '../src/agent/redact.ts'
import type { ToolCtx } from '../src/agent/tools/ctx.ts'
import { PlanCache } from '../src/agent/tools/plans.ts'
import { AGENT_TOOLS } from '../src/agent/tools/index.ts'

const SSE = [
  ['message_start', { type: 'message_start', message: { id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-opus-5-5', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, cache_creation_input_tokens: 300, cache_read_input_tokens: 2000, output_tokens: 1 } } }],
  ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
  ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Delta is flat.' } }],
  ['content_block_stop', { type: 'content_block_stop', index: 0 }],
  ['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 7 } }],
  ['message_stop', { type: 'message_stop' }],
].map(([e, d]) => `event: ${e as string}\ndata: ${JSON.stringify(d)}\n\n`).join('')

test('anthropic on the wire: cache markers, effort, fallbacks, toolChoice auto, and the key only in its header', async () => {
  const seen: { url: string; headers: Record<string, string>; body: any }[] = []
  const fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const headers: Record<string, string> = {}
    new Headers(init?.headers).forEach((v, k) => { headers[k] = v })
    seen.push({ url: String(url), headers, body: JSON.parse(String(init?.body)) })
    return new Response(SSE, { status: 200, headers: { 'content-type': 'text/event-stream' } })
  }) as typeof globalThis.fetch
  const cfg = aiConfigFromEnv({ TRADERS_AI_ENABLED: '1', TRADERS_AI_API_KEY: 'sk-ant-SENTINEL' })
  const choice = modelFor(cfg, { fetch })
  const ctx = {
    trader: 'ravi', deps: {} as never, aliases: new LegAliases(), plans: new PlanCache(), redactor: new Redactor({ trader: 'ravi', legs: [] }),
    counters: { toolCalls: 0, searches: 0 }, allowClose: false, userText: '', presets: [], view: null, stock: null, nextCardId: () => 'K1',
  } satisfies ToolCtx
  const run = runModel({
    choice, system: SYSTEM_PROMPT, messages: [{ role: 'user', content: 'How is TCS?' }], tools: AGENT_TOOLS, ctx,
    limits: { maxSteps: 10, maxToolCalls: 16, maxSearches: 3, maxOutputTokens: 16000 }, abortSignal: new AbortController().signal, log: () => {},
  })
  const parts: RunPart[] = []
  for await (const p of run.parts) parts.push(p)

  assert.equal(seen.length, 1)
  const { url, headers, body } = seen[0]!
  assert.equal(url, 'https://api.anthropic.com/v1/messages')
  assert.equal(headers['x-api-key'], 'sk-ant-SENTINEL')
  const bodyText = JSON.stringify(body)
  assert.equal(bodyText.includes('SENTINEL'), false, 'the key is in its header, never the body')
  assert.equal(body.model, 'claude-opus-5-5')
  assert.equal(body.stream, true)
  assert.deepEqual(body.system, [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }], 'the stable prefix — tools + system — is marked')
  assert.deepEqual(body.cache_control, { type: 'ephemeral' }, 'and the conversation tail, by the top-level marker')
  assert.deepEqual(body.tool_choice, { type: 'auto' })
  assert.equal(body.tools.length, AGENT_TOOLS.length)
  assert.deepEqual(body.tools.map((t: { name: string }) => t.name), AGENT_TOOLS.map((t) => t.name), 'the tools in their fixed order')
  assert.equal(body.output_config?.effort, 'medium')
  assert.equal(body.fallbacks, 'default')
  assert.match(headers['anthropic-beta'] ?? '', /server-side-fallback/)
  assert.equal(body.max_tokens, 16000)

  assert.deepEqual(parts.filter((p) => p.kind === 'text').map((p) => (p as { delta: string }).delta), ['Delta is flat.'])
  // metered when the call ended, from the provider's own counts
  const m = run.meter()
  assert.deepEqual(m.usage, { inputTokens: 2310, outputTokens: 7, cacheReadTokens: 2000, cacheWriteTokens: 300 })
  assert.deepEqual([m.calls, m.cutOff], [1, 0])
  // stored as returned: the provider's own message-start part rides along with the text, and is replayed as is
  const msgs = JSON.parse(JSON.stringify(await run.messages())) as { role: string; content: { type: string; kind?: string; text?: string }[] }[]
  assert.equal(msgs.length, 1)
  assert.deepEqual(msgs[0]!.content.map((c) => [c.type, c.kind ?? c.text]), [['custom', 'anthropic.message_start'], ['text', 'Delta is flat.']])

  // the next turn replays that history: the provider takes it back without complaint, and sends the text block
  const again = runModel({
    choice, system: SYSTEM_PROMPT, messages: [{ role: 'user', content: 'How is TCS?' }, ...msgs, { role: 'user', content: 'And now?' }], tools: AGENT_TOOLS, ctx,
    limits: { maxSteps: 10, maxToolCalls: 16, maxSearches: 3, maxOutputTokens: 16000 }, abortSignal: new AbortController().signal, log: () => {},
  })
  const kinds: string[] = []
  for await (const p of again.parts) kinds.push(p.kind)
  assert.equal(kinds.includes('error'), false, kinds.join(','))
  const second = seen[1]!.body
  assert.deepEqual(second.messages.map((m: { role: string }) => m.role), ['user', 'assistant', 'user'])
  assert.deepEqual(second.messages[1].content.filter((c: { type: string }) => c.type === 'text').map((c: { text: string }) => c.text), ['Delta is flat.'])
  assert.deepEqual(second.system, body.system, 'the cached prefix is byte-identical turn to turn')
  assert.deepEqual(second.tools, body.tools)
})

test('a provider error is logged as one safe line: nothing of the request body reaches a log, and a refused call is not charged', async () => {
  const fetch = (async () => new Response(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'bad request' } }), {
    status: 400, headers: { 'content-type': 'application/json' },
  })) as typeof globalThis.fetch
  const choice = modelFor(aiConfigFromEnv({ TRADERS_AI_ENABLED: '1', TRADERS_AI_API_KEY: 'sk-ant-x' }), { fetch })
  const ctx = {
    trader: 'ravi', deps: {} as never, aliases: new LegAliases(), plans: new PlanCache(), redactor: new Redactor({ trader: 'ravi', legs: [] }),
    counters: { toolCalls: 0, searches: 0 }, allowClose: false, userText: '', presets: [], view: null, stock: null, nextCardId: () => 'K1',
  } satisfies ToolCtx
  const logged: unknown[] = []
  const printed: unknown[] = []
  const was = { error: console.error, warn: console.warn, log: console.log }
  console.error = (...a: unknown[]) => { printed.push(a) }
  console.warn = (...a: unknown[]) => { printed.push(a) }
  console.log = (...a: unknown[]) => { printed.push(a) }
  try {
    const run = runModel({
      choice, system: SYSTEM_PROMPT, messages: [{ role: 'user', content: 'BOOK-SENTINEL TCS short 3500 CE' }], tools: AGENT_TOOLS, ctx,
      limits: { maxSteps: 10, maxToolCalls: 16, maxSearches: 3, maxOutputTokens: 16000 }, abortSignal: new AbortController().signal,
      log: (msg, c) => { logged.push([msg, c]) },
    })
    const parts: RunPart[] = []
    for await (const p of run.parts) parts.push(p)
    const err = parts.find((p) => p.kind === 'error') as { status: number | null } | undefined
    assert.equal(err?.status, 400)
    assert.deepEqual(logged.map((l) => (l as [string])[0]), ['assistant model error'])
    assert.equal(JSON.stringify(logged).includes('BOOK-SENTINEL'), false, 'our log line carries no request body')
    const seen = JSON.stringify(printed, (_k, v: unknown) => (v instanceof Error ? { ...v, errorMessage: v.message, stack: v.stack } : v))
    assert.equal(seen.includes('BOOK-SENTINEL'), false, 'nothing printed to the console carries it either')
    assert.equal(run.meter().cutOff, 0, 'a call the provider refused with an HTTP status generated nothing: not charged')
  } finally {
    console.error = was.error; console.warn = was.warn; console.log = was.log
  }
})
