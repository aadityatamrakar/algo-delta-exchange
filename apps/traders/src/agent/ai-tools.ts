/**
 * The library adapter (spec R3): with model.ts, the only file that imports
 * the AI SDK. It turns our plain tools into the library's `tool()`s, runs one
 * turn with `streamText`, and hands the loop a stream of OUR parts — so
 * loop.ts, the routes and the page never see a library type, and the library
 * can be swapped by rewriting these two files.
 *
 * What it does for the rulings:
 * - R10: a step cap, a tool-call cap and the money caps stop the loop
 *   (`stopWhen`, `allowNextCall`); each tool call is counted before it runs,
 *   and searches separately; past a cap the tool answers a refusal the model
 *   can read instead of running. Every model call is metered when it ends
 *   (before its tools run), and a call cut off mid-stream is charged
 *   pessimistically (`Meter`).
 * - The library's default error logging prints the request body, which holds
 *   the book: `onError` logs one safe line instead.
 * - R5/R11: a tool result is scrubbed by the turn's Redactor before the model
 *   gets it; only `result` goes to the model (`toModelOutput`), cards go to the
 *   page. A thrown error is never passed through: its text could be anything.
 * - §6.1: `toolChoice: 'auto'` always (forced tool choice 400s on current
 *   Claude models). With prompt caching, the system prompt carries a cache
 *   marker — tools + system are the stable prefix every trader shares — and
 *   the request a top-level one, which caches the conversation's tail.
 */

import { isStepCount, streamText, tool, type JSONValue, type ModelMessage, type ToolSet } from 'ai'
import { addUsage, NO_USAGE, type TokenUsage } from './budget.ts'
import { assertModelObject, type ModelChoice } from './model.ts'
import { ToolRefusal, type AnyTool, type ToolCtx } from './tools/ctx.ts'
import type { AssistantCard } from './wire.ts'

/** A message as the library returns it. Opaque everywhere else: stored as JSON, replayed as is. */
export type AgentMessage = Readonly<Record<string, unknown>>

export interface TurnLimits {
  readonly maxSteps: number
  readonly maxToolCalls: number
  readonly maxSearches: number
  /** Output cap per model call (thinking included on Anthropic). */
  readonly maxOutputTokens: number
}

export interface ToolExec {
  readonly ok: boolean
  /** What the model saw. */
  readonly result: Readonly<Record<string, unknown>>
  readonly cards: readonly AssistantCard[]
  readonly summary: string | null
}

/** One turn as the loop reads it. */
export type RunPart =
  | { readonly kind: 'step-start' }
  | { readonly kind: 'reasoning' }
  | { readonly kind: 'text'; readonly delta: string }
  | { readonly kind: 'tool-start'; readonly id: string; readonly name: string; readonly input: unknown }
  | { readonly kind: 'tool-done'; readonly id: string; readonly name: string; readonly input: unknown; readonly exec: ToolExec }
  | { readonly kind: 'tool-failed'; readonly id: string; readonly name: string; readonly message: string }
  | { readonly kind: 'step-done'; readonly finish: string }
  | { readonly kind: 'finish'; readonly finish: string }
  | { readonly kind: 'error'; readonly message: string; readonly status: number | null }
  | { readonly kind: 'abort' }

export interface ModelRun {
  readonly parts: AsyncIterable<RunPart>
  /** What the turn's calls cost so far, cut-off calls charged pessimistically (R10). */
  meter(): Meter
  /** The response messages of every finished step, as returned (reasoning parts and provider metadata kept). */
  messages(): Promise<readonly AgentMessage[]>
}

export interface RunOptions {
  readonly choice: ModelChoice
  readonly system: string
  /** History (stored messages, replayed as is) and this turn's user message. */
  readonly messages: readonly AgentMessage[]
  readonly tools: readonly AnyTool[]
  readonly ctx: ToolCtx
  readonly limits: TurnLimits
  readonly abortSignal: AbortSignal
  readonly log: (msg: string, ctx?: Record<string, unknown>) => void
  /** Asked after each step: may the turn make another model call within the money caps? Absent = no money check. */
  readonly allowNextCall?: (m: Meter) => boolean | Promise<boolean>
}

