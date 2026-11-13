import Anthropic from '@anthropic-ai/sdk'
import type { BetaMessageStreamParams } from '@anthropic-ai/sdk/resources/beta/messages/messages'
import { HearthError } from '../errors.js'
import { ANTHROPIC_MISSING } from '../org/unconfigured.js'

export type MessageParam = Anthropic.Beta.BetaMessageParam
export type ContentBlockParam = Anthropic.Beta.BetaContentBlockParam

export interface AssistantUsage {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
}

export const NO_USAGE: AssistantUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }

export function addUsage(a: AssistantUsage, b: AssistantUsage): AssistantUsage {
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheWrite: a.cacheWrite + b.cacheWrite,
  }
}

export interface ModelTurnRequest {
  model: string
  system: string
  messages: MessageParam[]
  tools: Anthropic.Beta.BetaTool[]
  signal?: AbortSignal
}

export interface ModelTurn {
  /** The assistant message's blocks, replayed unchanged on the next request (thinking included). */
  content: ContentBlockParam[]
  stopReason: string | null
  usage: AssistantUsage
}

/** One streamed model turn. Text deltas go to `onText` as they arrive. */
export interface AssistantModel {
  turn(req: ModelTurnRequest, onText: (delta: string) => void): Promise<ModelTurn>
}

const MAX_TOKENS = 32_000

/** The slice of the SDK client used here; tests pass a stand-in. */
export interface BetaMessagesClient {
  beta: {
    messages: {
      stream(
        params: BetaMessageStreamParams,
        opts?: { signal?: AbortSignal },
      ): {
        on(event: 'text', listener: (delta: string) => void): unknown
        finalMessage(): Promise<Anthropic.Beta.BetaMessage>
      }
    }
  }
}

/**
 * Claude through the Messages API. Streams, so long answers can't hit the HTTP timeout. The
 * system prompt and tools are a stable prefix, cached; the conversation is cached too (automatic
 * caching on the last block). A refusal falls back to another model on Anthropic's side
 * (`fallbacks: "default"`); a refusal of the whole chain is an `llm_error`.
 */
export class AnthropicAssistantModel implements AssistantModel {
  readonly #client: BetaMessagesClient
  readonly #log: (message: string) => void

  constructor(client: BetaMessagesClient, opts: { log?: (message: string) => void } = {}) {
    this.#client = client
    this.#log = opts.log ?? console.error
  }

  async turn(req: ModelTurnRequest, onText: (delta: string) => void): Promise<ModelTurn> {
    let message: Anthropic.Beta.BetaMessage
    try {
      const stream = this.#client.beta.messages.stream(
        {
          model: req.model,
          max_tokens: MAX_TOKENS,
          betas: ['server-side-fallback-2026-07-01'],
          fallbacks: 'default',
          output_config: { effort: 'medium' },
          cache_control: { type: 'ephemeral' },
          system: [{ type: 'text', text: req.system, cache_control: { type: 'ephemeral' } }],
          tools: req.tools,
          messages: req.messages,
        },
        req.signal ? { signal: req.signal } : {},
      )
      stream.on('text', onText)
      message = await stream.finalMessage()
    } catch (err) {
      if (!(err instanceof Anthropic.APIError)) throw err
      this.#log(`assistant ${req.model} failed: ${err.status ?? 'no status'} ${err.message}`)
      throw new HearthError('llm_error', messageFor(err))
    }
    if (message.stop_reason === 'refusal') {
      this.#log(`assistant ${req.model} declined: ${JSON.stringify(message.stop_details ?? null)}`)
      throw new HearthError('llm_error', 'Claude declined this request')
    }
    const u = message.usage
    return {
      content: message.content as ContentBlockParam[],
      stopReason: message.stop_reason,
      usage: {
        input: u.input_tokens,
        output: u.output_tokens,
        cacheRead: u.cache_read_input_tokens ?? 0,
        cacheWrite: u.cache_creation_input_tokens ?? 0,
      },
    }
  }
}