const SERVER_FAILURE = 'the tool failed on the server — try another way, or tell the trader it is unavailable right now'

/** Runs one tool call under the turn's caps; never throws. */
export async function execTool(def: AnyTool, ctx: ToolCtx, input: unknown, limits: TurnLimits, log: RunOptions['log']): Promise<ToolExec> {
  const refuse = (error: string): ToolExec => ({ ok: false, result: { error }, cards: [], summary: error })
  ctx.counters.toolCalls++
  if (ctx.counters.toolCalls > limits.maxToolCalls) return refuse(`the ${limits.maxToolCalls} tool calls this turn allows are used: answer with what you have`)
  if (def.search === true) {
    ctx.counters.searches++
    if (ctx.counters.searches > limits.maxSearches) return refuse(`the ${limits.maxSearches} searches this turn allows are used: compare the plans you have`)
  }
  try {
    const out = await def.run(ctx, input as never)
    return { ok: true, result: ctx.redactor.scrub(out.result), cards: out.cards ?? [], summary: out.summary ?? null }
  } catch (e) {
    if (e instanceof ToolRefusal) return refuse(ctx.redactor.scrubText(e.message))
    log('assistant tool failed', { tool: def.name, error: e instanceof Error ? e.message : String(e) })
    return refuse(SERVER_FAILURE)
  }
}

function toolSetOf(o: RunOptions): ToolSet {
  const set: ToolSet = {}
  for (const def of o.tools) {
    set[def.name] = tool({
      description: def.description,
      inputSchema: def.input as never,
      execute: async (input: unknown) => await execTool(def, o.ctx, input, o.limits, o.log),
      toModelOutput: ({ output }) => ({ type: 'json', value: (output as ToolExec).result as JSONValue }),
    })
  }
  return set
}

function usageOf(u: { inputTokens?: number | undefined; outputTokens?: number | undefined; inputTokenDetails?: { cacheReadTokens?: number | undefined; cacheWriteTokens?: number | undefined } } | undefined): TokenUsage {
  return {
    inputTokens: u?.inputTokens ?? 0, outputTokens: u?.outputTokens ?? 0,
    cacheReadTokens: u?.inputTokenDetails?.cacheReadTokens ?? 0, cacheWriteTokens: u?.inputTokenDetails?.cacheWriteTokens ?? 0,
  }
}

/** A provider error as one safe line: its status and message, never its request body (which holds the book). */
export function errorOf(e: unknown): { message: string; status: number | null } {
  const o = (e ?? {}) as { statusCode?: unknown; message?: unknown; name?: unknown }
  const status = typeof o.statusCode === 'number' ? o.statusCode : null
  const msg = typeof o.message === 'string' ? o.message.slice(0, 300) : 'the model provider failed'
  return { message: msg, status }
}

/** A prompt's size in tokens, guessed from its bytes (about three a token): the charge for a call nobody counted. */
export const tokensOfBytes = (bytes: number): number => Math.ceil(bytes / 3)

/**
 * What the turn's model calls cost, as the provider counted them — taken when
 * each call ends, before its tools run, so a hang-up during a tool still pays
 * for the call. A call cut off mid-stream (a hang-up, Stop, the wall clock, a
 * broken stream) has no count: it is charged its prompt (the last call's
 * input, or its bytes ÷ 3, whichever is larger) and the full output cap.
 */
export interface Meter {
  /** Counted calls plus the pessimistic charge for every call cut off. */
  readonly usage: TokenUsage
  readonly calls: number
  readonly cutOff: number
  /** The next call's prompt, guessed: the last one's input and output and room for tool results. */
  readonly nextInput: number
}

const NEXT_CALL_SLACK = 4000

const ANTHROPIC_CACHE = { anthropic: { cacheControl: { type: 'ephemeral' } } } as const