function messageFor(err: InstanceType<typeof Anthropic.APIError>): string {
  if (err instanceof Anthropic.RateLimitError) return 'Claude is busy right now; try again shortly'
  if (
    err instanceof Anthropic.AuthenticationError ||
    err instanceof Anthropic.PermissionDeniedError
  ) {
    return 'Claude refused the Anthropic API key'
  }
  if (err instanceof Anthropic.APIConnectionError) return "Couldn't reach Claude"
  return `Claude request failed${err.status ? ` (${err.status})` : ''}`
}

/** No Anthropic key yet: every turn says so (Settings → Organization adds one). */
export class UnconfiguredAssistantModel implements AssistantModel {
  async turn(): Promise<never> {
    throw new HearthError('not_configured', ANTHROPIC_MISSING)
  }
}

/**
 * A stand-in for development, tests and the demo. It reads the last user message and does what
 * a real model would do for a few shapes of request, using the real tools:
 * - "add a task <text>" calls add_task;
 * - "delete <space>/<path>" calls delete_file (which waits for Confirm);
 * - anything else calls search with the question, then answers from the results with links.
 */
export class FakeAssistantModel implements AssistantModel {
  async turn(req: ModelTurnRequest, onText: (delta: string) => void): Promise<ModelTurn> {
    const last = req.messages.at(-1)
    const results = toolResultsOf(last)
    const usage = { input: 100, output: 20, cacheRead: 0, cacheWrite: 0 }
    if (results === null) {
      const question = questionOf(last)
      const call = this.#plan(question)
      return {
        content: [{ type: 'tool_use', id: `toolu_fake_${Date.now()}`, ...call }],
        stopReason: 'tool_use',
        usage,
      }
    }
    const text = answerFrom(results)
    for (const word of text.split(/(?<= )/)) onText(word)
    return { content: [{ type: 'text', text }], stopReason: 'end_turn', usage }
  }

  #plan(question: string): { name: string; input: Record<string, unknown> } {
    const task = /^add (?:a )?task:?\s+(.+)$/i.exec(question)
    if (task?.[1]) return { name: 'add_task', input: { text: task[1] } }
    const del = /^delete\s+([^/\s]+)\/(\S+)$/i.exec(question)
    if (del?.[1] && del[2]) return { name: 'delete_file', input: { space: del[1], path: del[2] } }
    // Search ANDs its words, so keep the two longest that aren't filler.
    const words = question
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, ' ')
      .split(/\s+/)
      .filter((w) => w.length > 2 && !FILLER.has(w))
      .sort((a, b) => b.length - a.length)
    return { name: 'search', input: { query: words.slice(0, 2).join(' ') || 'notes', limit: 5 } }
  }
}

const FILLER = new Set(
  'the and for what when where which who why how does did about this that with from your have there into find show tell give me my our'.split(
    ' ',
  ),
)

function toolResultsOf(message: MessageParam | undefined): string[] | null {
  if (!message || typeof message.content === 'string') return null
  const results = message.content.filter((b) => b.type === 'tool_result')
  if (results.length === 0) return null
  return results.map((r) =>
    typeof r.content === 'string'
      ? r.content
      : (r.content ?? []).map((c) => (c.type === 'text' ? c.text : '')).join(''),
  )
}

function questionOf(message: MessageParam | undefined): string {
  if (!message) return ''
  const text =
    typeof message.content === 'string'
      ? message.content
      : message.content.map((b) => (b.type === 'text' ? b.text : '')).join('\n')
  // The agent puts page context before the question; the question is the last paragraph.
  return (text.split(/\n{2,}/).at(-1) ?? '').trim()
}

function answerFrom(results: string[]): string {
  const raw = results[0] ?? ''
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    if (raw.startsWith('Not done yet')) return "I'll do that as soon as you click Confirm above."
    return `That didn't work: ${raw}`
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return "I couldn't find anything about that in your workspace."
    const lines = value.slice(0, 3).map((hit: { space: string; path: string; title?: string }) => {
      return `- [${hit.title || hit.path}](<hearth:${hit.space}/${hit.path}>)`
    })
    return `Here's what I found:\n\n${lines.join('\n')}`
  }
  if (value && typeof value === 'object' && 'title' in value) {
    return `Done: added "${String((value as { title: unknown }).title)}".`
  }
  return 'Done.'
}