export function runModel(o: RunOptions): ModelRun {
  assertModelObject(o.choice.model)
  const caching = o.choice.caps.promptCaching
  const providerOptions: Record<string, Record<string, JSONValue>> = { ...o.choice.providerOptions }
  if (caching) providerOptions['anthropic'] = { ...(providerOptions['anthropic'] ?? {}), cacheControl: { type: 'ephemeral' } }
  const finished: AgentMessage[][] = []
  let aborted = false

  // the meter: every call that started, what it was guessed at, and what the provider counted when it ended
  const open = new Map<string, number>()   // callId -> estimated input tokens
  let counted = NO_USAGE
  let calls = 0
  let last = { input: 0, output: 0 }
  const meter = (): Meter => {
    let usage = counted
    let cutOff = 0
    for (const estimate of open.values()) {
      cutOff++
      usage = addUsage(usage, { inputTokens: estimate, outputTokens: o.limits.maxOutputTokens, cacheReadTokens: 0, cacheWriteTokens: 0 })
    }
    return { usage, calls, cutOff, nextInput: last.input + last.output + NEXT_CALL_SLACK }
  }

  const result = streamText({
    model: o.choice.model,
    instructions: [{ role: 'system', content: o.system, ...(caching ? { providerOptions: ANTHROPIC_CACHE } : {}) }],
    messages: o.messages as unknown as ModelMessage[],
    tools: toolSetOf(o),
    toolChoice: 'auto',
    stopWhen: [
      isStepCount(o.limits.maxSteps),
      ({ steps }) => steps.reduce((n, s) => n + s.toolCalls.length, 0) >= o.limits.maxToolCalls,
      // R10: no next call unless what the turn has cost so far and the next call's worst case still fit the caps
      async () => o.allowNextCall === undefined ? false : !(await o.allowNextCall(meter())),
    ],
    maxOutputTokens: o.limits.maxOutputTokens,
    maxRetries: 1,
    abortSignal: o.abortSignal,
    providerOptions,
    onLanguageModelCallStart: (e) => {
      calls++
      let bytes = 0
      try { bytes = Buffer.byteLength(JSON.stringify({ i: e.instructions, m: e.messages, t: e.tools }), 'utf8') } catch { /* unmeasurable: the last call's input stands */ }
      open.set(e.callId, Math.max(last.input, tokensOfBytes(bytes)))
    },
    onLanguageModelCallEnd: (e) => {
      open.delete(e.callId)
      const u = usageOf(e.usage)
      counted = addUsage(counted, u)
      last = { input: u.inputTokens, output: u.outputTokens }
    },
    onError: ({ error }) => {
      // the library's default prints the error object, whose request body holds the book: one safe line instead
      const e = errorOf(error)
      o.log('assistant model error', e)
      // an HTTP error status: the provider refused the call before generating anything, so it is not billed
      if (e.status !== null) {
        const lastOpen = [...open.keys()].at(-1)
        if (lastOpen !== undefined) open.delete(lastOpen)
      }
    },
    onStepEnd: (step) => { finished.push(step.response.messages as unknown as AgentMessage[]) },
    onAbort: () => { aborted = true },
  })

  async function* parts(): AsyncGenerator<RunPart> {
    for await (const p of result.stream) {
      switch (p.type) {
        case 'start-step': yield { kind: 'step-start' }; break
        case 'reasoning-start': yield { kind: 'reasoning' }; break
        case 'text-delta': if (p.text !== '') yield { kind: 'text', delta: p.text }; break
        case 'tool-call': yield { kind: 'tool-start', id: p.toolCallId, name: p.toolName, input: p.input }; break
        case 'tool-result': {
          if (p.preliminary === true) break
          yield { kind: 'tool-done', id: p.toolCallId, name: p.toolName, input: p.input, exec: p.output as ToolExec }
          break
        }
        case 'tool-error': {
          // the input failed the tool's schema, or the tool is unknown: the library tells the model; the page gets the name only
          yield { kind: 'tool-failed', id: p.toolCallId, name: p.toolName, message: 'the call did not match the tool\'s input' }
          break
        }
        case 'finish-step': yield { kind: 'step-done', finish: p.finishReason }; break
        case 'finish': yield { kind: 'finish', finish: p.finishReason }; break
        case 'error': yield { kind: 'error', ...errorOf(p.error) }; break
        case 'abort': yield { kind: 'abort' }; break
        default: break
      }
    }
  }

  return {
    parts: parts(),
    meter,
    async messages() {
      if (aborted) return finished.flat()
      try {
        return (await result.responseMessages) as unknown as AgentMessage[]
      } catch {
        return finished.flat()
      }
    },
  }
}
